// Server-side mirror of the `AiStreamEvent` discriminated union the SPA
// expects (see `src/lib/vault-adapter/types.ts`). We keep a copy here to
// avoid pulling the frontend module graph into the Node API. If the wire
// format ever changes, both files MUST be updated in lockstep.
//
// The `Schema` export is a Zod parser for the request body the SPA sends to
// `POST /ai/chat` — it's the inverse of the SPA's `AiStreamRequest`.

import { z } from 'zod'

export type AiStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; id: string }
  | { type: 'tool_result'; id: string; result: unknown }
  | {
      type: 'usage'
      promptTokens: number
      completionTokens: number
      creditsRemaining: number
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
  vaultId: z.string().uuid(),
  model: z.string().min(1),
  messages: z.array(AiMessageSchema).min(1),
  tools: z.array(AiToolSchema).optional(),
})

export type AiStreamRequest = z.infer<typeof AiStreamRequestSchema>

export const AiToolResultSchema = z.object({
  runId: z.string().uuid(),
  toolCallId: z.string().min(1),
  result: z.unknown(),
})

export type AiToolResult = z.infer<typeof AiToolResultSchema>
