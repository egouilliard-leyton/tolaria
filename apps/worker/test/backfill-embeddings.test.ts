// Tests for the `backfill-embeddings` handler. Verifies that the
// handler enumerates the vault in pages of 50 and enqueues exactly one
// `index-note` job per non-deleted note.

import { afterEach, describe, expect, it, vi } from 'vitest'

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
}))

const enqueueIndexNote = vi.fn(async () => 'job-id')
vi.mock('../src/lib/jobs.js', () => ({ enqueueIndexNote }))

afterEach(() => {
  queries.length = 0
  nextResults = []
  fakeClient.query.mockClear()
  enqueueIndexNote.mockClear()
})

const SUB = '11111111-1111-4111-8111-111111111111'
const VAULT = '22222222-2222-4222-8222-222222222222'

function makeUuid(i: number): string {
  // 36-char UUID-ish. Just needs to round-trip cleanly.
  const hex = i.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

describe('handleBackfillEmbeddings', () => {
  it('enqueues one index-note per note across multiple pages', async () => {
    const { handleBackfillEmbeddings } = await import(
      '../src/handlers/backfill-embeddings.js'
    )

    // 75 notes total, paged 50 + 25.
    const all = Array.from({ length: 75 }, (_, i) => ({ id: makeUuid(i + 1) }))
    nextResults.push({ rows: all.slice(0, 50), rowCount: 50 })
    nextResults.push({ rows: all.slice(50, 75), rowCount: 25 })

    await handleBackfillEmbeddings({
      data: { subscriptionId: SUB, vaultId: VAULT },
    } as unknown as Parameters<typeof handleBackfillEmbeddings>[0])

    // First query: no cursor. Second query: keyset on last id of page 1.
    expect(queries).toHaveLength(2)
    expect(queries[0]!.text).toMatch(/SELECT id FROM notes/)
    expect(queries[0]!.text).not.toMatch(/id > /)
    expect(queries[1]!.text).toMatch(/id > /)
    expect(queries[1]!.values[1]).toBe(all[49]!.id)

    expect(enqueueIndexNote).toHaveBeenCalledTimes(75)
    expect(enqueueIndexNote).toHaveBeenNthCalledWith(1, {
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: all[0]!.id,
    })
    expect(enqueueIndexNote).toHaveBeenNthCalledWith(75, {
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: all[74]!.id,
    })
  })

  it('no-ops cleanly when the vault has zero notes', async () => {
    const { handleBackfillEmbeddings } = await import(
      '../src/handlers/backfill-embeddings.js'
    )
    nextResults.push({ rows: [], rowCount: 0 })
    await handleBackfillEmbeddings({
      data: { subscriptionId: SUB, vaultId: VAULT },
    } as unknown as Parameters<typeof handleBackfillEmbeddings>[0])
    expect(enqueueIndexNote).not.toHaveBeenCalled()
  })

  it('exits after the first partial page (size < 50)', async () => {
    const { handleBackfillEmbeddings } = await import(
      '../src/handlers/backfill-embeddings.js'
    )
    const small = Array.from({ length: 5 }, (_, i) => ({ id: makeUuid(i + 1) }))
    nextResults.push({ rows: small, rowCount: 5 })
    await handleBackfillEmbeddings({
      data: { subscriptionId: SUB, vaultId: VAULT },
    } as unknown as Parameters<typeof handleBackfillEmbeddings>[0])
    expect(queries).toHaveLength(1)
    expect(enqueueIndexNote).toHaveBeenCalledTimes(5)
  })

  it('throws on a malformed payload', async () => {
    const { handleBackfillEmbeddings } = await import(
      '../src/handlers/backfill-embeddings.js'
    )
    await expect(
      handleBackfillEmbeddings({
        data: { subscriptionId: 'not-uuid', vaultId: VAULT },
      } as unknown as Parameters<typeof handleBackfillEmbeddings>[0]),
    ).rejects.toThrow()
  })
})
