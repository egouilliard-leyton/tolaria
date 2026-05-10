// /vaults/:vaultId/search?q=&mode=full|prefix&limit=
//
// `full` mode hits the gin-indexed tsvector on note_search.ts_doc and uses
// websearch_to_tsquery so callers can pass quoted phrases / -negation.
// `prefix` mode does a fast pg_trgm-backed ILIKE on title + slug and is what
// the quick-open palette uses while the user is still typing.

import { Hono } from 'hono'
import { withTenant } from '../db.js'
import { SearchQuery, VaultIdRouteParam } from '../lib/schemas.js'
import { readParams, readQuery } from '../lib/validate.js'
import { assertVaultExists } from './vaults.js'

// Wire shape: snake_case per the SPA's HttpVaultAdapter.search (see
// SearchResultDto + SearchResponseDto in src/lib/vault-adapter/http-adapter.ts).
interface SearchResult {
  note_id: string
  title: string
  snippet: string
  score: number
}

interface SearchResponse {
  results: SearchResult[]
  query: string
  mode: 'full' | 'prefix'
  elapsed_ms: number
}

export const search = new Hono()

search.get('/vaults/:vaultId/search', async (c) => {
  const { vaultId } = readParams(c, VaultIdRouteParam)
  const q = readQuery(c, SearchQuery)
  const tenant = c.get('tenant')

  const start = Date.now()
  const rows = await withTenant(tenant, async (client) => {
    await assertVaultExists(client, vaultId)
    if (q.mode === 'prefix') {
      return runPrefix(client, vaultId, q.q, q.limit)
    }
    return runFull(client, vaultId, q.q, q.limit)
  })

  const response: SearchResponse = {
    results: rows,
    query: q.q,
    mode: q.mode,
    elapsed_ms: Date.now() - start,
  }
  return c.json(response)
})

interface ClientLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[] }>
}

async function runFull(
  client: ClientLike,
  vaultId: string,
  q: string,
  limit: number,
): Promise<SearchResult[]> {
  // We rely on the worker-maintained note_search.ts_doc, but if the indexer
  // has not caught up yet the row may be missing — fall back to computing
  // ts_doc on the fly for those notes. The fallback uses the same simple
  // dictionary so ranking stays comparable.
  const { rows } = await client.query<{
    note_id: string
    title: string
    snippet: string
    score: string | number
  }>(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $2) AS tsq)
     SELECT n.id AS note_id,
            n.title,
            ts_headline(
              'simple',
              n.body_md,
              q.tsq,
              'MaxWords=20, MinWords=5, ShortWord=3, MaxFragments=2'
            ) AS snippet,
            ts_rank(
              COALESCE(s.ts_doc,
                       to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.body_md, ''))),
              q.tsq
            ) AS score
       FROM notes n
       CROSS JOIN q
       LEFT JOIN note_search s ON s.note_id = n.id
      WHERE n.vault_id = $1
        AND n.deleted_at IS NULL
        AND COALESCE(s.ts_doc,
                     to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.body_md, '')))
            @@ q.tsq
      ORDER BY score DESC, n.modified_at DESC
      LIMIT $3`,
    [vaultId, q, limit],
  )
  return rows.map((r) => ({
    note_id: r.note_id,
    title: r.title,
    snippet: r.snippet,
    score: typeof r.score === 'number' ? r.score : Number(r.score),
  }))
}

async function runPrefix(
  client: ClientLike,
  vaultId: string,
  q: string,
  limit: number,
): Promise<SearchResult[]> {
  // Quick-open semantics: rank by trigram similarity on the title; fall back
  // to a slug match so users typing the canonical id still hit the note.
  const { rows } = await client.query<{
    note_id: string
    title: string
    body_md: string
    score: string | number
  }>(
    `SELECT n.id AS note_id,
            n.title,
            n.body_md,
            GREATEST(
              similarity(n.title, $2),
              similarity(n.slug, $2),
              CASE WHEN n.title ILIKE $2 || '%' OR n.slug ILIKE $2 || '%'
                   THEN 1.0 ELSE 0.0 END
            ) AS score
       FROM notes n
      WHERE n.vault_id = $1
        AND n.deleted_at IS NULL
        AND (n.title ILIKE $2 || '%'
             OR n.slug ILIKE $2 || '%'
             OR n.title % $2
             OR n.slug % $2)
      ORDER BY score DESC, n.modified_at DESC
      LIMIT $3`,
    [vaultId, q, limit],
  )
  return rows.map((r) => ({
    note_id: r.note_id,
    title: r.title,
    snippet: makeSnippet(r.body_md ?? '', q),
    score: typeof r.score === 'number' ? r.score : Number(r.score),
  }))
}

function makeSnippet(body: string, q: string): string {
  if (!body) return ''
  const idx = body.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return body.slice(0, 120)
  const start = Math.max(0, idx - 40)
  const end = Math.min(body.length, idx + q.length + 80)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < body.length ? '…' : ''
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix
}
