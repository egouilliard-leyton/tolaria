// Unit tests for the worker-side LiteLLM client used by `ai-tool-run`
// (`summarize-vault`). Non-streaming JSON response, so we can stub fetch.

import { describe, expect, it, vi } from 'vitest'
import { createLiteLlmClient } from '../src/lib/litellm.js'

describe('createLiteLlmClient.chat', () => {
  it('POSTs JSON with stream=false and returns content + token counts', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = createLiteLlmClient({
      baseUrl: 'http://litellm.test',
      token: 'tok-x',
      fetchImpl,
    })
    const out = await client.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out).toEqual({ content: 'hello world', promptTokens: 5, completionTokens: 2 })

    // POST to /v1/chat/completions with stream=false and bearer auth.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://litellm.test/v1/chat/completions')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse((calls[0]!.init?.body as string) ?? '{}')
    expect(body.stream).toBe(false)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-x')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('returns zero-token counts and empty content when LiteLLM omits them', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{}] }), { status: 200 })
    const client = createLiteLlmClient({
      baseUrl: 'http://litellm.test',
      token: 'tok-x',
      fetchImpl,
    })
    const out = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(out).toEqual({ content: '', promptTokens: 0, completionTokens: 0 })
  })

  it('throws on a non-200 LiteLLM response with the status and body excerpt', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('rate limit exceeded', { status: 429 })
    const client = createLiteLlmClient({
      baseUrl: 'http://litellm.test',
      token: 'tok-x',
      fetchImpl,
    })
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/429/)
  })

  it('strips trailing slashes from the base URL', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify({}), { status: 200 })
    }
    const client = createLiteLlmClient({
      baseUrl: 'http://litellm.test/////',
      token: 'tok',
      fetchImpl,
    })
    await client.chat({ model: 'm', messages: [] })
    expect(calls[0]).toBe('http://litellm.test/v1/chat/completions')
  })

  it('forwards the AbortSignal to fetch', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      expect(init?.signal).toBeDefined()
      return new Response(JSON.stringify({}), { status: 200 })
    })
    const controller = new AbortController()
    const client = createLiteLlmClient({
      baseUrl: 'http://litellm.test',
      token: 'tok',
      fetchImpl,
    })
    await client.chat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      controller.signal,
    )
    expect(fetchImpl).toHaveBeenCalled()
  })
})
