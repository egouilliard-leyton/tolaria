// Slug normalisation — duplicated from `apps/api/src/lib/slug.ts` so the
// worker does not need a deep cross-package import (the API package does
// not expose subpath `exports`). The two copies MUST stay in lock-step
// with each other: any change to the kebab-case rules over there has to
// be ported here, otherwise the worker's `note_links` resolution will
// disagree with the route's slug allocation and break wikilink graph
// consistency.

const RESERVED = new Set(['_new', 'new', 'admin', 'api', 'auth'])

export function slugify(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')

  if (!folded) return 'note'
  if (RESERVED.has(folded)) return `${folded}-note`
  return folded.slice(0, 200)
}
