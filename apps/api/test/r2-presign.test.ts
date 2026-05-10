// Unit tests for `apps/api/src/services/r2.ts` presigners and head/delete
// helpers.
//
// Presigning is a pure local-crypto operation — `getSignedUrl` does not
// contact R2 — so we can call `presignPut`/`presignGet` against a real
// S3Client wired to the test env and inspect the resulting URL + headers
// without mocking the SDK transport.
//
// For `headObject` and `deleteObject` we stub `S3Client.prototype.send` so
// each test can return its own command outcome (success, NotFound, generic
// failure).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'

const KEY = 's/sub/v/v/a/att/file.png'
const SHA = 'a'.repeat(64)

beforeEach(() => {
  // Each test re-imports the module so the cached S3Client is rebuilt
  // from the latest env (and the previous test's stub doesn't leak).
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('presignPut', () => {
  it('signs a PUT URL bound to the bucket/key with the requested TTL', async () => {
    process.env.R2_PRESIGN_PUT_TTL_SECONDS = '120'
    const { presignPut, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    const out = await presignPut(KEY, 'image/png', 1024, SHA)
    expect(out.expiresIn).toBe(120)
    // The URL should at minimum reference the bucket name and the key.
    expect(out.url).toContain('test-bucket')
    expect(out.url).toContain(encodeURIComponent(KEY).replace(/%2F/g, '/'))
    // The signed-URL query string must declare a presigned-S3 signature.
    expect(out.url).toMatch(/X-Amz-Signature=/)
    // Returned headers exactly mirror what the SPA must replay on PUT.
    expect(out.headers['content-type']).toBe('image/png')
    expect(out.headers['content-length']).toBe('1024')
    expect(out.headers['x-amz-meta-sha256']).toBe(SHA)
  })

  it('declares the sha256 header as signed (forging it post-sign breaks the signature)', async () => {
    process.env.R2_PRESIGN_PUT_TTL_SECONDS = '300'
    const { presignPut, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    const out = await presignPut(KEY, 'image/png', 10, SHA)
    // The presigner declares `x-amz-meta-sha256` in `X-Amz-SignedHeaders`,
    // so the client must include it on the PUT or R2 rejects the request.
    const url = new URL(out.url)
    const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? ''
    expect(signed.toLowerCase()).toContain('x-amz-meta-sha256')
    expect(signed.toLowerCase()).toContain('content-type')
    expect(signed.toLowerCase()).toContain('content-length')
  })
})

describe('presignGet', () => {
  it('signs a GET URL with the configured TTL', async () => {
    process.env.R2_PRESIGN_GET_TTL_SECONDS = '900'
    const { presignGet, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    const out = await presignGet(KEY)
    expect(out.expiresIn).toBe(900)
    expect(out.url).toMatch(/X-Amz-Signature=/)
    expect(out.url).toContain('test-bucket')
  })
})

describe('headObject', () => {
  it('returns contentLength + sha256 from object metadata on success', async () => {
    const sendSpy = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({
        ContentLength: 4242,
        Metadata: { sha256: SHA },
      } as never)
    const { headObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    const out = await headObject(KEY)
    expect(out).toEqual({ contentLength: 4242, sha256: SHA })
    expect(sendSpy).toHaveBeenCalled()
  })

  it('returns null sha256 when R2 did not echo the user metadata', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      ContentLength: 10,
      Metadata: undefined,
    } as never)
    const { headObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    const out = await headObject(KEY)
    expect(out.sha256).toBeNull()
    expect(out.contentLength).toBe(10)
  })

  it('throws NotFound when R2 reports a 404 (NoSuchKey)', async () => {
    const err = Object.assign(new Error('not found'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(err)
    const { headObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    await expect(headObject(KEY)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('wraps any other error as UpstreamUnavailable (502)', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    )
    const { headObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    await expect(headObject(KEY)).rejects.toMatchObject({
      status: 502,
      code: 'upstream_unavailable',
    })
  })
})

describe('deleteObject', () => {
  it('completes silently on a successful DELETE', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).resolves.toBeUndefined()
  })

  it('treats a 404 as success (idempotent delete contract)', async () => {
    const err = Object.assign(new Error('not found'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(err)
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).resolves.toBeUndefined()
  })

  it('surfaces non-404 failures as UpstreamUnavailable', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      new Error('500 internal'),
    )
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/services/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).rejects.toMatchObject({
      status: 502,
      code: 'upstream_unavailable',
    })
  })
})
