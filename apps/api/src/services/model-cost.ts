// Static per-model cost factor table.
//
// Each ai_runs row records a `cost_cents` estimate so admin/finance
// queries can roll up spend per (subscription, day, model). The rates
// are pinned in code on purpose: they are public pricing-page numbers
// as of the audit date (see audit-2026-05-10 Bundle K / G49), and the
// review/refactor path that swaps them out should be a deliberate
// commit, not a silent runtime config drift.
//
// A future revision can swap this static map for a runtime config
// loader (e.g. `ai_models.capabilities.costPerKToken` rows) without
// changing the calling surface — the shape of `estimateCostCents` is
// designed to absorb that swap. Until then, unknown models record
// `null`; the route still completes and the audit log still names the
// model, but the per-day rollup stays honest by skipping the unknowns
// instead of treating them as zero-cost.
//
// Source: public pricing pages as of 2026-05-10. Values are USD per
// 1k tokens, separated by direction. Internally we round UP to whole
// cents so we never under-bill ourselves.
//
//   Model                            Input/1k   Output/1k
//   ───────────────────────────────  ─────────  ─────────
//   openai/gpt-4o                     $0.0025    $0.0100
//   openai/gpt-4o-mini                $0.00015   $0.00060
//   openai/o4-mini                    $0.0011    $0.0044
//   openai/gpt-5                      $0.0050    $0.0150
//   anthropic/claude-3-5-sonnet       $0.0030    $0.0150
//   anthropic/claude-3-5-haiku        $0.0008    $0.0040
//   anthropic/claude-3-opus           $0.0150    $0.0750
//   anthropic/claude-opus-4           $0.0150    $0.0750
//   anthropic/claude-sonnet-4         $0.0030    $0.0150
//   google/gemini-2.5-pro             $0.00125   $0.0050
//   google/gemini-2.5-flash           $0.000075  $0.00030
//   openai/text-embedding-3-small     $0.00002   —
//   openai/text-embedding-3-large     $0.00013   —
//
// When LiteLLM is configured to route a request to one of the above
// providers, `resolveModel(...).name` is the bare model name (e.g.
// `gpt-4o`) and `provider` is `openai`/`anthropic`/etc. The route
// passes `model: row.name` to `estimateCostCents`, so the index here
// is keyed on the bare name and we accept either form as input.

interface CostFactor {
  /** USD per 1k input (prompt) tokens, in dollars. */
  inputPerK: number
  /** USD per 1k output (completion) tokens, in dollars. */
  outputPerK: number
}

const COST_FACTORS: ReadonlyMap<string, CostFactor> = new Map([
  // OpenAI
  ['gpt-4o', { inputPerK: 0.0025, outputPerK: 0.010 }],
  ['gpt-4o-mini', { inputPerK: 0.00015, outputPerK: 0.00060 }],
  ['o4-mini', { inputPerK: 0.0011, outputPerK: 0.0044 }],
  ['gpt-5', { inputPerK: 0.005, outputPerK: 0.015 }],
  ['text-embedding-3-small', { inputPerK: 0.00002, outputPerK: 0 }],
  ['text-embedding-3-large', { inputPerK: 0.00013, outputPerK: 0 }],

  // Anthropic
  ['claude-3-5-sonnet', { inputPerK: 0.003, outputPerK: 0.015 }],
  ['claude-3-5-sonnet-20241022', { inputPerK: 0.003, outputPerK: 0.015 }],
  ['claude-3-5-haiku', { inputPerK: 0.0008, outputPerK: 0.004 }],
  ['claude-3-opus', { inputPerK: 0.015, outputPerK: 0.075 }],
  ['claude-opus-4', { inputPerK: 0.015, outputPerK: 0.075 }],
  ['claude-sonnet-4', { inputPerK: 0.003, outputPerK: 0.015 }],

  // Google
  ['gemini-2.5-pro', { inputPerK: 0.00125, outputPerK: 0.005 }],
  ['gemini-2.5-flash', { inputPerK: 0.000075, outputPerK: 0.0003 }],
])

/**
 * Strip provider prefixes like `openai/`, `anthropic/`, `bedrock/`,
 * `vertex_ai/` so the lookup matches whether the model id is qualified
 * or bare. LiteLLM accepts both forms; the registry stores bare names.
 */
function normalizeModelKey(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

/**
 * Estimate the cost of an `ai_runs` call in whole cents, rounded UP so
 * we never under-bill. Returns `null` when the model is not in the
 * pinned table — the caller persists null so admin queries can detect
 * coverage gaps without treating them as $0.
 *
 * The cost is computed from the token counts the LiteLLM stream
 * reported back; embeddings record only `promptTokens` (the worker
 * already passes 0 for completion).
 */
export function estimateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const factor = COST_FACTORS.get(normalizeModelKey(model))
  if (!factor) return null
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    promptTokens < 0 ||
    completionTokens < 0
  ) {
    return null
  }
  const dollars =
    (promptTokens / 1000) * factor.inputPerK +
    (completionTokens / 1000) * factor.outputPerK
  // Round UP to whole cents. A 0-token call (no usage reported) records
  // 0 cents; this is correct — the model registry call still happened
  // and the row should not silently lose its provenance.
  return Math.ceil(dollars * 100)
}

/**
 * Test seam — return the set of model names currently in the static
 * table. Used by `services/model-cost.test.ts` to assert that every
 * model in `db/migrations/0001_init.sql`'s seeded `ai_models` rows has
 * a cost factor.
 */
export function knownCostModels(): string[] {
  return Array.from(COST_FACTORS.keys())
}
