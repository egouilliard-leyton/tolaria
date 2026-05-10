// Server-sent-events helpers tailored for the AI proxy.
//
// We deliberately do NOT lean on Hono's `streamSSE` helper here. The AI route
// has two responsibilities the helper does not cover well:
//
//   1. Translate every emitted item (an `AiStreamEvent`) into a typed SSE
//      `event: <type>` frame whose `data:` payload is the JSON of the event
//      itself. The SPA's HTTP adapter consumes these by `event.type`.
//   2. Propagate client disconnects upstream by aborting the LiteLLM
//      `AbortController` that was used to open the upstream stream. Without
//      this the API would happily keep paying for tokens after the SPA tab
//      closed.
//
// `sseStreamResponse` accepts an async iterable of `AiStreamEvent` and an
// `AbortController` it should fire when the client disconnects. It returns a
// `Response` ready to be returned from a Hono handler.

import type { Context } from 'hono'
import type { AiStreamEvent } from './ai-events.js'

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/**
 * Encode a single `AiStreamEvent` as one SSE message:
 *   `event: <type>\ndata: <json>\n\n`
 *
 * The `\n\n` terminator is what the SSE spec uses to dispatch the event on
 * the client. We keep the JSON encoding minimal — no pretty printing, no
 * trailing whitespace — so each line of `data:` stays a single line.
 */
export function encodeSseEvent(event: AiStreamEvent): string {
  const json = JSON.stringify(event)
  // The JSON.stringify output cannot contain raw \n / \r, so we don't need to
  // split the data field across multiple `data:` lines. (See RFC: a CR or LF
  // inside `data:` would terminate the field early.)
  return `event: ${event.type}\ndata: ${json}\n\n`
}

export interface SseStreamOptions {
  /** Aborted when the HTTP client disconnects, so the upstream call can stop. */
  upstream: AbortController
  /** Optional initial retry hint for the EventSource (ms). */
  retryMs?: number
}

/**
 * Wrap an async iterable of `AiStreamEvent`s into a `text/event-stream`
 * response. The iterable is consumed lazily; each yielded event is flushed to
 * the network immediately. If the client disconnects, `opts.upstream.abort()`
 * is invoked so the LiteLLM call can release resources.
 *
 * The iterable is fully responsible for emitting a final `{type: 'done'}` or
 * `{type: 'error'}` event — this helper does not append one. That keeps the
 * route's state machine (audit log, credits update, ai_runs row) consistent
 * with what the wire actually carries.
 */
export function sseStreamResponse(
  c: Context,
  iterable: AsyncIterable<AiStreamEvent>,
  opts: SseStreamOptions,
): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = (): void => {
        opts.upstream.abort()
      }
      // `c.req.raw.signal` fires when the HTTP client goes away. Hooking it
      // into the upstream controller is what closes the LiteLLM socket.
      const signal = c.req.raw.signal
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        if (opts.retryMs && opts.retryMs > 0) {
          controller.enqueue(encoder.encode(`retry: ${opts.retryMs}\n\n`))
        }
        for await (const event of iterable) {
          if (signal.aborted) break
          controller.enqueue(encoder.encode(encodeSseEvent(event)))
        }
      } catch (err) {
        // The iterable itself blew up. Surface a final error frame so the SPA
        // can show a message instead of a silently truncated stream.
        const message = err instanceof Error ? err.message : 'stream failed'
        const frame: AiStreamEvent = { type: 'error', message }
        try {
          controller.enqueue(encoder.encode(encodeSseEvent(frame)))
        } catch {
          // controller may already be closed; nothing to do.
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // The reader (i.e. the network) went away. Make sure the upstream call
      // is torn down even if `signal.abort` did not already fire.
      opts.upstream.abort()
    },
  })

  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}
