// End-to-end-ish test for the embedding branch inside `handleIndexNote`.
// We exercise both the disabled-by-default path (no env, no upstream
// fetch, no UPDATE on `note_search.embedding`) and the configured path
// (env set, fetch called, embedding written).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryCall { text: string; values: unknown[] }
interface QueryResult { rows: unknown[]; rowCount: number }

const queries: QueryCall[] = []
let nextResults: QueryResult[] = []

const fakeClient = {
  query: vi.fn(async (text: string, values: unknown[] = []): Promise<QueryResult> => {
    queries.push({ text, values })
    return nextResults.shift() ?? { rows: [], rowCount: 0 }
  }),
}

vi.mock('../src/lib/db.js', () => ({
  withTenant: async <T>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) =>
    fn(fakeClient),
  pool: {} as unknown,
}))

const fetchSpy = vi.fn(
  async () =>
    new Response(
      JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.5) }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
)

// Stub global fetch so the embedding client picks it up via `loadEnv`.
beforeEach(() => {
  queries.length = 0
  nextResults = []
  fakeClient.query.mockClear()
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const SUB = '11111111-1111-1111-1111-111111111111'
const VAULT = '22222222-2222-2222-2222-222222222222'
const NOTE = '33333333-3333-3333-3333-333333333333'

describe('handleIndexNote — embedding branch', () => {
  it('does not call LiteLLM or UPDATE the embedding column when env is empty', async () => {
    vi.stubEnv('LITELLM_EMBEDDING_MODEL', '')
    vi.resetModules()
    const { handleIndexNote } = await import('../src/handlers/index-note.js')

    // SELECT note → returns a single row.
    nextResults.push({
      rows: [{ id: NOTE, vault_id: VAULT, title: 't', body_md: 'body' }],
      rowCount: 1,
    })
    // INSERT INTO note_search (ts_doc) — no rows back.
    nextResults.push({ rows: [], rowCount: 1 })
    // DELETE FROM note_links — no wikilinks in body so no further calls.
    nextResults.push({ rows: [], rowCount: 0 })

    await handleIndexNote({ subscriptionId: SUB, vaultId: VAULT, noteId: NOTE })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      queries.find((q) => /UPDATE note_search SET embedding/.test(q.text)),
    ).toBeUndefined()
  })

  it('calls LiteLLM and writes the embedding column when env is set and budget is open', async () => {
    vi.stubEnv('LITELLM_EMBEDDING_MODEL', 'text-embedding-3-small')
    vi.stubEnv('EMBEDDING_DIMS', '1536')
    vi.stubEnv('EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY', '1000')
    vi.resetModules()
    const { handleIndexNote } = await import('../src/handlers/index-note.js')

    // SELECT note.
    nextResults.push({
      rows: [{ id: NOTE, vault_id: VAULT, title: 't', body_md: 'body' }],
      rowCount: 1,
    })
    // INSERT INTO note_search (ts_doc).
    nextResults.push({ rows: [], rowCount: 1 })
    // checkAndIncrementBudget CTE → returns within budget.
    nextResults.push({
      rows: [{ final_cents: '1', prev_cents: '0' }],
      rowCount: 1,
    })
    // UPDATE note_search SET embedding.
    nextResults.push({ rows: [], rowCount: 1 })
    // DELETE FROM note_links — no wikilinks so we stop here.
    nextResults.push({ rows: [], rowCount: 0 })

    await handleIndexNote({ subscriptionId: SUB, vaultId: VAULT, noteId: NOTE })

    // LiteLLM was called once for /v1/embeddings.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0])
    expect(url).toMatch(/\/v1\/embeddings$/)

    // The UPDATE note_search SET embedding statement landed.
    const upd = queries.find((q) =>
      /UPDATE note_search SET embedding/.test(q.text),
    )
    expect(upd).toBeDefined()
    // The value should look like a pgvector text literal.
    expect(String(upd!.values[0])).toMatch(/^\[/)
  })

  it('skips the embedding UPDATE when the budget is exhausted but still upserts ts_doc', async () => {
    vi.stubEnv('LITELLM_EMBEDDING_MODEL', 'text-embedding-3-small')
    vi.stubEnv('EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY', '1')
    vi.resetModules()
    const { handleIndexNote } = await import('../src/handlers/index-note.js')

    // SELECT note.
    nextResults.push({
      rows: [{ id: NOTE, vault_id: VAULT, title: 't', body_md: 'body' }],
      rowCount: 1,
    })
    // INSERT INTO note_search (ts_doc).
    nextResults.push({ rows: [], rowCount: 1 })
    // checkAndIncrementBudget → cap exhausted (final == prev).
    nextResults.push({
      rows: [{ final_cents: '1', prev_cents: '1' }],
      rowCount: 1,
    })
    // DELETE FROM note_links — handler short-circuits here on no wikilinks.
    nextResults.push({ rows: [], rowCount: 0 })

    await handleIndexNote({ subscriptionId: SUB, vaultId: VAULT, noteId: NOTE })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      queries.find((q) => /UPDATE note_search SET embedding/.test(q.text)),
    ).toBeUndefined()
    // ts_doc upsert still fired.
    expect(
      queries.find((q) => /INSERT INTO note_search/.test(q.text)),
    ).toBeDefined()
  })
})
