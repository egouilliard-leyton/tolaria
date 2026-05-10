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

export const aiAgent = new Hono()

aiAgent.post('/ai/agent/run', (c) =>
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
