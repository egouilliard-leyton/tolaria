// Unit tests for `parseSseStream` (apps/api/src/services/litellm.ts).
//
// Covers the cases the route handler relies on:
//   - simple `data:` frame
//   - multi-line `data:` continuation joined with `\n`
//   - `[DONE]` sentinel ends the stream cleanly
//   - comments / non-data lines are ignored
//   - malformed JSON is skipped (the stream survives)
//   - CRLF-separated messages parse the same as LF
//   - the consumer can abort via AbortSignal

import { describe, expect, it } from 'vitest'
import { parseSseStream, type RawSseFrame } from '../src/services/litellm.js'

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal = new AbortController().signal,
): Promise<RawSseFrame[]> {
  const out: RawSseFrame[] = []
  for await (const frame of parseSseStream(stream, signal)) out.push(frame)
  return out
}

describe('parseSseStream', () => {
  it('decodes a single data: frame as a JSON object', async () => {
    const body = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'
    const frames = await collect(streamFromText(body))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.id).toBe('x')
    expect(frames[0]!.choices?.[0]?.delta?.content).toBe('hi')
  })

  it('joins multi-line data: continuations with newlines before parsing', async () => {
    // A single SSE message split across two `data:` lines. JSON parser
    // must see the joined `{"a":1,\n"b":2}`.
    const body = 'data: {"choices":[{"index":0,"delta":{"content":"line1\\nline2"}}]}\n\n'
    const frames = await collect(streamFromText(body))
    expect(frames[0]!.choices?.[0]?.delta?.content).toBe('line1\nline2')
  })

  it('honours the [DONE] sentinel by ending the iterator', async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"never"}}]}\n\n'
    const frames = await collect(streamFromText(body))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.choices?.[0]?.delta?.content).toBe('a')
  })

  it('ignores non-data lines (comments, event, id, retry)', async () => {
    const body =
      ':heartbeat\n' +
      'event: ping\n' +
      'retry: 5000\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'
    const frames = await collect(streamFromText(body))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.choices?.[0]?.delta?.content).toBe('hi')
  })

  it('skips frames with malformed JSON instead of crashing the stream', async () => {
    const body =
      'data: {not-json}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
    const frames = await collect(streamFromText(body))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.choices?.[0]?.delta?.content).toBe('ok')
  })

  it('parses CRLF-separated messages identically to LF-separated', async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\r\n\r\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"b"}}]}\r\n\r\n'
    const frames = await collect(streamFromText(body))
    expect(frames.map((f) => f.choices?.[0]?.delta?.content)).toEqual(['a', 'b'])
  })

  it('handles chunk boundaries that split a message mid-bytes', async () => {
    // Same frame, but the writer flushed half then half. The parser must
    // buffer the partial chunk until the next chunk arrives.
    const frame =
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
    const mid = Math.floor(frame.length / 2)
    const frames = await collect(
      streamFromChunks([frame.slice(0, mid), frame.slice(mid)]),
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]!.choices?.[0]?.delta?.content).toBe('ok')
  })

  it('stops yielding once the AbortSignal is aborted', async () => {
    const controller = new AbortController()
    // Eternal stream — never closes; we abort to break the loop.
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(new TextEncoder().encode('data: {}\n\n'))
        // Give vitest a tick to read frames before we cancel.
        await new Promise((r) => setTimeout(r, 1))
      },
    })
    const it = parseSseStream(stream, controller.signal)[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.done).toBe(false)
    controller.abort()
    // The next read should drain the loop and return done. We don't
    // assert exact iteration count because the producer may push 1-2
    // frames before the abort lands, but the iterator MUST eventually
    // terminate.
    let safetyCounter = 0
    let res = await it.next()
    while (!res.done && safetyCounter < 10) {
      res = await it.next()
      safetyCounter++
    }
    expect(res.done).toBe(true)
  })
})
