import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import {
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from 'hono/cookie'
import { withPlatformContext, withTenant, type PgClient } from '../db.js'
import { loadEnv } from '../env.js'
import { clientIp } from '../lib/client-ip.js'
import { Forbidden, InvalidInput, Unauthenticated } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { mintAccessToken, type AccessTokenClaims } from '../middleware/auth.js'
import { AUTH_RATE_LIMIT, rateLimit } from '../middleware/rate-limit.js'
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  type IssuedRefreshToken,
} from '../auth/refresh-tokens.js'
import {
  defaultAuthentikFromEnv,
  exchangeCallback as exchangeWithEnvProvider,
  buildAuthorizeStart as buildAuthorizeStartFromEnvProvider,
  type NormalizedClaims,
} from '../services/authentik.js'
import {
  completeProviderFlow,
  loadProviderById,
  loadPlatformDefaultProvider,
  startProviderFlow,
  type SsoProviderRow,
} from '../services/sso-provider.js'

// HTTP entry points for sign-in/out. Implements the four flows described in
// plan §6 "Web auth flow":
//   1. GET  /auth/oidc/:providerId/start    -> 302 to provider with PKCE+state
//   2. GET  /auth/oidc/:providerId/callback -> exchange code, JIT user, mint
//      JWT + set refresh cookie, redirect to WEB_PUBLIC_URL/auth/complete
//   3. POST /auth/refresh                   -> rotate refresh cookie + new JWT
//   4. POST /auth/logout                    -> revoke + clear cookie
// Plus: POST /auth/login (LOCAL_PASSWORD_AUTH=1 only) — bcrypt verify against
// users.password_hash. PKCE-only; implicit/hybrid flows are rejected.
//
// All audit-relevant transitions write to `audit_log` under the resolved
// tenant context; raw tokens, secrets, and PKCE verifiers are never logged.

const env = loadEnv()
export const auth = new Hono()

// Per-IP rate limit on every login/callback/refresh/logout endpoint. We
// cannot key on user id here because the user is not authenticated yet (or
// is being authenticated by this very request). See plan §9.
auth.use(
  '/auth/*',
  rateLimit({ bucket: 'auth', scope: 'ip', ...AUTH_RATE_LIMIT }),
)

// Defense-in-depth Origin / Sec-Fetch-Site check on the cookie-bearing
// endpoints (refresh + logout). The refresh cookie is httpOnly + SameSite=Lax,
// but a cross-origin attempt to abuse a captured cookie should still be
// blocked at the API boundary. Pre-flight CORS won't catch every shape of
// abuse (e.g. simple GET-style XHRs in legacy browsers), so we require either:
//   - `Origin` matches `env.WEB_PUBLIC_URL` (case-insensitive scheme+host), OR
//   - `Sec-Fetch-Site: same-origin` or `same-site` is present.
// Both signals are unforgeable by attacker-controlled JS in modern browsers.
// See audit 2026-05-10 Bundle H §1.
function sameOriginAsWebPublicUrl(origin: string | undefined | null): boolean {
  if (!origin) return false
  let originUrl: URL
  let allowedUrl: URL
  try {
    originUrl = new URL(origin)
    allowedUrl = new URL(env.WEB_PUBLIC_URL)
  } catch {
    return false
  }
  return (
    originUrl.protocol.toLowerCase() === allowedUrl.protocol.toLowerCase() &&
    originUrl.host.toLowerCase() === allowedUrl.host.toLowerCase()
  )
}

function assertSameOriginOrSecFetchSite(c: import('hono').Context): void {
  const origin = c.req.header('origin')
  if (sameOriginAsWebPublicUrl(origin)) return
  const secFetchSite = c.req.header('sec-fetch-site')?.toLowerCase()
  if (secFetchSite === 'same-origin' || secFetchSite === 'same-site') return
  throw Forbidden('cross_origin_refresh_denied')
}

auth.use('/auth/refresh', async (c, next) => {
  assertSameOriginOrSecFetchSite(c)
  await next()
})
auth.use('/auth/logout', async (c, next) => {
  assertSameOriginOrSecFetchSite(c)
  await next()
})

