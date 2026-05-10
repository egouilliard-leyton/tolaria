import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { loadEnv } from '../env.js'

// AES-256-GCM helpers for at-rest encryption of sensitive provider material —
// most importantly `sso_providers.client_secret_enc`, the upstream OIDC
// client secret used by `services/sso-provider.ts` and `services/authentik.ts`
// when starting an Authorization Code + PKCE flow on the user's behalf.
// Keyed off `AUTH_PROVIDER_SECRET_KEY` (validated by `env.ts` to be exactly
// 32 bytes for AES-256). The raw secret never leaves the API process; the
// stored ciphertext is `<iv:12><authTag:16><ciphertext>` so a single bytea
// column round-trips losslessly through pg.

const IV_LEN = 12   // 96-bit IV is the GCM SP 800-38D recommended size.
const TAG_LEN = 16  // 128-bit auth tag.
const ALG = 'aes-256-gcm' as const

let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const env = loadEnv()
  const raw = env.AUTH_PROVIDER_SECRET_KEY
  // The env validator guarantees min 32 chars. We accept either a raw 32-byte
  // string or a base64/hex-encoded 32-byte secret. We pick the first 32 bytes
  // of the utf8 representation for parity with how the value is documented in
  // .env.example ("change-me-…-32-bytes"). This keeps developer ergonomics
  // sane without weakening production keys, which should be high-entropy
  // 32-byte secrets generated via `openssl rand -hex 32`.
  const buf = Buffer.from(raw, 'utf8')
  if (buf.length < 32) {
    throw new Error('AUTH_PROVIDER_SECRET_KEY must be at least 32 bytes for AES-256-GCM')
  }
  cachedKey = buf.subarray(0, 32)
  return cachedKey
}

/**
 * Encrypts `plain` for storage. Output layout:
 *   [ iv (12 bytes) | authTag (16 bytes) | ciphertext (len(plain)) ]
 */
export function encryptForStorage(plain: string): Buffer {
  if (typeof plain !== 'string') {
    throw new TypeError('encryptForStorage expects a string')
  }
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, getKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

/**
 * Decrypts a buffer produced by `encryptForStorage`. Throws if the buffer is
 * truncated or the auth tag fails to verify (tampered ciphertext / wrong key).
 */
export function decryptFromStorage(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('decryptFromStorage expects a Buffer')
  }
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Ciphertext is too short to contain iv + authTag')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/**
 * Test-only: drop the cached key so a test that mutates the env is honored.
 * Production code must not call this.
 */
export function _resetCryptoKeyForTests(): void {
  cachedKey = null
}

// Auth flow note: the platform-default Authentik provider row and any
// per-subscription rows store their client secret as `client_secret_enc`
// (bytea). When `services/sso-provider.ts` needs to start a flow, it pulls
// the row, calls `decryptFromStorage(row.client_secret_enc)`, and hands the
// plaintext to `openid-client`'s `Configuration` constructor. The plaintext
// never leaves the API process and is never logged — see `lib/logger.ts`.
