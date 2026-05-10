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

const deleteObject = vi.fn(async () => undefined)
vi.mock('../src/lib/r2.js', () => ({
  deleteObject,
}))

afterEach(() => {
  queries.length = 0
  nextResults = []
  fakeClient.query.mockClear()
  deleteObject.mockClear()
})

const SUB = '11111111-1111-1111-1111-111111111111'
const ATT = '22222222-2222-2222-2222-222222222222'

describe('handleR2Gc — single mode', () => {
  it('deletes the R2 object then the row, in that order', async () => {
    const { handleR2Gc } = await import('../src/handlers/r2-gc.js')
    // First withTenant resolves the key (no override given) — fall through
    // to SELECT key_r2.
    nextResults.push({ rows: [{ key_r2: 's/sub/v/v/a/att/file.png' }], rowCount: 1 })
    // Second withTenant performs the DELETE.
    nextResults.push({ rows: [], rowCount: 1 })

    await handleR2Gc({
      data: { subscriptionId: SUB, attachmentId: ATT },
    } as unknown as Parameters<typeof handleR2Gc>[0])

    // R2 delete was called with the looked-up key.
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(deleteObject).toHaveBeenCalledWith('s/sub/v/v/a/att/file.png')

    // Order: key SELECT → R2 delete (no DB) → row DELETE.
    expect(queries.map((q) => q.text)[0]).toMatch(/SELECT key_r2 FROM attachments/)
    expect(queries.map((q) => q.text)[1]).toMatch(/DELETE FROM attachments/)
  })

  it('uses the producer-supplied keyR2 to skip the lookup', async () => {
    const { handleR2Gc } = await import('../src/handlers/r2-gc.js')
    // First withTenant: keyOverride present → no SELECT.
    // Second withTenant: DELETE.
    nextResults.push({ rows: [], rowCount: 1 })

    await handleR2Gc({
      data: {
        subscriptionId: SUB,
        attachmentId: ATT,
        keyR2: 'pre/supplied/key',
      },
    } as unknown as Parameters<typeof handleR2Gc>[0])

    expect(deleteObject).toHaveBeenCalledWith('pre/supplied/key')
    // Only the DELETE was issued — no SELECT key_r2.
    expect(queries.find((q) => q.text.startsWith('SELECT key_r2'))).toBeUndefined()
    expect(queries.find((q) => q.text.startsWith('DELETE FROM attachments'))).toBeTruthy()
  })
})

describe('handleR2Gc — unverified-sweep mode', () => {
  it('deletes every unverified attachment older than the grace window', async () => {
    const { handleR2Gc } = await import('../src/handlers/r2-gc.js')

    const A_ID = '33333333-3333-3333-3333-333333333333'
    const B_ID = '44444444-4444-4444-4444-444444444444'

    // 1. The sweep SELECT.
    nextResults.push({
      rows: [
        { id: A_ID, key_r2: 'key-a' },
        { id: B_ID, key_r2: 'key-b' },
      ],
      rowCount: 2,
    })
    // 2. For each row: deleteOne does (a) no SELECT (key supplied) and (b) DELETE.
    nextResults.push({ rows: [], rowCount: 1 })
    nextResults.push({ rows: [], rowCount: 1 })

    await handleR2Gc({
      data: {
        subscriptionId: SUB,
        attachmentId: '',
        mode: 'unverified-sweep',
      },
    } as unknown as Parameters<typeof handleR2Gc>[0])

    expect(deleteObject).toHaveBeenCalledTimes(2)
    expect(deleteObject).toHaveBeenNthCalledWith(1, 'key-a')
    expect(deleteObject).toHaveBeenNthCalledWith(2, 'key-b')

    const deletes = queries.filter((q) =>
      q.text.startsWith('DELETE FROM attachments'),
    )
    expect(deletes).toHaveLength(2)
    expect(deletes[0]!.values).toEqual([A_ID])
    expect(deletes[1]!.values).toEqual([B_ID])
  })
})
