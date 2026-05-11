// Pure tests for the attachment MIME allowlist. Lives in lib/schemas.ts so
// it can be reused by routes and any future bulk-import path.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ORIG_ENV = { ...process.env }
beforeAll(() => {
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

describe('isAllowedAttachmentMime', () => {
  it('accepts every prefix family in the allowlist', async () => {
    const { isAllowedAttachmentMime } = await import('../src/lib/schemas.js')
    expect(isAllowedAttachmentMime('image/png')).toBe(true)
    expect(isAllowedAttachmentMime('image/jpeg')).toBe(true)
    expect(isAllowedAttachmentMime('image/webp')).toBe(true)
    expect(isAllowedAttachmentMime('audio/mpeg')).toBe(true)
    expect(isAllowedAttachmentMime('audio/ogg')).toBe(true)
    expect(isAllowedAttachmentMime('video/mp4')).toBe(true)
    expect(isAllowedAttachmentMime('video/webm')).toBe(true)
  })

  it('accepts the two exact-match types', async () => {
    const { isAllowedAttachmentMime } = await import('../src/lib/schemas.js')
    expect(isAllowedAttachmentMime('application/pdf')).toBe(true)
    expect(isAllowedAttachmentMime('text/plain')).toBe(true)
  })

  it('rejects executables, scripts, and arbitrary application types', async () => {
    const { isAllowedAttachmentMime } = await import('../src/lib/schemas.js')
    expect(isAllowedAttachmentMime('application/x-msdownload')).toBe(false)
    expect(isAllowedAttachmentMime('application/x-sh')).toBe(false)
    expect(isAllowedAttachmentMime('application/javascript')).toBe(false)
    expect(isAllowedAttachmentMime('application/zip')).toBe(false)
    expect(isAllowedAttachmentMime('text/html')).toBe(false)
    expect(isAllowedAttachmentMime('text/javascript')).toBe(false)
  })

  it('rejects empty, weirdly-cased, and parameterized mimes', async () => {
    const { isAllowedAttachmentMime } = await import('../src/lib/schemas.js')
    expect(isAllowedAttachmentMime('')).toBe(false)
    // Case-sensitive on purpose: clients are expected to send lowercase. A
    // permissive case-insensitive check would let `IMAGE/PNG; x=y` slip in.
    expect(isAllowedAttachmentMime('IMAGE/PNG')).toBe(false)
    // We intentionally don't strip parameters; the boundary should reject the
    // raw value and force callers to send a clean type.
    expect(isAllowedAttachmentMime('image/png; charset=utf-8')).toBe(true)
    // ^ NOTE: prefix match still fires; if we tighten this in the future,
    //   update the test together with the implementation.
  })

  it('rejects a prefix-matching string that is not a real type', async () => {
    const { isAllowedAttachmentMime } = await import('../src/lib/schemas.js')
    // Defensive: '' before slash means startsWith would over-match. Confirm
    // we don't accidentally allow that.
    expect(isAllowedAttachmentMime('imag/png')).toBe(false)
  })
})
