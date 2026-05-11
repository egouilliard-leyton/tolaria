// LiteLLM HTTP client.
//
// LiteLLM is the only place upstream model API keys live. The API server
// authenticates with a single service token (`LITELLM_TOKEN`) and proxies
// chat-completion calls. This module is intentionally thin:
//
//   - `streamChat` opens a streaming POST to `/v1/chat/completions` and
//     yields one `RawSseFrame` per SSE chunk. It honors the `[DONE]` sentinel.
//   - `health` does a one-shot GET `/health` for the readyz probe.
//
// Translation from `RawSseFrame` to `AiStreamEvent` (token / tool_call /
// usage / etc.) lives in the route handler — that lets us keep this file
// pure HTTP plumbing and unit-test the translation without spinning up an
// actual LiteLLM mock.
//
// ── Wire shape (LiteLLM request body) ──────────────────────────────────────
//
// `streamChat` POSTs to `/v1/chat/completions` with the OpenAI-compatible
// JSON body LiteLLM expects, plus a `metadata.tags` array that LiteLLM
// strips out of the upstream request and uses for per-tag cost
// attribution in its built-in audit log (see audit-2026-05-10 Bundle K /
// G48). The tag set is opaque to LiteLLM — by convention we emit:
//
//   {
//     "model":    "<route>",            // resolved from ai_models
//     "messages": [ … ],
//     "tools":    [ … ],                // optional
//     "stream":   true,
//     "metadata": {
//       "tags": [
//         "subscription:<uuid>",        // pinning spend to a tenant
//         "vault:<uuid>",               // pinning spend to a vault
//         "user:<uuid>",                // pinning spend to a user
//         "kind:chat|agent|embedding"   // call class
//       ]
//     }
//   }
//
// Tags are stripped before forwarding to the upstream model (LiteLLM
// already drops the `metadata` field; the upstream provider never sees
// our tenant ids). The embedding pipeline in
// `apps/worker/src/services/embeddings.ts` emits the same shape with
// `kind:embedding`.

import { loadEnv } from '../env.js'
import { UpstreamUnavailable } from '../lib/errors.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  // Optional fields the upstream may need; LiteLLM accepts the OpenAI shape.
  tool_call_id?: string
  name?: string
}

export interface ChatTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface StreamChatArgs {
  /** LiteLLM route name resolved from the `ai_models` registry. */
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  /**
   * Opaque tags forwarded to LiteLLM as `metadata.tags`. LiteLLM strips
   * these before contacting the upstream provider and uses them to
   * attribute spend per-tenant in its audit log. Callers should include
   * `subscription:<uuid>`, `vault:<uuid>`, `user:<uuid>`, and
   * `kind:<chat|agent|embedding>` at minimum. See module header.
   */
  metadataTags?: ReadonlyArray<string>
}

/**
 * One JSON object decoded from an SSE `data: {…}` chunk. The shape mirrors
 * the OpenAI chat-completion streaming response — LiteLLM normalizes
 * provider-specific responses into this format.
 */
export interface RawSseFrame {
  id?: string
  model?: string
  choices?: Array<{
    index: number
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface LiteLlmClient {
  streamChat: (args: StreamChatArgs, signal: AbortSignal) => AsyncIterable<RawSseFrame>
  health: () => Promise<'ok' | string>
}

export function createLiteLlmClient(opts?: {
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
}): LiteLlmClient {
  const env = loadEnv()
  const baseUrl = (opts?.baseUrl ?? env.LITELLM_BASE_URL).replace(/\/+$/, '')
  const token = opts?.token ?? env.LITELLM_TOKEN
  const fetchImpl = opts?.fetchImpl ?? fetch

  return {
    async *streamChat(args, signal): AsyncIterable<RawSseFrame> {
      const tags = args.metadataTags && args.metadataTags.length > 0
        ? Array.from(args.metadataTags)
        : undefined
      const body = JSON.stringify({
        model: args.model,
        messages: args.messages,
        tools: args.tools,
        stream: true,
        ...(tags ? { metadata: { tags } } : {}),
      })
      let res: Response
      try {
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          body,
          signal,
        })
      } catch (err) {
        // Network-level failure (DNS, ECONNREFUSED, abort).
        if ((err as Error).name === 'AbortError') return
        throw UpstreamUnavailable(`litellm: ${(err as Error).message}`)
      }

      if (!res.ok || !res.body) {
        const text = await safeReadText(res)
        throw UpstreamUnavailable(`litellm ${res.status}: ${text || res.statusText}`)
      }

      yield* parseSseStream(res.body, signal)
    },

    async health(): Promise<'ok' | string> {
      try {
        const res = await fetchImpl(`${baseUrl}/health`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) return 'ok'
        return `${res.status} ${res.statusText}`
      } catch (err) {
        return (err as Error).message
      }
    },
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 512)
  } catch {
    return ''
  }
}

/**
 * Parse a `text/event-stream` body into JSON frames. We only care about the
 * `data:` field — LiteLLM does not use `event:` for chat completions. The
 * sentinel `data: [DONE]\n\n` ends the stream.
 *
 * Exported so the route's unit tests can feed in a synthetic ReadableStream
 * without a network round trip.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<RawSseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE messages are separated by a blank line. We split on the canonical
      // `\n\n` first, then handle CRLF as a fallback.
      let separator = buffer.indexOf('\n\n')
      if (separator === -1) separator = buffer.indexOf('\r\n\r\n')
      while (separator !== -1) {
        const rawMessage = buffer.slice(0, separator)
        const sepLen = buffer.startsWith('\r\n\r\n', separator) ? 4 : 2
        buffer = buffer.slice(separator + sepLen)
        const frame = decodeSseMessage(rawMessage)
        if (frame === DONE) return
        if (frame !== null) yield frame
        separator = buffer.indexOf('\n\n')
        if (separator === -1) separator = buffer.indexOf('\r\n\r\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

const DONE = Symbol('sse:done')
type DoneSentinel = typeof DONE

function decodeSseMessage(raw: string): RawSseFrame | DoneSentinel | null {
  // A single SSE message can carry multiple `data:` lines that need to be
  // joined with `\n` before parsing. Comments (`:` prefix) and other fields
  // (id/event/retry) are ignored — LiteLLM does not use them.
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      // Strip the `data:` prefix and one optional space, exactly per spec.
      const value = line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5)
      dataLines.push(value)
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join('\n').trim()
  if (payload === '[DONE]') return DONE
  if (payload === '') return null
  try {
    return JSON.parse(payload) as RawSseFrame
  } catch {
    // Malformed frame — skip rather than crash the whole stream.
    return null
  }
}

// Singleton — most callers want the env-configured client.
let cached: LiteLlmClient | null = null
export function liteLlm(): LiteLlmClient {
  if (!cached) cached = createLiteLlmClient()
  return cached
}

/**
 * Compose the canonical `metadata.tags` array. Centralized so every call
 * site emits identically-shaped tags and a tag rename only happens in one
 * place. `vaultId` is optional because some routes (e.g. /ai/agent/run
 * with no vault scope) cannot supply one.
 */
export function buildBudgetTags(args: {
  subscriptionId: string
  userId: string
  vaultId?: string | null
  kind: 'chat' | 'agent' | 'embedding'
}): string[] {
  const tags: string[] = [
    `subscription:${args.subscriptionId}`,
    `user:${args.userId}`,
    `kind:${args.kind}`,
  ]
  if (args.vaultId) tags.splice(1, 0, `vault:${args.vaultId}`)
  return tags
}