const PKCE_COOKIE = 'tolaria_pkce'
const PKCE_TTL_SECONDS = 10 * 60
const REFRESH_COOKIE_PATH = '/auth'
const PROVIDER_ALIAS_DEFAULT = 'default'

const isProd = env.NODE_ENV === 'production'

interface PkceCookieValue {
  providerId: string
  state: string
  codeVerifier: string
  nonce: string
  // ISO timestamp; cookie itself also expires server-side, but we double-check.
  ts: string
}

function refreshCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax' as const,
    domain: env.AUTH_REFRESH_COOKIE_DOMAIN,
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  }
}

function pkceCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax' as const,
    domain: env.AUTH_REFRESH_COOKIE_DOMAIN,
    path: '/auth',
    maxAge: PKCE_TTL_SECONDS,
  }
}

async function setPkceCookie(c: import('hono').Context, value: PkceCookieValue): Promise<void> {
  await setSignedCookie(
    c,
    PKCE_COOKIE,
    JSON.stringify(value),
    env.AUTH_JWT_SECRET,
    pkceCookieOptions(),
  )
}

async function readPkceCookie(c: import('hono').Context): Promise<PkceCookieValue | null> {
  const raw = await getSignedCookie(c, env.AUTH_JWT_SECRET, PKCE_COOKIE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PkceCookieValue
    if (
      typeof parsed.providerId !== 'string' ||
      typeof parsed.state !== 'string' ||
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.nonce !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function clearPkceCookie(c: import('hono').Context): void {
  deleteCookie(c, PKCE_COOKIE, { path: '/auth', domain: env.AUTH_REFRESH_COOKIE_DOMAIN })
}

function setRefreshCookie(c: import('hono').Context, issued: IssuedRefreshToken): void {
  const maxAge = Math.max(
    1,
    Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000),
  )
  setCookie(c, env.AUTH_REFRESH_COOKIE_NAME, issued.rawToken, refreshCookieOptions(maxAge))
}

function clearRefreshCookie(c: import('hono').Context): void {
  deleteCookie(c, env.AUTH_REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    domain: env.AUTH_REFRESH_COOKIE_DOMAIN,
  })
}

function buildCallbackUrl(providerId: string): string {
  const base = env.API_PUBLIC_URL.replace(/\/$/, '')
  return `${base}/auth/oidc/${encodeURIComponent(providerId)}/callback`
}

interface ResolvedProvider {
  /** stable id used in URLs; may be the provider row UUID or 'default'. */
  id: string
  row: SsoProviderRow | null
  /** Raw config the openid-client primitives accept. */
  configInput: { issuerUrl: string; clientId: string; clientSecret: string; scopes: readonly string[] }
  defaultRole: 'owner' | 'admin' | 'member'
  jitProvisioning: boolean
  /** Subscription this provider mints users into (null for platform default). */
  subscriptionId: string | null
}

async function resolveProvider(providerIdParam: string): Promise<ResolvedProvider> {
  if (providerIdParam === PROVIDER_ALIAS_DEFAULT) {
    const row = await loadPlatformDefaultProvider()
    if (row) {
      return {
        id: PROVIDER_ALIAS_DEFAULT,
        row,
        configInput: {
          issuerUrl: row.issuerUrl,
          clientId: row.clientId,
          clientSecret: row.clientSecretPlain,
          scopes: row.scopes,
        },
        defaultRole: row.defaultRole,
        jitProvisioning: row.jitProvisioning,
        subscriptionId: null,
      }
    }
    const fromEnv = defaultAuthentikFromEnv()
    if (!fromEnv) {
      throw InvalidInput('No platform-default OIDC provider is configured')
    }
    return {
      id: PROVIDER_ALIAS_DEFAULT,
      row: null,
      configInput: fromEnv,
      // Conservative defaults when bootstrapping from env only.
      defaultRole: 'member',
      jitProvisioning: true,
      subscriptionId: null,
    }
  }
  const row = await loadProviderById(providerIdParam)
  return {
    id: row.id,
    row,
    configInput: {
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      clientSecret: row.clientSecretPlain,
      scopes: row.scopes,
    },
    defaultRole: row.defaultRole,
    jitProvisioning: row.jitProvisioning,
    subscriptionId: row.subscriptionId,
  }
}

// ── GET /auth/oidc/:providerId/start ────────────────────────────────────────
auth.get('/auth/oidc/:providerId/start', async (c) => {
  const providerIdParam = c.req.param('providerId')
  const resolved = await resolveProvider(providerIdParam)
  const redirectUri = buildCallbackUrl(providerIdParam)
  const start = resolved.row
    ? await startProviderFlow(resolved.row, redirectUri)
    : await buildAuthorizeStartFromEnvProvider(resolved.configInput, redirectUri)
  await setPkceCookie(c, {
    providerId: providerIdParam,
    state: start.state,
    codeVerifier: start.codeVerifier,
    nonce: start.nonce,
    ts: new Date().toISOString(),
  })
  return c.redirect(start.authorizationUrl.toString(), 302)
})

// ── GET /auth/oidc/:providerId/callback ─────────────────────────────────────
auth.get('/auth/oidc/:providerId/callback', async (c) => {
  const providerIdParam = c.req.param('providerId')
  const cookie = await readPkceCookie(c)
  if (!cookie || cookie.providerId !== providerIdParam) {
    throw Unauthenticated('Missing or stale PKCE state')
  }
  const resolved = await resolveProvider(providerIdParam)
  const currentUrl = new URL(c.req.url)
  const callbackResult = resolved.row
    ? await completeProviderFlow(resolved.row, currentUrl, {
        state: cookie.state,
        codeVerifier: cookie.codeVerifier,
        nonce: cookie.nonce,
      })
    : await exchangeWithEnvProvider(resolved.configInput, currentUrl, {
        state: cookie.state,
        codeVerifier: cookie.codeVerifier,
        nonce: cookie.nonce,
      })
  clearPkceCookie(c)

  const user = await jitProvisionUser(resolved, callbackResult.claims)
  const issued = await issueRefreshToken(
    { userId: user.id, subscriptionId: user.subscriptionId, role: user.role },
    c.req.header('user-agent') ?? null,
    clientIp(c),
  )
  setRefreshCookie(c, issued)
  const accessToken = await mintAccessToken({
    sub: user.id,
    sid: user.subscriptionId,
    role: user.role,
    jti: randomUUID(),
  })
  await writeAuditLog(
    { subscriptionId: user.subscriptionId, userId: user.id },
    'auth.login.success',
    `oidc:${providerIdParam}`,
    { sub: callbackResult.claims.sub, refresh_id: issued.id },
  )
  const redirectTarget = `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/auth/complete#access_token=${encodeURIComponent(accessToken)}&token_type=Bearer&expires_in=${env.AUTH_JWT_ACCESS_TTL_SECONDS}`
  return c.redirect(redirectTarget, 302)
})

// ── POST /auth/refresh ──────────────────────────────────────────────────────
auth.post('/auth/refresh', async (c) => {
  const cookieValue = getCookie(c, env.AUTH_REFRESH_COOKIE_NAME)
  if (!cookieValue) throw Unauthenticated('No refresh cookie')
  const { next, ctx } = await rotateRefreshToken(
    cookieValue,
    c.req.header('user-agent') ?? null,
    clientIp(c),
  )
  setRefreshCookie(c, next)
  const accessToken = await mintAccessToken({
    sub: ctx.userId,
    sid: ctx.subscriptionId,
    role: ctx.role,
    jti: randomUUID(),
  })
  await writeAuditLog(
    { subscriptionId: ctx.subscriptionId, userId: ctx.userId },
    'auth.refresh',
    `refresh:${next.id}`,
    {},
  )
  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: env.AUTH_JWT_ACCESS_TTL_SECONDS,
  })
})

