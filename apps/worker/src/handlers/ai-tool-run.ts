import type { Job } from 'pg-boss'
import pino from 'pino'

const log = pino({ base: { app: 'tolaria-worker', queue: 'ai-tool-run' } })

// Stub handler for the `ai-tool-run` queue. The synchronous /ai/chat path
// covers the interactive case today; long-running agents move here via
// /ai/agent/run, which is itself a 501 stub in apps/api/src/routes/ai-agent.ts.
// We log on receipt so a misrouted producer is visible, then complete the job.
export async function handleAiToolRun(job: Job<unknown>): Promise<void> {
  log.info({ jobId: job.id }, 'ai-tool-run handler not yet implemented; completing job')
  // TODO(agent ai): drive a tool-augmented LiteLLM run and persist progress
  // events so the SPA can subscribe via /ai/agent/run SSE.
}
