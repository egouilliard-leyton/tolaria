// Tests the `rebuild-vault-index` handler's fan-out:
//   - enumerate every non-deleted note in the vault
//   - enqueue one `index-note` per note via enqueueIndexNote
//   - skip deleted notes (the SELECT already excludes them; verified by
//     scripted query results)

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
vi.mock('../src/lib/jobs.js', () => ({
  enqueueIndexNote,
}))

afterEach(() => {
  queries.length = 0
  nextResults = []
  fakeClient.query.mockClear()
  enqueueIndexNote.mockClear()
})

const SUB = '11111111-1111-4111-8111-111111111111'
const VAULT = '22222222-2222-4222-8222-222222222222'

describe('handleRebuildVaultIndex', () => {
  it('enqueues an index-note job per non-deleted note in the vault', async () => {
    const { handleRebuildVaultIndex } = await import(
      '../src/handlers/rebuild-vault-index.js'
    )
    const A = '33333333-3333-4333-8333-333333333333'
    const B = '44444444-4444-4444-4444-444444444444'
    const C = '55555555-5555-4555-8555-555555555555'

    nextResults.push({ rows: [{ id: A }, { id: B }, { id: C }], rowCount: 3 })

    await handleRebuildVaultIndex({
      data: { subscriptionId: SUB, vaultId: VAULT },
    } as unknown as Parameters<typeof handleRebuildVaultIndex>[0])

    // SELECT scoped to vault and deleted_at IS NULL.
    expect(queries).toHaveLength(1)
    expect(queries[0]!.text).toMatch(/SELECT id FROM notes/)
    expect(queries[0]!.text).toMatch(/deleted_at IS NULL/)
    expect(queries[0]!.values).toEqual([VAULT])

    // One enqueue per note id.
    expect(enqueueIndexNote).toHaveBeenCalledTimes(3)
    expect(enqueueIndexNote).toHaveBeenNthCalledWith(1, {
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: A,
    })
    expect(enqueueIndexNote).toHaveBeenNthCalledWith(2, {
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: B,
    })
    expect(enqueueIndexNote).toHaveBeenNthCalledWith(3, {
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: C,
    })
  })

  it('no-ops cleanly when the vault has zero notes', async () => {
    const { handleRebuildVaultIndex } = await import(
      '../src/handlers/rebuild-vault-index.js'
    )
    nextResults.push({ rows: [], rowCount: 0 })
    await handleRebuildVaultIndex({
      data: { subscriptionId: SUB, vaultId: VAULT },
    } as unknown as Parameters<typeof handleRebuildVaultIndex>[0])
    expect(enqueueIndexNote).not.toHaveBeenCalled()
  })

  it('throws when payload is missing the vaultId', async () => {
    const { handleRebuildVaultIndex } = await import(
      '../src/handlers/rebuild-vault-index.js'
    )
    await expect(
      handleRebuildVaultIndex({
        data: { subscriptionId: SUB },
      } as unknown as Parameters<typeof handleRebuildVaultIndex>[0]),
    ).rejects.toThrow()
  })

  it('throws when subscriptionId is not a UUID', async () => {
    const { handleRebuildVaultIndex } = await import(
      '../src/handlers/rebuild-vault-index.js'
    )
    await expect(
      handleRebuildVaultIndex({
        data: { subscriptionId: 'not-uuid', vaultId: VAULT },
      } as unknown as Parameters<typeof handleRebuildVaultIndex>[0]),
    ).rejects.toThrow()
  })
})
