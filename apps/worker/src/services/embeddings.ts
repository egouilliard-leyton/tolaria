// Embedding-pipeline glue: a thin LiteLLM client for `/v1/embeddings`, a
// rough cost estimator, and a per-tenant daily budget tracker that runs
// inside the same `withTenant` transaction as the calling handler.
//
// The pipeline is *optional* — when `LITELLM_EMBEDDING_MODEL` is empty the
// worker skips embedding writes entirely so the full-text path keeps
// working with zero configuration. See Bundle F in
// docs/web-saas/audit-2026-05-10.md.

import type { PgClient } from '../lib/db.js'
import { loadEnv } from '../env.js'

/**
 * Rough cost factor: $0.0002 per 1k input tokens → 0.02 cents per 1k
 * tokens. This is an "order of magnitude" number that lets us bound spend
 * without negotiating exact model pricing in code. Tighten as needed.
 */
export const CENTS_PER_K_TOKENS = 0.02

/** Approximate token count without paying for a tokenizer. */
export function estimateTokens(text: string): number {
  return (text.length / 4) | 0
}

/** Approximate spend in whole cents for a given input length. */
export function estimateCents(text: string): number {
  const tokens = estimateTokens(text)
  // Round UP so we never under-bill ourselves into a budget overshoot.
  return Math.ceil((tokens / 1000) * CENTS_PER_K_TOKENS)
}

export interface EmbedTextOptions {
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
  /** Override the default 5s request timeout (ms). */
  timeoutMs?: number
  /**
   * Opaque tags forwarded to LiteLLM as `metadata.tags`. LiteLLM strips
   * them before contacting the upstream embeddings provider and uses
   * them for per-tenant cost attribution. See
   * `apps/api/src/services/litellm.ts` header for the canonical shape.
   * The index-note handler emits at minimum:
   *   subscription:<uuid>, vault:<uuid>, user:<uuid> (when known),
   *   kind:embedding
   */
  metadataTags?: ReadonlyArray<string>
}

/**
 * POST the input text to LiteLLM's `/v1/embeddings` endpoint and return
 * the float vector. Throws on non-2xx response, malformed body, or
 * timeout.
 */
export async function embedText(
  text: string,
  model: string,
  opts: EmbedTextOptions = {},
): Promise<number[]> {
  const env = loadEnv()
  const baseUrl = (opts.baseUrl ?? env.LITELLM_BASE_URL).replace(/\/+$/, '')
  const token = opts.token ?? env.LITELLM_TOKEN
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 5_000

  const tags = opts.metadataTags && opts.metadataTags.length > 0
    ? Array.from(opts.metadataTags)
    : undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        ...(tags ? { metadata: { tags } } : {}),
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await safeReadText(res)
      throw new Error(`litellm embeddings ${res.status}: ${body || res.statusText}`)
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>
    }
    const embedding = json.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('litellm embeddings: response missing data[0].embedding')
    }
    return embedding
  } finally {
    clearTimeout(timer)
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
 * Atomically bump the per-tenant daily spend counter and decide whether
 * the call is within budget. Returns `true` when the post-increment total
 * stays at or below the daily cap; `false` (with no DB change) when the
 * cap would be exceeded.
 *
 * The function uses a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * inside the caller's transaction so concurrent index jobs cannot race
 * each other into double-counting or over-spending.
 *
 * `client` must already be inside a `withTenant` transaction so the
 * `embedding_budgets_tenant` RLS policy admits the row.
 */
export async function checkAndIncrementBudget(
  client: PgClient,
  subscriptionId: string,
  cents: number,
): Promise<boolean> {
  if (!Number.isFinite(cents) || cents < 0) {
    throw new Error('checkAndIncrementBudget: cents must be a non-negative finite number')
  }
  const env = loadEnv()
  const cap = env.EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY
  // Charging zero is a no-op but we still need to know whether the cap is
  // already exhausted, so fall through into the same query.
  const charge = Math.max(0, Math.ceil(cents))

  // Atomic two-step using a CTE: read the current spend with `FOR UPDATE`
  // so concurrent index jobs serialize on the row, then INSERT/UPDATE
  // conditionally and report back whether the increment landed.
  //
  // The CTE flow:
  //   prev: SELECT FOR UPDATE the existing (subscription, today) row.
  //   ins:  INSERT a fresh row if `prev` returned nothing. The fresh row
  //         either stores `charge` (when charge <= cap) or 0 (when a
  //         single call already exceeds the daily cap).
  //   upd:  UPDATE the existing row, applying the CASE so we never push
  //         past the cap.
  // The final SELECT pulls the post-state from whichever branch fired
  // and the pre-state (zero when there was no prior row) so JS can
  // compute "did the charge land?" without re-reading.
  const { rows } = await client.query<{
    final_cents: string
    prev_cents: string
  }>(
    `WITH prev AS (
       SELECT cents_spent FROM embedding_budgets
        WHERE subscription_id = $1 AND day = CURRENT_DATE
        FOR UPDATE
     ),
     ins AS (
       INSERT INTO embedding_budgets (subscription_id, day, cents_spent)
         SELECT $1, CURRENT_DATE,
                CASE WHEN $2::bigint <= $3::bigint THEN $2::bigint ELSE 0 END
          WHERE NOT EXISTS (SELECT 1 FROM prev)
       RETURNING cents_spent
     ),
     upd AS (
       UPDATE embedding_budgets
          SET cents_spent = CASE
              WHEN cents_spent + $2::bigint <= $3::bigint
                THEN cents_spent + $2::bigint
              ELSE cents_spent
            END
        WHERE subscription_id = $1
          AND day = CURRENT_DATE
          AND EXISTS (SELECT 1 FROM prev)
       RETURNING cents_spent
     )
     SELECT
       COALESCE((SELECT cents_spent FROM upd),
                (SELECT cents_spent FROM ins),
                0) AS final_cents,
       COALESCE((SELECT cents_spent FROM prev), 0) AS prev_cents`,
    [subscriptionId, charge, cap],
  )
  const row = rows[0]
  if (!row) return false
  const finalCents = Number(row.final_cents)
  const prevCents = Number(row.prev_cents)
  // The charge landed iff the post-state is strictly larger than the
  // pre-state by `charge` (handles UPDATE's ELSE branch keeping the
  // value flat, and the INSERT-with-0 branch when a single call would
  // already exceed the cap). A zero charge always succeeds when the
  // current day's spend is within the cap.
  if (charge === 0) return finalCents <= cap
  return finalCents - prevCents === charge && finalCents <= cap
}
