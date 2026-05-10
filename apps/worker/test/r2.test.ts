// Tests the worker-side R2 client's `deleteObject` contract:
//   - successful DELETE resolves without error
//   - 404 / NoSuchKey is treated as success (retry-safe idempotent delete)
//   - any other error propagates

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'

const KEY = 's/sub/v/v/a/att/file.png'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worker deleteObject', () => {
  it('resolves silently on a successful DELETE', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/lib/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).resolves.toBeUndefined()
  })

  it('treats NoSuchKey / 404 as success so pg-boss retries are idempotent', async () => {
    const err = Object.assign(new Error('gone'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(err)
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/lib/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).resolves.toBeUndefined()
  })

  it('treats NotFound error name as success', async () => {
    const err = Object.assign(new Error('not found'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    })
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(err)
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/lib/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).resolves.toBeUndefined()
  })

  it('propagates non-404 errors so pg-boss can retry the job', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      new Error('500 internal'),
    )
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/lib/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).rejects.toThrow(/500 internal/)
  })

  it('also propagates non-Error throws (defensive)', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue('weird string')
    const { deleteObject, __resetR2ClientForTests } = await import(
      '../src/lib/r2.js'
    )
    __resetR2ClientForTests()
    await expect(deleteObject(KEY)).rejects.toBe('weird string')
  })
})