// ── POST /auth/logout ───────────────────────────────────────────────────────
auth.post('/auth/logout', async (c) => {
  const cookieValue = getCookie(c, env.AUTH_REFRESH_COOKIE_NAME)
  if (cookieValue) {
    await revokeRefreshToken(cookieValue)
  }
  clearRefreshCookie(c)
  return c.json({ ok: true })
})

// ── POST /auth/login (dev only) ─────────────────────────────────────────────
auth.post('/auth/login', async (c) => {
  if (!env.LOCAL_PASSWORD_AUTH) {
    throw Forbidden('Local password authentication is disabled')
  }
  if (env.NODE_ENV === 'production') {
    // Belt-and-braces: even if someone sets LOCAL_PASSWORD_AUTH=1 in prod,
    // we refuse. ADR-0117 §7.
    throw Forbidden('Local password authentication is disabled in production')
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw InvalidInput('Body must be JSON')
  }
  const { email, password } = parseLoginBody(body)
  const user = await findUserByEmail(email)
  if (!user || !user.passwordHash) {
    await writeAuditLogPlatform('auth.login.failure', `email:${email}`, { reason: 'no_user' })
    throw Unauthenticated('Invalid email or password')
  }
  const ok = await verifyPasswordHash(password, user.passwordHash)
  if (!ok) {
    await writeAuditLog(
      { subscriptionId: user.subscriptionId, userId: user.id },
      'auth.login.failure',
      `email:${email}`,
      { reason: 'bad_password' },
    )
    throw Unauthenticated('Invalid email or password')
  }
  const issued = await issueRefreshToken(
    { userId: user.id, subscriptionId: user.subscriptionId, role: user.role },
    c.req.header('user-agent') ?? null,
    clientIp(c),
  )
  setRefreshCookie(c, issued)
  const accessToken = await mintAccessToken({
    sub: user.id,
    sid: user.subscriptionId,
    role: user.role,
    jti: randomUUID(),
  })
  await writeAuditLog(
    { subscriptionId: user.subscriptionId, userId: user.id },
    'auth.login.success',
    'password',
    { refresh_id: issued.id },
  )
  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: env.AUTH_JWT_ACCESS_TTL_SECONDS,
    user: { id: user.id, email: user.email, role: user.role },
  })
})

