// AES-256-GCM helpers for encrypting per-subscription OIDC client secrets at
// rest. The key is loaded from `AUTH_PROVIDER_SECRET_KEY` (32 bytes) and the
// envelope format is `iv (12 bytes) || tag (16 bytes) || ciphertext`. See
// ADR-0117 §"Provider client secrets".
//
// NOTE: agent A may also land a `lib/crypto.ts` after merge. The orchestrator
// is responsible for de-duplicating the two. Keep this module's surface
// narrow — only the two helpers below — so deduping is a mechanical edit.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { loadEnv } from '../env.js'

const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const ALGORITHM = 'aes-256-gcm'

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = loadEnv().AUTH_PROVIDER_SECRET_KEY
  // Accept either 32 raw bytes (utf8 length) or a base64 string that decodes
  // to 32 bytes. The env validator only enforces a 32-character minimum, so
  // we normalize here.
  const utf8 = Buffer.from(raw, 'utf8')
  if (utf8.length === KEY_LENGTH) {
    cachedKey = utf8
    return cachedKey
  }
  const b64 = tryBase64(raw)
  if (b64 && b64.length === KEY_LENGTH) {
    cachedKey = b64
    return cachedKey
  }
  throw new Error(
    `AUTH_PROVIDER_SECRET_KEY must be 32 bytes (got ${utf8.length} utf8 bytes${
      b64 ? `, ${b64.length} base64 bytes` : ''
    })`,
  )
}

function tryBase64(value: string): Buffer | null {
  try {
    return Buffer.from(value, 'base64')
  } catch {
    return null
  }
}

/**
 * Encrypt a UTF-8 plaintext for storage in `sso_providers.client_secret_enc`.
 * Output layout: `iv (12) || tag (16) || ciphertext (n)`.
 */
export function encryptToStorage(plaintext: string): Buffer {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptToStorage: plaintext must be a non-empty string')
  }
  const key = loadKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

/**
 * Decrypt a buffer produced by {@link encryptToStorage}. Throws if the buffer
 * is shorter than the iv+tag prefix or if the auth tag does not validate.
 */
export function decryptFromStorage(buf: Buffer): string {
  if (!Buffer.isBuffer(buf) || buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('decryptFromStorage: buffer is too short to contain a sealed payload')
  }
  const key = loadKey()
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString('utf8')
}

/**
 * Test-only: drop the cached key so a test that swaps the env can rebuild it.
 * Production code must not call this.
 */
export function _resetSecretEncryptionForTests(): void {
  cachedKey = null
}
