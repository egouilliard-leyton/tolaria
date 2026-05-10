// Round-trip and tamper-detection tests for the AES-256-GCM helper. We do
// NOT exercise the env loader here — `_resetSecretEncryptionForTests` lets us
// set the key once at the top of the suite via process.env.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Set every env var the loader requires before the module under test imports
// `loadEnv()` transitively.
const ORIG_ENV = { ...process.env }
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'b'.repeat(32) // exact 32 bytes utf8
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

describe('secret-encryption', () => {
  it('round-trips a typical OIDC client secret', async () => {
    const mod = await import('../src/services/secret-encryption.js')
    mod._resetSecretEncryptionForTests()
    const plaintext = 'super-secret-value-9f3aef'
    const sealed = mod.encryptToStorage(plaintext)
    expect(sealed).toBeInstanceOf(Buffer)
    // iv (12) + tag (16) + ciphertext (>= 1)
    expect(sealed.length).toBeGreaterThanOrEqual(12 + 16 + plaintext.length)
    expect(mod.decryptFromStorage(sealed)).toBe(plaintext)
  })

  it('produces a different ciphertext for the same plaintext (random IV)', async () => {
    const mod = await import('../src/services/secret-encryption.js')
    mod._resetSecretEncryptionForTests()
    const plaintext = 'abcdef'
    const a = mod.encryptToStorage(plaintext)
    const b = mod.encryptToStorage(plaintext)
    expect(a.equals(b)).toBe(false)
  })

  it('refuses an empty plaintext', async () => {
    const mod = await import('../src/services/secret-encryption.js')
    mod._resetSecretEncryptionForTests()
    expect(() => mod.encryptToStorage('')).toThrow()
  })

  it('detects tampering with the auth tag', async () => {
    const mod = await import('../src/services/secret-encryption.js')
    mod._resetSecretEncryptionForTests()
    const sealed = Buffer.from(mod.encryptToStorage('hello'))
    // Flip a bit inside the auth tag (bytes 12..27).
    sealed[20] = sealed[20]! ^ 0x01
    expect(() => mod.decryptFromStorage(sealed)).toThrow()
  })

  it('detects tampering with the ciphertext', async () => {
    const mod = await import('../src/services/secret-encryption.js')
    mod._resetSecretEncryptionForTests()
    const sealed = Buffer.from(mod.encryptToStorage('hello world'))
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0x01
    expect(() => mod.decryptFromStorage(sealed)).toThrow()
  })

  it('refuses a buffer that is too short to be a sealed payload', async () => {
    const mod = await import('../src/services/secret-encryption.js')
    mod._resetSecretEncryptionForTests()
    expect(() => mod.decryptFromStorage(Buffer.alloc(10))).toThrow()
  })
})
