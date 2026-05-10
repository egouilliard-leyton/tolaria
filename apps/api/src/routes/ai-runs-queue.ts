// Process-local emitter queue keyed by `runId`.
//
// The `/ai/chat` SSE stream and the `/ai/chat/tool-result` POST handler need
// to talk to each other in-process so the SPA can:
//   1. Receive a `tool_call` event from the model.
//   2. Run the tool client-side.
//   3. POST the result to /ai/chat/tool-result.
//   4. See it appear as a `tool_result` event in the same stream.
//
// We deliberately do NOT use Redis or pg_notify here. The web-saas plan in
// docs/ARCHITECTURE-WEB-SAAS.md keeps the synchronous chat path single-node
// (a SaaS pod terminates each SSE connection on one process). Long-running
// agents move to `pg-boss` via /ai/agent/run, which has its own pub/sub
// mechanism and is not implemented in v1.
//
// Because the queue is process-local, it does not need RLS — only one tenant
// ever writes to a given runId, and the handler verifies ownership against
// `ai_runs` via RLS before pushing.

import type { AiStreamEvent } from '../lib/ai-events.js'

export interface EmitterQueue {
  push: (event: AiStreamEvent) => void
  shift: () => AiStreamEvent | undefined
  dispose: () => void
}

class RunQueues {
  private readonly map = new Map<string, AiStreamEvent[]>()

  create(runId: string): EmitterQueue {
    const buffer: AiStreamEvent[] = []
    this.map.set(runId, buffer)
    return {
      push: (event) => {
        const live = this.map.get(runId)
        if (live) live.push(event)
      },
      shift: () => buffer.shift(),
      dispose: () => {
        this.map.delete(runId)
      },
    }
  }

  get(runId: string): EmitterQueue | undefined {
    const buffer = this.map.get(runId)
    if (!buffer) return undefined
    return {
      push: (event) => buffer.push(event),
      shift: () => buffer.shift(),
      dispose: () => {
        this.map.delete(runId)
      },
    }
  }

  dispose(runId: string): void {
    this.map.delete(runId)
  }

  /** Test-only — clear all queues so vitest workers don't leak state. */
  _resetForTests(): void {
    this.map.clear()
  }
}

export const runQueues = new RunQueues()
