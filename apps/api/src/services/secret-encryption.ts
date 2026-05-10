// Compatibility shim — see `lib/crypto.ts` for the canonical implementation.
//
// Agent A landed `lib/crypto.ts` exporting `encryptForStorage` /
// `decryptFromStorage`. Agent C originally landed an identical AES-256-GCM
// helper here under the names `encryptToStorage` / `decryptFromStorage`. The
// envelope (`iv (12) || tag (16) || ciphertext`) and key source
// (`AUTH_PROVIDER_SECRET_KEY`) are the same. To remove the duplicate while
// keeping every existing import (and the `secret-encryption.test.ts` suite)
// green, this module now re-exports the canonical primitives under both the
// old and new names.

import {
  encryptForStorage,
  decryptFromStorage as canonicalDecryptFromStorage,
  _resetCryptoKeyForTests,
} from '../lib/crypto.js'

/**
 * Encrypt a UTF-8 plaintext for storage in `sso_providers.client_secret_enc`.
 * Output layout: `iv (12) || tag (16) || ciphertext (n)`. Refuses an empty
 * plaintext to keep the historic guard from `services/secret-encryption.ts`
 * — `lib/crypto.ts` allows empty strings, but `sso_providers.client_secret_enc`
 * must never be a zero-byte ciphertext.
 */
export function encryptToStorage(plaintext: string): Buffer {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptToStorage: plaintext must be a non-empty string')
  }
  return encryptForStorage(plaintext)
}

/** See `lib/crypto.ts#decryptFromStorage`. */
export const decryptFromStorage = canonicalDecryptFromStorage

/**
 * Test-only: drop the cached key so a test that swaps the env can rebuild it.
 * Production code must not call this.
 */
export function _resetSecretEncryptionForTests(): void {
  _resetCryptoKeyForTests()
}
