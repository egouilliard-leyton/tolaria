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
  pool: {} as unknown,
}))

afterEach(() => {
  queries.length = 0
  nextResults = []
  fakeClient.query.mockClear()
})

const SUB = '11111111-1111-1111-1111-111111111111'
const VAULT = '22222222-2222-2222-2222-222222222222'
const NOTE = '33333333-3333-3333-3333-333333333333'
const DST = '44444444-4444-4444-4444-444444444444'

describe('handleIndexNote', () => {
  it('upserts ts_doc and rebuilds note_links from wikilinks', async () => {
    const { handleIndexNote } = await import('../src/handlers/index-note.js')
    // First query returns the note row.
    nextResults.push({
      rows: [
        {
          id: NOTE,
          vault_id: VAULT,
          title: 'My note',
          body_md: 'See [[Other Note]] and [[other-note|alias]] for context.',
        },
      ],
      rowCount: 1,
    })
    // upsert into note_search → no rows back.
    nextResults.push({ rows: [], rowCount: 1 })
    // delete from note_links.
    nextResults.push({ rows: [], rowCount: 0 })
    // First wikilink: SELECT to resolve dst.
    nextResults.push({ rows: [{ id: DST }], rowCount: 1 })
    // First wikilink: INSERT into note_links.
    nextResults.push({ rows: [], rowCount: 1 })
    // We deduplicated on the dst_text — but two distinct dst_text values
    // ("Other Note" and "other-note") should both fan out separately.
    // Second wikilink: SELECT to resolve dst.
    nextResults.push({ rows: [], rowCount: 0 })
    // Second wikilink: INSERT into note_links.
    nextResults.push({ rows: [], rowCount: 1 })

    await handleIndexNote({
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: NOTE,
    })

    // SELECT note → upsert ts_doc → DELETE links → 2 × (SELECT slug + INSERT link)
    const sqlList = queries.map((q) => q.text)
    expect(sqlList[0]).toMatch(/SELECT id, vault_id, title, body_md/)
    expect(sqlList[1]).toMatch(/INSERT INTO note_search/)
    expect(sqlList[1]).toMatch(/to_tsvector\('simple'/)
    expect(sqlList[2]).toMatch(/DELETE FROM note_links WHERE src_note_id/)

    // First insertion: dst_note_id = DST (resolved), dst_text = 'Other Note'.
    const insertCalls = queries.filter((q) =>
      q.text.startsWith('INSERT INTO note_links'),
    )
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]!.values[0]).toBe(NOTE)
    expect(insertCalls[0]!.values[1]).toBe(DST)
    expect(insertCalls[0]!.values[2]).toBe('Other Note')
    // Second insertion: dst_note_id = null (not resolved), dst_text = 'other-note'.
    expect(insertCalls[1]!.values[1]).toBeNull()
    expect(insertCalls[1]!.values[2]).toBe('other-note')
  })

  it('cleans up note_search + note_links when the note is soft-deleted', async () => {
    // Bundle L (G67): a soft-deleted note must have its derived rows
    // removed so stale `note_search` entries cannot keep returning hits
    // and so outgoing wikilinks from the deleted source do not keep
    // pointing at it.
    const { handleIndexNote } = await import('../src/handlers/index-note.js')
    // 1) SELECT note returns no rows (deleted or never existed).
    nextResults.push({ rows: [], rowCount: 0 })
    // 2) DELETE FROM note_search.
    nextResults.push({ rows: [], rowCount: 1 })
    // 3) DELETE FROM note_links.
    nextResults.push({ rows: [], rowCount: 0 })

    await handleIndexNote({
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: NOTE,
    })

    expect(queries).toHaveLength(3)
    expect(queries[0]!.text).toMatch(/SELECT id, vault_id, title, body_md/)
    expect(queries[1]!.text).toMatch(/DELETE FROM note_search WHERE note_id/)
    expect(queries[1]!.values[0]).toBe(NOTE)
    expect(queries[2]!.text).toMatch(/DELETE FROM note_links WHERE src_note_id/)
    expect(queries[2]!.values[0]).toBe(NOTE)
  })

  it('skips link rebuild when body has no wikilinks but still upserts ts_doc', async () => {
    const { handleIndexNote } = await import('../src/handlers/index-note.js')
    nextResults.push({
      rows: [
        { id: NOTE, vault_id: VAULT, title: 't', body_md: 'plain prose, nothing' },
      ],
      rowCount: 1,
    })
    nextResults.push({ rows: [], rowCount: 1 })
    nextResults.push({ rows: [], rowCount: 0 })

    await handleIndexNote({
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: NOTE,
    })

    expect(queries.map((q) => q.text)[2]).toMatch(/DELETE FROM note_links/)
    // No INSERT INTO note_links calls.
    expect(queries.find((q) => q.text.startsWith('INSERT INTO note_links'))).toBeUndefined()
  })
})

describe('parseWikilinks', () => {
  it('handles bare and aliased forms, and trims whitespace', async () => {
    const { parseWikilinks } = await import('../src/handlers/index-note.js')
    expect(parseWikilinks('See [[a]] and [[b|alias]] and [[ c ]]')).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('returns [] for plain text', async () => {
    const { parseWikilinks } = await import('../src/handlers/index-note.js')
    expect(parseWikilinks('nothing here')).toEqual([])
  })
})