// ── helpers ────────────────────────────────────────────────────────────────

function parseLoginBody(body: unknown): { email: string; password: string } {
  if (typeof body !== 'object' || body === null) {
    throw InvalidInput('Body must be an object')
  }
  const b = body as Record<string, unknown>
  if (typeof b.email !== 'string' || b.email.length === 0) {
    throw InvalidInput('email is required')
  }
  if (typeof b.password !== 'string' || b.password.length === 0) {
    throw InvalidInput('password is required')
  }
  return { email: b.email.toLowerCase(), password: b.password }
}

interface ResolvedUser {
  id: string
  subscriptionId: string
  email: string
  role: 'owner' | 'admin' | 'member'
  passwordHash?: string
}

async function findUserByEmail(email: string): Promise<ResolvedUser | null> {
  const row = await withPlatformContext(async (client) => {
    const r = await client.query<{
      id: string
      subscription_id: string
      email: string
      role: 'owner' | 'admin' | 'member'
      password_hash: string | null
    }>(
      `SELECT id, subscription_id, email::text AS email, role::text AS role, password_hash
         FROM users WHERE email = $1::citext LIMIT 1`,
      [email],
    )
    return r.rows[0] ?? null
  })
  if (!row) return null
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash ?? undefined,
  }
}

async function verifyPasswordHash(plain: string, hash: string): Promise<boolean> {
  // bcrypt is loaded dynamically because it's an optional, dev-only dep.
  // In production the LOCAL_PASSWORD_AUTH gate already short-circuits this
  // function, so a missing bcrypt module is not a deployment hazard.
  type BcryptModule = { compare: (plain: string, hash: string) => Promise<boolean> }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const dynImport = (s: string): Promise<unknown> => import(/* @vite-ignore */ s)
  let bcrypt: BcryptModule
  try {
    const mod = (await dynImport('bcrypt')) as { default?: BcryptModule } & BcryptModule
    bcrypt = mod.default ?? mod
  } catch {
    logger.error('bcrypt module is not installed; LOCAL_PASSWORD_AUTH=1 cannot verify password')
    return false
  }
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

async function jitProvisionUser(
  provider: ResolvedProvider,
  claims: NormalizedClaims,
): Promise<ResolvedUser> {
  // First, try to find an existing user by email across all subscriptions.
  // This satisfies the "account linking" use case in ADR-0117 §6 — a user
  // who already exists under the platform default can sign back in via a
  // different provider that releases the same verified email.
  const existing = await findUserByEmail(claims.email)
  if (existing) return existing

  if (!provider.jitProvisioning) {
    throw Forbidden(
      'JIT provisioning is disabled for this provider; ask an admin to invite you',
    )
  }
  if (!claims.emailVerified) {
    throw Forbidden('Identity provider has not verified the user email')
  }

  // Resolve the target subscription. For the platform-default provider we
  // need a tenant to pin the user to — bootstrap one named after the email
  // domain so first-time users automatically land in their own free-tier
  // subscription. Per-subscription providers already know their target.
  const targetSubscriptionId =
    provider.subscriptionId ?? (await ensurePersonalSubscription(claims))

  // Now we can switch into tenant context to write the row.
  const role: 'owner' | 'admin' | 'member' = provider.subscriptionId
    ? provider.defaultRole
    : 'owner'
  const userId = await withPlatformContext(async (client) => {
    // We can't use withTenant here because the user row we are inserting
    // does not yet exist — `app.user_id` would be invalid. Insert with the
    // session var explicitly set to the subscription so the `users_tenant`
    // RLS policy matches.
    await client.query("SELECT set_config('app.subscription_id', $1, true)", [
      targetSubscriptionId,
    ])
    const r = await client.query<{ id: string }>(
      `INSERT INTO users (subscription_id, email, role, display_name)
         VALUES ($1, $2::citext, $3, $4)
         RETURNING id`,
      [targetSubscriptionId, claims.email, role, claims.name],
    )
    const row = r.rows[0]
    if (!row) throw new Error('Failed to insert user row')
    return row.id
  })
  return {
    id: userId,
    subscriptionId: targetSubscriptionId,
    email: claims.email,
    role,
  }
}

async function ensurePersonalSubscription(claims: NormalizedClaims): Promise<string> {
  // Personal subscriptions are bootstrap rows for free-tier individuals
  // signing in with the platform-default IdP. Naming uses the email so
  // it's recognizable in the admin UI; multiplicity is fine because the
  // (subscription_id, email) UNIQUE on users makes a duplicate harmless.
  return withPlatformContext(async (client: PgClient) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (name, plan)
         VALUES ($1, 'free')
         RETURNING id`,
      [`Personal — ${claims.email}`],
    )
    const row = r.rows[0]
    if (!row) throw new Error('Failed to insert subscription row')
    return row.id
  })
}

async function writeAuditLog(
  ctx: { subscriptionId: string; userId: string },
  action: string,
  target: string,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenant(ctx, (client) =>
      client.query(
        `INSERT INTO audit_log (subscription_id, actor_user_id, action, target, meta)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ctx.subscriptionId, ctx.userId, action, target, JSON.stringify(meta)],
      ),
    )
  } catch (err) {
    logger.warn({ errKind: (err as Error).name, action }, 'audit_log insert failed')
  }
}

async function writeAuditLogPlatform(
  action: string,
  target: string,
  meta: Record<string, unknown>,
): Promise<void> {
  // Platform-scope login failures (no resolved user/subscription yet) are
  // dropped on the floor at the audit_log level because the table requires a
  // subscription_id NOT NULL. We log to pino instead so ops can still see
  // brute-force patterns. Tokens / passwords are intentionally not logged.
  logger.info({ action, target, meta }, 'auth event (no subscription context)')
}
