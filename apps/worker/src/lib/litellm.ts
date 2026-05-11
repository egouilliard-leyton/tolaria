// Worker-side LiteLLM client for non-streaming chat completions used by
// the `ai-tool-run` handler. Streaming is only useful for interactive
// surfaces; tool runs in the worker can collect the whole response in
// memory, which simplifies error handling and persistence in `ai_runs`.

import { loadEnv } from '../env.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
}

export interface ChatResult {
  content: string
  promptTokens: number
  completionTokens: number
}

export interface LiteLlmClient {
  chat: (req: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>
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
    async chat(req, signal): Promise<ChatResult> {
      const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: false,
        }),
        signal,
      })
      if (!res.ok) {
        const text = await safeReadText(res)
        throw new Error(`litellm ${res.status}: ${text || res.statusText}`)
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const content = json.choices?.[0]?.message?.content ?? ''
      const promptTokens = json.usage?.prompt_tokens ?? 0
      const completionTokens = json.usage?.completion_tokens ?? 0
      return { content, promptTokens, completionTokens }
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
