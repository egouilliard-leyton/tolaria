// Pure unit tests for the R2 key builder + filename sanitizer.
// No AWS calls, no env dependency — buildKey() is deterministic given UUIDs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ORIG_ENV = { ...process.env }
beforeAll(() => {
  // buildKey doesn't actually load env, but importing the module touches the
  // file and we keep the env scaffolding parallel to the other test files
  // so tests work regardless of vitest isolation settings.
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'b'.repeat(32)
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

const SUB = '11111111-1111-1111-1111-111111111111'
const VAULT = '22222222-2222-2222-2222-222222222222'
const ATTACH = '33333333-3333-3333-3333-333333333333'

describe('buildKey', () => {
  it('produces the documented bucket layout', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    const key = buildKey({
      subscriptionId: SUB,
      vaultId: VAULT,
      attachmentId: ATTACH,
      filename: 'photo.png',
    })
    expect(key).toBe(`s/${SUB}/v/${VAULT}/a/${ATTACH}/photo.png`)
  })

  it('strips path separators from the filename', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    const key = buildKey({
      subscriptionId: SUB,
      vaultId: VAULT,
      attachmentId: ATTACH,
      filename: '../../etc/passwd',
    })
    // Last path segment, sanitized — no slashes, no dot-dots.
    expect(key.endsWith('/passwd')).toBe(true)
    expect(key).not.toContain('..')
    // And the prefix is still well-formed.
    expect(key.startsWith(`s/${SUB}/v/${VAULT}/a/${ATTACH}/`)).toBe(true)
  })

  it('replaces unsafe characters with underscore', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    const key = buildKey({
      subscriptionId: SUB,
      vaultId: VAULT,
      attachmentId: ATTACH,
      filename: 'my photo (1) @home!.png',
    })
    const tail = key.split('/').pop() as string
    // Only A-Z a-z 0-9 . _ - allowed; everything else collapsed.
    expect(tail).toMatch(/^[A-Za-z0-9._-]+$/)
    // Extension preserved.
    expect(tail.endsWith('.png')).toBe(true)
  })

  it('clips overlong filenames', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    const long = 'a'.repeat(5000) + '.png'
    const key = buildKey({
      subscriptionId: SUB,
      vaultId: VAULT,
      attachmentId: ATTACH,
      filename: long,
    })
    const tail = key.split('/').pop() as string
    expect(tail.length).toBeLessThanOrEqual(200)
  })

  it('falls back to "file" for empty / dot-only filenames', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    for (const f of ['', '.', '..', '   ']) {
      const key = buildKey({
        subscriptionId: SUB,
        vaultId: VAULT,
        attachmentId: ATTACH,
        filename: f,
      })
      expect(key.endsWith('/file')).toBe(true)
    }
  })

  it('rejects non-UUID identifiers', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    expect(() =>
      buildKey({
        subscriptionId: 'not-a-uuid',
        vaultId: VAULT,
        attachmentId: ATTACH,
        filename: 'x.png',
      }),
    ).toThrow(/subscriptionId/)
    expect(() =>
      buildKey({
        subscriptionId: SUB,
        vaultId: 'short',
        attachmentId: ATTACH,
        filename: 'x.png',
      }),
    ).toThrow(/vaultId/)
    expect(() =>
      buildKey({
        subscriptionId: SUB,
        vaultId: VAULT,
        attachmentId: '',
        filename: 'x.png',
      }),
    ).toThrow(/attachmentId/)
  })

  it('is deterministic for identical inputs', async () => {
    const { buildKey } = await import('../src/services/r2.js')
    const a = buildKey({
      subscriptionId: SUB,
      vaultId: VAULT,
      attachmentId: ATTACH,
      filename: 'photo.png',
    })
    const b = buildKey({
      subscriptionId: SUB,
      vaultId: VAULT,
      attachmentId: ATTACH,
      filename: 'photo.png',
    })
    expect(a).toBe(b)
  })
})
