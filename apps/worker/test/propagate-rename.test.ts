import { afterEach, describe, expect, it, vi } from 'vitest'

const enqueueIndexNote = vi.fn(async () => 'job-id')

vi.mock('../src/lib/jobs.js', () => ({
  enqueueIndexNote,
}))

vi.mock('../src/lib/db.js', () => ({
  withTenant: vi.fn(async <T>(_ctx: unknown, fn: (c: unknown) => Promise<T>) =>
    fn({
      query: async () => ({ rows: [{ id: 'fallback-id' }], rowCount: 1 }),
    }),
  ),
}))

afterEach(() => {
  enqueueIndexNote.mockClear()
})

const SUB = '11111111-1111-1111-1111-111111111111'
const VAULT = '22222222-2222-2222-2222-222222222222'
const A = '33333333-3333-3333-3333-333333333333'
const B = '44444444-4444-4444-4444-444444444444'

describe('handlePropagateRename', () => {
  it('re-enqueues index-note for each affected id', async () => {
    const { handlePropagateRename } = await import(
      '../src/handlers/propagate-rename.js'
    )
    await handlePropagateRename({
      data: {
        subscriptionId: SUB,
        vaultId: VAULT,
        fromPath: 'old',
        toPath: 'new',
        affectedNoteIds: [A, B],
      },
      // pg-boss Job has more fields but the handler only uses `data`.
    } as unknown as Parameters<typeof handlePropagateRename>[0])

    expect(enqueueIndexNote).toHaveBeenCalledTimes(2)
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
  })

  it('falls back to a body-scan when the producer omits affectedNoteIds', async () => {
    const { handlePropagateRename } = await import(
      '../src/handlers/propagate-rename.js'
    )
    await handlePropagateRename({
      data: {
        subscriptionId: SUB,
        vaultId: VAULT,
        fromPath: 'foo',
        toPath: 'bar',
      },
    } as unknown as Parameters<typeof handlePropagateRename>[0])

    // The fallback withTenant returns one id ('fallback-id').
    expect(enqueueIndexNote).toHaveBeenCalledTimes(1)
    expect(enqueueIndexNote).toHaveBeenCalledWith({
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: 'fallback-id',
    })
  })
})
