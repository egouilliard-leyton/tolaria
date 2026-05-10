// Unit tests for src/lib/sse.ts.
// Pure encoding behavior + a sanity check that the helper aborts upstream
// when the client signals.

import { describe, expect, it, vi } from 'vitest'
import { encodeSseEvent, sseStreamResponse } from '../src/lib/sse.js'
import type { AiStreamEvent } from '../src/lib/ai-events.js'

describe('encodeSseEvent', () => {
  it('formats a token frame as `event: <type>\\ndata: <json>\\n\\n`', () => {
    const out = encodeSseEvent({ type: 'token', delta: 'hello' })
    expect(out).toBe('event: token\ndata: {"type":"token","delta":"hello"}\n\n')
  })

  it('preserves nested JSON in tool_call args without splitting `data:` lines', () => {
    const event: AiStreamEvent = {
      type: 'tool_call',
      id: 'tc_1',
      name: 'search_vault',
      args: { q: 'multi\nline\nquery', limit: 10 },
    }
    const out = encodeSseEvent(event)
    // The JSON encoding of "\n" is the literal two-char sequence `\n`, so the
    // resulting `data:` line stays a single physical line. No raw newline
    // sneaks through to break SSE framing.
    expect(out.endsWith('\n\n')).toBe(true)
    const dataLine = out.split('\n').find((l) => l.startsWith('data:'))!
    expect(dataLine).toContain('multi\\nline\\nquery')
    expect(out.split('\n').filter((l) => l.startsWith('data:'))).toHaveLength(1)
  })

  it('encodes terminal events distinctly so the SPA can switch on type', () => {
    expect(encodeSseEvent({ type: 'done' })).toContain('event: done')
    expect(encodeSseEvent({ type: 'error', message: 'boom' })).toContain('event: error')
    expect(
      encodeSseEvent({
        type: 'usage',
        promptTokens: 1,
        completionTokens: 2,
        creditsRemaining: 999,
      }),
    ).toContain('"creditsRemaining":999')
  })
})

describe('sseStreamResponse', () => {
  it('returns a Response with text/event-stream headers and streams encoded frames', async () => {
    const events: AiStreamEvent[] = [
      { type: 'token', delta: 'a' },
      { type: 'token', delta: 'b' },
      { type: 'done' },
    ]
    const upstream = new AbortController()
    const ctx = mockContext()
    const res = sseStreamResponse(ctx, asAsyncIterable(events), { upstream })
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
    expect(res.body).toBeTruthy()

    const body = await readAll(res.body!)
    expect(body).toContain('event: token\ndata: {"type":"token","delta":"a"}\n\n')
    expect(body).toContain('event: token\ndata: {"type":"token","delta":"b"}\n\n')
    expect(body.endsWith('event: done\ndata: {"type":"done"}\n\n')).toBe(true)
  })

  it('aborts the upstream controller when the client signal aborts', async () => {
    const upstream = new AbortController()
    const upstreamAbort = vi.spyOn(upstream, 'abort')
    const clientController = new AbortController()
    const ctx = mockContext(clientController.signal)

    // An infinite iterable that we never resume; we just want to verify abort
    // wiring without leaking timers.
    async function* never(): AsyncIterable<AiStreamEvent> {
      yield { type: 'token', delta: 'x' }
      await new Promise(() => {
        /* never resolves */
      })
    }

    const res = sseStreamResponse(ctx, never(), { upstream })
    const reader = res.body!.getReader()
    await reader.read() // first frame
    clientController.abort()
    // Give the abort listener one microtask to fire.
    await new Promise((r) => setTimeout(r, 0))
    expect(upstreamAbort).toHaveBeenCalled()
    reader.cancel().catch(() => undefined)
  })

  it('surfaces an `error` frame when the iterable throws', async () => {
    async function* boom(): AsyncIterable<AiStreamEvent> {
      yield { type: 'token', delta: 'partial' }
      throw new Error('boom')
    }
    const upstream = new AbortController()
    const ctx = mockContext()
    const res = sseStreamResponse(ctx, boom(), { upstream })
    const body = await readAll(res.body!)
    expect(body).toContain('event: token')
    expect(body).toContain('event: error')
    expect(body).toContain('"message":"boom"')
  })
})

function asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value)
  }
  return out
}

function mockContext(
  signal: AbortSignal = new AbortController().signal,
): import('hono').Context {
  // We only use `c.req.raw.signal`; everything else is unused by sse.ts.
  return { req: { raw: { signal } } } as unknown as import('hono').Context
}
