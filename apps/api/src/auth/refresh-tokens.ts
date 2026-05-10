import { createHash, randomBytes } from 'node:crypto'
import { withPlatformContext, withTenant, type PgClient } from '../db.js'
import { loadEnv } from '../env.js'
import { Unauthenticated } from '../lib/errors.js'

// Opaque refresh-token store. The cookie carries an opaque base64url string
// that contains the row id and the raw token, separated by a dot. Only the
// SHA-256 of the raw half is persisted in `refresh_tokens.hashed_token` —
// the database never sees the secret. Rotation is one-shot: every successful
// rotate revokes the prior row and issues a brand new one, so a stolen cookie
// is detected the next time the legitimate owner refreshes (the second
// rotation will hit a row already marked revoked).

const env = loadEnv()
const TOKEN_BYTES = 32      // 256 bits of entropy in the raw half.

export interface RefreshTokenContext {
  userId: string
  subscriptionId: string
  role: 'owner' | 'admin' | 'member'
}

export interface IssuedRefreshToken {
  /** Cookie value: `<rowId>.<rawTokenBase64Url>`. */
  rawToken: string
  /** When the cookie should expire — used by the route layer to set Max-Age. */
  expiresAt: Date
  /** UUID of the underlying refresh_tokens row; useful for audit logging. */
  id: string
}

interface RefreshRow {
  id: string
  user_id: string
  subscription_id: string
  hashed_token: string
  expires_at: Date
  revoked_at: Date | null
}

interface RefreshRowWithRole extends RefreshRow {
  role: 'owner' | 'admin' | 'member'
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function newRawTokenBytes(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function pack(rowId: string, raw: string): string {
  return `${rowId}.${raw}`
}

function unpack(cookie: string): { rowId: string; raw: string } | null {
  const dot = cookie.indexOf('.')
  if (dot < 1 || dot >= cookie.length - 1) return null
  return { rowId: cookie.slice(0, dot), raw: cookie.slice(dot + 1) }
}

/**
 * Issue a fresh refresh token for the user. The raw secret is returned to
 * the caller (route layer) so it can be put into the httpOnly cookie; only
 * the hash is stored.
 */
export async function issueRefreshToken(
  ctx: RefreshTokenContext,
  userAgent: string | null,
  ip: string | null,
): Promise<IssuedRefreshToken> {
  const raw = newRawTokenBytes()
  const hashed = sha256Hex(raw)
  const expiresAt = new Date(Date.now() + env.AUTH_JWT_REFRESH_TTL_SECONDS * 1000)
  const id = await withTenant(
    { subscriptionId: ctx.subscriptionId, userId: ctx.userId },
    async (client: PgClient) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO refresh_tokens
           (user_id, subscription_id, hashed_token, user_agent, ip, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          ctx.userId,
          ctx.subscriptionId,
          hashed,
          userAgent ?? null,
          ip ?? null,
          expiresAt,
        ],
      )
      const row = r.rows[0]
      if (!row) throw new Error('Failed to insert refresh token row')
      return row.id
    },
  )
  return { rawToken: pack(id, raw), expiresAt, id }
}

/**
 * Look up + verify a refresh token cookie value WITHOUT mutating it.
 * Returns the owning user/subscription/role so the caller can decide what
 * to do (e.g. the /me probe doesn't need rotation).
 */
