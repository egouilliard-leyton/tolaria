// Idempotent seeder for the platform-default Authentik SSO provider row.
//
// `db/migrations/0001_init.sql` creates the `sso_providers` table and a partial
// UNIQUE index that allows exactly one row with `subscription_id IS NULL` —
// the platform-default OIDC provider every tenant inherits unless they
// register their own. The migration itself does NOT insert that row because
// the real values are environment-specific (issuer URL, client id, client
// secret) and must be read from the host's process env at deploy time.
//
// This script bridges that gap. It:
//
//   1. Reads AUTHENTIK_ISSUER_URL / AUTHENTIK_CLIENT_ID /
//      AUTHENTIK_CLIENT_SECRET / AUTHENTIK_DEFAULT_SCOPES from `process.env`
//      via the same Zod schema the running API uses (`apps/api/src/env.ts`).
//   2. Encrypts the client secret with `encryptForStorage()` so the value
//      stored in `client_secret_enc` matches the rest of the AES-256-GCM
//      ciphertexts emitted by the running server.
//   3. INSERTs a `sso_providers` row with `subscription_id = NULL`, or
//      UPDATEs the existing platform-default row when one is already
//      present and any of {name, issuer_url, client_id, secret, scopes,
//      default_role, jit_provisioning} differ from the env-derived values.
//   4. Skips the UPDATE entirely when the existing row already matches —
//      re-running is a no-op and never rotates the secret unnecessarily.
//
// Wire as `pnpm db:seed-platform` (root package.json). Safe to run multiple
// times; safe to run from CI before the first API boot.
//
// Connection: prefers `DATABASE_MIGRATOR_URL` (DDL-capable role) but falls
// back to `DATABASE_URL` so a dev who only has the app role configured can
// still seed locally. The INSERT/UPDATE on `sso_providers` does not require
// DDL privileges.

import pg from 'pg'
import { encryptForStorage, decryptFromStorage } from '../src/lib/crypto.js'
import { loadEnv } from '../src/env.js'

interface ExistingRow {
  id: string
  name: string
  issuer_url: string
  client_id: string
  client_secret_enc: Buffer
  scopes: string[]
  default_role: string
  jit_provisioning: boolean
}

async function main(): Promise<void> {
  const env = loadEnv()

  // The three Authentik fields are optional in env.ts so the API can boot
  // without an OIDC default (e.g. unit tests, LOCAL_PASSWORD_AUTH-only
  // environments). The seeder, however, requires all three.
  const issuerUrl = env.AUTHENTIK_ISSUER_URL
  const clientId = env.AUTHENTIK_CLIENT_ID
  const clientSecret = env.AUTHENTIK_CLIENT_SECRET
  if (!issuerUrl || !clientId || !clientSecret) {
    console.error(
      'AUTHENTIK_ISSUER_URL, AUTHENTIK_CLIENT_ID, and AUTHENTIK_CLIENT_SECRET must all be set to seed the platform-default provider.',
    )
    process.exit(1)
  }

  const scopes = env.AUTHENTIK_DEFAULT_SCOPES
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const desired = {
    name: 'Authentik (platform default)',
    issuer_url: issuerUrl,
    client_id: clientId,
    client_secret_plain: clientSecret,
    scopes: scopes.length > 0 ? scopes : ['openid', 'profile', 'email'],
    default_role: 'member',
    jit_provisioning: true,
  }

  const connectionString = env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL
  const client = new pg.Client({ connectionString })
  await client.connect()

  try {
    const existing = await client.query<ExistingRow>(
      `SELECT id, name, issuer_url, client_id, client_secret_enc,
              scopes, default_role, jit_provisioning
         FROM sso_providers
        WHERE subscription_id IS NULL
        LIMIT 1`,
    )

    if (existing.rowCount === 0) {
      const encrypted = encryptForStorage(desired.client_secret_plain)
      await client.query(
        `INSERT INTO sso_providers
           (subscription_id, name, protocol, issuer_url, client_id,
            client_secret_enc, scopes, default_role, jit_provisioning)
         VALUES (NULL, $1, 'oidc', $2, $3, $4, $5, $6, $7)`,
        [
          desired.name,
          desired.issuer_url,
          desired.client_id,
          encrypted,
          desired.scopes,
          desired.default_role,
          desired.jit_provisioning,
        ],
      )
      console.log(
        `inserted platform-default sso_providers row (issuer=${desired.issuer_url}, client_id=${desired.client_id})`,
      )
      return
    }

    const row = existing.rows[0]
    if (!row) throw new Error('unreachable: existing.rowCount > 0 but no row returned')

    const secretMatches = (() => {
      try {
        return decryptFromStorage(row.client_secret_enc) === desired.client_secret_plain
      } catch {
        // Stored ciphertext can't be decrypted with the current key; force a
        // rotation rather than leaving the row in an unusable state.
        return false
      }
    })()

    const scopesMatch =
      row.scopes.length === desired.scopes.length &&
      row.scopes.every((s, i) => s === desired.scopes[i])

    const allMatch =
      row.name === desired.name &&
      row.issuer_url === desired.issuer_url &&
      row.client_id === desired.client_id &&
      secretMatches &&
      scopesMatch &&
      row.default_role === desired.default_role &&
      row.jit_provisioning === desired.jit_provisioning

    if (allMatch) {
      console.log('platform-default sso_providers row already matches env; no changes')
      return
    }

    const encrypted = encryptForStorage(desired.client_secret_plain)
    await client.query(
      `UPDATE sso_providers
          SET name = $1,
              issuer_url = $2,
              client_id = $3,
              client_secret_enc = $4,
              scopes = $5,
              default_role = $6,
              jit_provisioning = $7
        WHERE subscription_id IS NULL`,
      [
        desired.name,
        desired.issuer_url,
        desired.client_id,
        encrypted,
        desired.scopes,
        desired.default_role,
        desired.jit_provisioning,
      ],
    )
    console.log(
      `updated platform-default sso_providers row (issuer=${desired.issuer_url}, client_id=${desired.client_id})`,
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
