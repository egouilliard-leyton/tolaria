// Unit tests for the embedding LiteLLM client.
//
// The client is intentionally tiny — a POST to `/v1/embeddings` with a
// 5s timeout. We verify: payload shape, headers, base-URL trimming,
// timeout enforcement, and error surfaces on non-2xx / malformed bodies.

import { describe, expect, it, vi } from 'vitest'
import { embedText, estimateTokens, estimateCents } from '../src/services/embeddings.js'

const OK_VECTOR = Array.from({ length: 8 }, (_, i) => i * 0.1)

describe('embedText', () => {
  it('POSTs JSON to /v1/embeddings with the right model + bearer auth', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ data: [{ embedding: OK_VECTOR }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const out = await embedText('hello world', 'text-embedding-3-small', {
      baseUrl: 'http://litellm.test',
      token: 'tok-x',
      fetchImpl,
    })
    expect(out).toEqual(OK_VECTOR)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://litellm.test/v1/embeddings')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse((calls[0]!.init?.body as string) ?? '{}')
    expect(body).toEqual({ model: 'text-embedding-3-small', input: 'hello world' })
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-x')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('strips trailing slashes from the base URL', async () => {
    const seen: string[] = []
    const fetchImpl: typeof fetch = async (url) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ data: [{ embedding: OK_VECTOR }] }), { status: 200 })
    }
    await embedText('x', 'm', {
      baseUrl: 'http://litellm.test///',
      token: 't',
      fetchImpl,
    })
    expect(seen[0]).toBe('http://litellm.test/v1/embeddings')
  })

  it('throws on non-2xx with status + body excerpt', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('quota exceeded', { status: 429 })
    await expect(
      embedText('x', 'm', { baseUrl: 'http://litellm.test', token: 't', fetchImpl }),
    ).rejects.toThrow(/429/)
  })

  it('throws when the response body is missing the embedding field', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    await expect(
      embedText('x', 'm', { baseUrl: 'http://litellm.test', token: 't', fetchImpl }),
    ).rejects.toThrow(/missing data\[0\].embedding/)
  })

  it('aborts the fetch when the timeout elapses', async () => {
    vi.useFakeTimers()
    let abortSignal: AbortSignal | undefined
    const fetchImpl: typeof fetch = (_url, init) => {
      abortSignal = init?.signal ?? undefined
      // Resolve only when the signal aborts so we exercise the timeout path.
      return new Promise<Response>((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })
    }
    const promise = embedText('x', 'm', {
      baseUrl: 'http://litellm.test',
      token: 't',
      fetchImpl,
      timeoutMs: 50,
    })
    // Advance past the timeout deadline.
    await vi.advanceTimersByTimeAsync(60)
    await expect(promise).rejects.toThrow(/aborted/)
    expect(abortSignal?.aborted).toBe(true)
    vi.useRealTimers()
  })
})

describe('estimate helpers', () => {
  it('estimateTokens returns floor(length/4)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(4000))).toBe(1000)
  })

  it('estimateCents rounds up so we never under-bill', () => {
    expect(estimateCents('')).toBe(0)
    // 1000 tokens × 0.02 cents/k = 0.02 → ceil = 1.
    expect(estimateCents('a'.repeat(4000))).toBe(1)
    // 500_000 tokens × 0.02 cents/k = 10 → ceil = 10.
    expect(estimateCents('a'.repeat(2_000_000))).toBe(10)
  })
})