export async function verifyRefreshToken(
  cookieValue: string,
): Promise<RefreshTokenContext & { rowId: string }> {
  const parts = unpack(cookieValue)
  if (!parts) throw Unauthenticated('Malformed refresh token')
  const hashed = sha256Hex(parts.raw)
  // Cross-tenant lookup by primary key + hash. The row is RLS-protected, so
  // we use the platform context to do the read: this is safe because the
  // hash itself is a 256-bit secret — knowing the row id alone is not
  // enough.
  const row = await withPlatformContext(async (client) => {
    const r = await client.query<RefreshRowWithRole>(
      `SELECT rt.id, rt.user_id, rt.subscription_id, rt.hashed_token,
              rt.expires_at, rt.revoked_at, u.role::text AS role
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.id = $1 AND rt.hashed_token = $2`,
      [parts.rowId, hashed],
    )
    return r.rows[0] ?? null
  })
  if (!row) throw Unauthenticated('Refresh token not found')
  if (row.revoked_at) throw Unauthenticated('Refresh token revoked')
  if (row.expires_at.getTime() <= Date.now()) {
    throw Unauthenticated('Refresh token expired')
  }
  return {
    rowId: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    role: row.role,
  }
}

/**
 * Atomically swap the supplied refresh token for a new one. Returns the new
 * raw cookie value plus the resolved tenant context so the caller can mint
 * a fresh access JWT.
 *
 * Single-use semantics: if the row is already revoked or expired, the call
 * fails — the caller should treat this as a forced sign-out.
 */
export async function rotateRefreshToken(
  cookieValue: string,
  userAgent: string | null,
  ip: string | null,
): Promise<{ next: IssuedRefreshToken; ctx: RefreshTokenContext }> {
  const parts = unpack(cookieValue)
  if (!parts) throw Unauthenticated('Malformed refresh token')
  const hashed = sha256Hex(parts.raw)
  const newRaw = newRawTokenBytes()
  const newHashed = sha256Hex(newRaw)
  const expiresAt = new Date(Date.now() + env.AUTH_JWT_REFRESH_TTL_SECONDS * 1000)

  const result = await withPlatformContext(async (client) => {
    // Mark the old row revoked; only succeed if it was still live.
    const revoked = await client.query<RefreshRowWithRole>(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE id = $1
          AND hashed_token = $2
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING id, user_id, subscription_id, hashed_token, expires_at,
                  revoked_at,
                  (SELECT role::text FROM users WHERE users.id = refresh_tokens.user_id) AS role`,
      [parts.rowId, hashed],
    )
    const old = revoked.rows[0]
    if (!old) return null
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO refresh_tokens
         (user_id, subscription_id, hashed_token, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        old.user_id,
        old.subscription_id,
        newHashed,
        userAgent ?? null,
        ip ?? null,
        expiresAt,
      ],
    )
    const row = inserted.rows[0]
    if (!row) throw new Error('Failed to insert rotated refresh token')
    return {
      newRowId: row.id,
      userId: old.user_id,
      subscriptionId: old.subscription_id,
      role: old.role,
    }
  })

  if (!result) throw Unauthenticated('Refresh token cannot be rotated')

  return {
    next: { rawToken: pack(result.newRowId, newRaw), expiresAt, id: result.newRowId },
    ctx: {
      userId: result.userId,
      subscriptionId: result.subscriptionId,
      role: result.role,
    },
  }
}

/**
 * Revoke a refresh token. Idempotent — silently no-ops if the row is gone or
 * already revoked; we do not want logout to leak whether a token exists.
 */
export async function revokeRefreshToken(cookieValue: string): Promise<void> {
  const parts = unpack(cookieValue)
  if (!parts) return
  const hashed = sha256Hex(parts.raw)
  await withPlatformContext(async (client) => {
    await client.query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE id = $1 AND hashed_token = $2 AND revoked_at IS NULL`,
      [parts.rowId, hashed],
    )
  })
}

// Auth flow note: this module backs steps 2–4 of the web auth flow in plan
// §6. After OIDC callback (`routes/auth.ts`), `issueRefreshToken` writes the
// row and the route puts the raw value in an httpOnly cookie. `POST /auth/
// refresh` calls `rotateRefreshToken` to swap one-for-one. `POST /auth/
// logout` calls `revokeRefreshToken`. All paths use `withPlatformContext`
// because the cookie identifies the tenant — we cannot set tenant context
// before reading the row.
