// Round-trip and tamper-detection tests for the AES-256-GCM helper used to
// encrypt sso_providers.client_secret_enc at rest. Mirrors the production
// envelope: `iv (12) || tag (16) || ciphertext`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'k'.repeat(32) // exact 32 bytes utf8
  process.env.R2_ENDPOINT = 'http://localhost:9000'
  process.env.R2_ACCOUNT_ID = 'x'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  process.env.R2_BUCKET = 'x'
  process.env.LITELLM_BASE_URL = 'http://localhost:4000'
  process.env.LITELLM_TOKEN = 'x'
})
afterAll(() => {
  process.env = { ...ORIG_ENV }
})

describe('lib/crypto', () => {
  it('round-trips a UTF-8 plaintext', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    const plaintext = 'super-secret-9f3aef-üñîçødé'
    const sealed = mod.encryptForStorage(plaintext)
    expect(sealed).toBeInstanceOf(Buffer)
    // iv (12) + tag (16) + ciphertext (>= utf8.length)
    expect(sealed.length).toBeGreaterThanOrEqual(12 + 16 + 1)
    expect(mod.decryptFromStorage(sealed)).toBe(plaintext)
  })

  it('produces a different ciphertext for the same plaintext (random IV)', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    const plaintext = 'abcdef'
    const a = mod.encryptForStorage(plaintext)
    const b = mod.encryptForStorage(plaintext)
    expect(a.equals(b)).toBe(false)
  })

  it('rejects a non-string input to encryptForStorage', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    expect(() => (mod.encryptForStorage as unknown as (x: unknown) => Buffer)(123)).toThrow()
  })

  it('rejects a non-Buffer input to decryptFromStorage', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    expect(() => (mod.decryptFromStorage as unknown as (x: unknown) => string)('not-a-buffer')).toThrow()
  })

  it('detects tampering with the auth tag', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    const sealed = Buffer.from(mod.encryptForStorage('hello'))
    // Flip a bit inside the auth tag (bytes 12..27).
    sealed[20] = (sealed[20] ?? 0) ^ 0x01
    expect(() => mod.decryptFromStorage(sealed)).toThrow()
  })

  it('detects tampering with the ciphertext', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    const sealed = Buffer.from(mod.encryptForStorage('hello world'))
    const last = sealed.length - 1
    sealed[last] = (sealed[last] ?? 0) ^ 0x01
    expect(() => mod.decryptFromStorage(sealed)).toThrow()
  })

  it('rejects a buffer too short to be a sealed envelope', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    expect(() => mod.decryptFromStorage(Buffer.alloc(10))).toThrow()
  })

  it('handles an empty-string plaintext (length 0 ciphertext)', async () => {
    const mod = await import('../src/lib/crypto.js')
    mod._resetCryptoKeyForTests()
    const sealed = mod.encryptForStorage('')
    // No bytes of ciphertext, but iv + tag are present.
    expect(sealed.length).toBe(12 + 16)
    expect(mod.decryptFromStorage(sealed)).toBe('')
  })
})
