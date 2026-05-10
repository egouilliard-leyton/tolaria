-- ai_runs.output_text — captures the textual result of long-running tool
-- runs (e.g. `summarize-vault`) executed by the worker `ai-tool-run` queue.
-- The synchronous `/ai/chat` path does not use this column; only the
-- async tool runs from `apps/worker/src/handlers/ai-tool-run.ts` populate
-- it. NULL means either the run has not finished yet or the tool produced
-- no textual artifact.

BEGIN;

ALTER TABLE ai_runs
  ADD COLUMN IF NOT EXISTS output_text text;

COMMIT;
