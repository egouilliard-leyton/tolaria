// Tests for `checkAndIncrementBudget`. We use a hand-rolled fake pg
// client that emulates the relevant slice of the `embedding_budgets`
// table: a single (subscription, day) row whose `cents_spent` evolves
// with the CTE we ship in production.
//
// The fake mirrors the SQL semantics:
//   - SELECT FOR UPDATE returns the current row (or empty).
//   - INSERT … WHERE NOT EXISTS adds a fresh row clamped at the cap.
//   - UPDATE … CASE applies the increment only when it would not bust
//     the cap; otherwise it preserves the previous value.
//
// We then assert the helper's boolean return mirrors whether the spend
// counter actually advanced by `charge`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CENTS_PER_K_TOKENS,
  checkAndIncrementBudget,
} from '../src/services/embeddings.js'

const SUB = '11111111-1111-4111-8111-111111111111'

interface FakeRow { cents: number }
const state: { row: FakeRow | null } = { row: null }

const fakeClient = {
  query: vi.fn(async (text: string, values: unknown[] = []) => {
    // Mimic the production CTE. We don't actually parse SQL — we
    // recognize the call by shape because the helper only emits one
    // statement.
    const [, charge, cap] = values as [string, number, number]
    const prev = state.row?.cents ?? 0
    let final = prev
    if (state.row === null) {
      // INSERT branch. The CASE in the helper stores `charge` only when
      // it fits inside the cap; otherwise it stores 0.
      final = charge <= cap ? charge : 0
      state.row = { cents: final }
    } else {
      // UPDATE branch. CASE applies the increment only when the post
      // value would stay within the cap.
      final = prev + charge <= cap ? prev + charge : prev
      state.row.cents = final
    }
    void text
    return {
      rows: [
        {
          final_cents: String(final),
          prev_cents: String(prev),
        },
      ],
      rowCount: 1,
    }
  }),
}

beforeEach(() => {
  state.row = null
  fakeClient.query.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('checkAndIncrementBudget', () => {
  it('admits the first call of the day and bumps cents_spent', async () => {
    vi.stubEnv('EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY', '100')
    // env is cached inside loadEnv; force a fresh module so the new
    // value takes effect.
    vi.resetModules()
    const { checkAndIncrementBudget: fn } = await import(
      '../src/services/embeddings.js'
    )
    const ok = await fn(fakeClient as never, SUB, 5)
    expect(ok).toBe(true)
    expect(state.row?.cents).toBe(5)
  })

  it('admits a second call that stays within the cap', async () => {
    vi.stubEnv('EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY', '100')
    vi.resetModules()
    const { checkAndIncrementBudget: fn } = await import(
      '../src/services/embeddings.js'
    )
    await fn(fakeClient as never, SUB, 40)
    const ok = await fn(fakeClient as never, SUB, 50)
    expect(ok).toBe(true)
    expect(state.row?.cents).toBe(90)
  })

  it('rejects a call that would exceed the daily cap and leaves the row untouched', async () => {
    vi.stubEnv('EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY', '100')
    vi.resetModules()
    const { checkAndIncrementBudget: fn } = await import(
      '../src/services/embeddings.js'
    )
    await fn(fakeClient as never, SUB, 95)
    const ok = await fn(fakeClient as never, SUB, 10) // 95 + 10 > 100
    expect(ok).toBe(false)
    expect(state.row?.cents).toBe(95) // unchanged
  })

  it('rejects an oversize single call on a fresh day', async () => {
    vi.stubEnv('EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY', '50')
    vi.resetModules()
    const { checkAndIncrementBudget: fn } = await import(
      '../src/services/embeddings.js'
    )
    const ok = await fn(fakeClient as never, SUB, 500)
    expect(ok).toBe(false)
    expect(state.row?.cents).toBe(0) // INSERT clamped to 0
  })

  it('rejects negative or non-finite charges defensively', async () => {
    await expect(
      checkAndIncrementBudget(fakeClient as never, SUB, -1),
    ).rejects.toThrow()
    await expect(
      checkAndIncrementBudget(fakeClient as never, SUB, NaN),
    ).rejects.toThrow()
  })

  it('publishes the per-1k-tokens cost factor for ops to inspect', () => {
    expect(CENTS_PER_K_TOKENS).toBeGreaterThan(0)
  })
})
