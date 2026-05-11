// Slug normalisation. Kebab-case, ASCII-folded, no accidental
// double-hyphens or leading/trailing dashes. Used both when a caller does
// not supply an explicit slug and when validating one they did.

const RESERVED = new Set([
  // Anything we might want to expose as a top-level path later. Cheap insurance.
  '_new',
  'new',
  'admin',
  'api',
  'auth',
])

/**
 * Convert an arbitrary string into a kebab-case slug.
 *
 * - Unicode is folded via NFKD then stripped of combining marks.
 * - Anything that isn't `[a-z0-9-]` becomes a single `-`.
 * - Repeated hyphens collapse and edge hyphens are trimmed.
 * - Empty results fall back to `note` so we never return ''.
 */
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

/**
 * Append `-2`, `-3`, … to `base` until `isTaken(candidate)` returns false.
 * Bounded so we don't spin forever on a misbehaving check.
 */
export async function ensureUniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(base))) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!(await isTaken(candidate))) return candidate
  }
  // Extremely unlikely; surface as a server error so we notice.
  throw new Error('could not find a unique slug after 1000 attempts')
}
