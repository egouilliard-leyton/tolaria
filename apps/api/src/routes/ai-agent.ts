// /ai/agent/run — long-running agent runs.
//
// V1 punt: agent runs require a pg-boss `ai-tool-run` job that streams its
// progress back through a server-side bus, plus a more involved tool-loop
// integration with LiteLLM. The synchronous `/ai/chat` route already covers
// the interactive case (single user message → streamed reply with optional
// tool_call → SPA-side tool execution → follow-up /ai/chat call).
//
// We surface a 501 with a stable `not_implemented` payload so the SPA can
// gracefully fall back to /ai/chat or hide the agent UI. The wire shape of
// the eventual implementation will mirror /ai/chat (SSE returning the same
// `AiStreamEvent` union), so SPA code that consumes /ai/chat will be
// trivially redirectable when this route lands.

import { Hono } from 'hono'
import { AI_RATE_LIMIT, rateLimit } from '../middleware/rate-limit.js'

export const aiAgent = new Hono()

// Even though the route currently 501s, attach the rate limiter now so the
// budget is in place when the real implementation lands. Per-user, same
// budget as /ai/chat.
aiAgent.post(
  '/ai/agent/run',
  rateLimit({ bucket: 'ai', scope: 'user', ...AI_RATE_LIMIT }),
  (c) =>
  c.json(
    {
      error: {
        code: 'not_implemented',
        message:
          'Agent runs are not implemented in v1. Use POST /ai/chat with the ' +
          'discriminated tool_call/tool_result events; see ' +
          'docs/ARCHITECTURE-WEB-SAAS.md §7.',
      },
    },
    501,
  ),
)
