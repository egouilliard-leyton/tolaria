// Pure unit tests for slug helpers.
//
// `slugify` is deterministic and synchronous; `ensureUniqueSlug` takes an
// async predicate so the collision-disambiguation loop is testable with a
// plain Set.

import { describe, expect, it } from 'vitest'
import { ensureUniqueSlug, slugify } from '../src/lib/slug.js'

describe('slugify', () => {
  it('lower-cases and joins words with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world')
    expect(slugify('My Big Note')).toBe('my-big-note')
  })

  it('folds non-ASCII Unicode (accents, ligatures) into ASCII', () => {
    expect(slugify('café')).toBe('cafe')
    expect(slugify('naïve résumé')).toBe('naive-resume')
  })

  it('collapses repeated separators and trims edges', () => {
    expect(slugify('  hello   world  ')).toBe('hello-world')
    expect(slugify('--hello--world--')).toBe('hello-world')
    expect(slugify('hello!!!  ??? world')).toBe('hello-world')
  })

  it('falls back to "note" for empty / whitespace-only / pure-symbol input', () => {
    expect(slugify('')).toBe('note')
    expect(slugify('   ')).toBe('note')
    expect(slugify('???!!!')).toBe('note')
  })

  it('reserves a handful of top-level paths and suffixes "-note"', () => {
    // _new / new / admin / api / auth are reserved.
    expect(slugify('admin')).toBe('admin-note')
    expect(slugify('API')).toBe('api-note')
    expect(slugify('Auth')).toBe('auth-note')
    expect(slugify('new')).toBe('new-note')
    expect(slugify('_new')).toBe('new-note')
  })

  it('clips overlong inputs at 200 characters', () => {
    const long = 'a'.repeat(500)
    const out = slugify(long)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).toMatch(/^a+$/)
  })

  it('preserves digits in slug', () => {
    expect(slugify('Note 42 Title')).toBe('note-42-title')
    expect(slugify('2026 plans')).toBe('2026-plans')
  })
})

describe('ensureUniqueSlug', () => {
  it('returns the base slug when it is free', async () => {
    const taken = new Set<string>()
    const result = await ensureUniqueSlug('hello', async (s) => taken.has(s))
    expect(result).toBe('hello')
  })

  it('appends -2, -3, … until it finds a free slug', async () => {
    const taken = new Set<string>(['hello', 'hello-2', 'hello-3'])
    const result = await ensureUniqueSlug('hello', async (s) => taken.has(s))
    expect(result).toBe('hello-4')
  })

  it('only probes the disambiguators it needs', async () => {
    const probes: string[] = []
    const taken = new Set(['hello'])
    const result = await ensureUniqueSlug('hello', async (s) => {
      probes.push(s)
      return taken.has(s)
    })
    expect(result).toBe('hello-2')
    // Base + first disambiguator.
    expect(probes).toEqual(['hello', 'hello-2'])
  })

  it('throws after 1000 collisions (safety bound)', async () => {
    // Pre-populate `hello` and every disambiguator up to -999.
    const taken = new Set<string>(['hello'])
    for (let i = 2; i < 1000; i++) taken.add(`hello-${i}`)
    await expect(
      ensureUniqueSlug('hello', async (s) => taken.has(s)),
    ).rejects.toThrow(/unique slug/i)
  })
})
