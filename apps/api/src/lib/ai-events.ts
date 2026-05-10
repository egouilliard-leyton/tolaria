// Server-side mirror of the `AiStreamEvent` discriminated union the SPA
// expects to read off the SSE wire. The SPA's `HttpVaultAdapter`
// (`mapSseToAiEvent` in `src/lib/vault-adapter/http-adapter.ts`) parses each
// `data:` JSON payload by `event.type` and reads snake_case fields
// (`prompt_tokens`, `completion_tokens`, `credits_remaining`). Keep the
// shapes here in lockstep with that consumer.
//
// `AiStreamRequestSchema` is the inverse of the SPA's `AiStreamRequest` and
// is the body the SPA POSTs to `/ai/chat`. The wire is snake_case.

import { z } from 'zod'

export type AiStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; id: string }
  | { type: 'tool_result'; id: string; result: unknown }
  | {
      type: 'usage'
      prompt_tokens: number
      completion_tokens: number
      credits_remaining: number
    }
  | { type: 'done' }
  | { type: 'error'; message: string }

export const AiMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
})

export const AiToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  schema: z.record(z.unknown()),
})

export const AiStreamRequestSchema = z.object({
  vault_id: z.string().uuid(),
  model: z.string().min(1),
  messages: z.array(AiMessageSchema).min(1),
  tools: z.array(AiToolSchema).optional(),
})

export type AiStreamRequest = z.infer<typeof AiStreamRequestSchema>

export const AiToolResultSchema = z.object({
  run_id: z.string().uuid(),
  tool_call_id: z.string().min(1),
  result: z.unknown(),
})

export type AiToolResult = z.infer<typeof AiToolResultSchema>
