// Pure unit tests for the row→DTO mappers. These functions ARE the wire
// contract surfaced on /vaults/*, /folders/*, /notes/*, /search, /rename.
// Anything that changes shape here will break the SPA's HttpVaultAdapter.

import { describe, expect, it } from 'vitest'
import {
  toFolder,
  toNote,
  toNoteSummary,
  toVault,
  wordCount,
} from '../src/lib/mappers.js'

const VAULT_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER_ID = '22222222-2222-4222-8222-222222222222'
const NOTE_ID = '33333333-3333-4333-8333-333333333333'

describe('toVault', () => {
  it('converts Date timestamps to ISO strings', () => {
    const dto = toVault({
      id: VAULT_ID,
      slug: 'work',
      name: 'Work',
      created_at: new Date('2026-05-10T12:00:00.000Z'),
      settings: { theme: 'dark' },
    })
    expect(dto).toEqual({
      id: VAULT_ID,
      slug: 'work',
      name: 'Work',
      created_at: '2026-05-10T12:00:00.000Z',
      settings: { theme: 'dark' },
    })
  })

  it('accepts string timestamps and normalises them', () => {
    const dto = toVault({
      id: VAULT_ID,
      slug: 'work',
      name: 'Work',
      created_at: '2026-05-10T12:00:00Z',
      settings: {},
    })
    expect(dto.created_at).toBe('2026-05-10T12:00:00.000Z')
  })

  it('defaults a null settings column to an empty object', () => {
    const dto = toVault({
      id: VAULT_ID,
      slug: 'work',
      name: 'Work',
      created_at: new Date('2026-05-10T12:00:00.000Z'),
      // settings can come back as null from pg if the column was never written.
      settings: null as unknown as Record<string, unknown>,
    })
    expect(dto.settings).toEqual({})
  })
})

describe('toFolder', () => {
  it('preserves parent_id null without coercing to undefined', () => {
    const dto = toFolder({
      id: FOLDER_ID,
      vault_id: VAULT_ID,
      parent_id: null,
      name: 'Inbox',
      position: 0,
      updated_at: new Date('2026-05-10T12:00:00.000Z'),
    })
    expect(dto.parent_id).toBeNull()
    expect(dto.updated_at).toBe('2026-05-10T12:00:00.000Z')
  })
})

describe('toNoteSummary / toNote', () => {
  it('summary contains exactly the listing fields', () => {
    const dto = toNoteSummary({
      id: NOTE_ID,
      vault_id: VAULT_ID,
      folder_id: null,
      slug: 'hello',
      title: 'Hello',
      modified_at: new Date('2026-05-10T12:00:00.000Z'),
      word_count: 1,
    })
    expect(dto).toEqual({
      id: NOTE_ID,
      vault_id: VAULT_ID,
      folder_id: null,
      slug: 'hello',
      title: 'Hello',
      modified_at: '2026-05-10T12:00:00.000Z',
      word_count: 1,
    })
    // No body / frontmatter / version leak.
    expect(dto).not.toHaveProperty('body_md')
    expect(dto).not.toHaveProperty('frontmatter')
    expect(dto).not.toHaveProperty('version')
  })

  it('full DTO extends summary with body / frontmatter / version / created_at', () => {
    const dto = toNote({
      id: NOTE_ID,
      vault_id: VAULT_ID,
      folder_id: FOLDER_ID,
      slug: 'hello',
      title: 'Hello',
      modified_at: new Date('2026-05-10T12:00:00.000Z'),
      word_count: 3,
      body_md: 'Hello world!',
      frontmatter: { tags: ['x'] },
      version: 7,
      created_at: new Date('2026-05-01T00:00:00.000Z'),
    })
    expect(dto.body_md).toBe('Hello world!')
    expect(dto.frontmatter).toEqual({ tags: ['x'] })
    expect(dto.version).toBe(7)
    expect(dto.created_at).toBe('2026-05-01T00:00:00.000Z')
  })

  it('defaults frontmatter null to {}', () => {
    const dto = toNote({
      id: NOTE_ID,
      vault_id: VAULT_ID,
      folder_id: null,
      slug: 'h',
      title: 'H',
      modified_at: new Date('2026-05-10T12:00:00.000Z'),
      word_count: 0,
      body_md: '',
      // pg can return null for jsonb columns when never written.
      frontmatter: null as unknown as Record<string, unknown>,
      version: 1,
      created_at: new Date('2026-05-10T12:00:00.000Z'),
    })
    expect(dto.frontmatter).toEqual({})
  })
})

describe('wordCount', () => {
  it('returns 0 for empty input', () => {
    expect(wordCount('')).toBe(0)
  })

  it('counts plain words separated by whitespace', () => {
    expect(wordCount('one two three')).toBe(3)
    expect(wordCount('  one   two   three  ')).toBe(3)
  })

  it('counts Unicode words (accents, CJK, hyphenated)', () => {
    expect(wordCount('café résumé')).toBe(2)
    expect(wordCount('multi-word hyphen')).toBe(2)
  })

  it('does not count words inside fenced code blocks', () => {
    const md = 'one two\n\n```\nfoo bar baz\n```\n\nthree'
    expect(wordCount(md)).toBe(3)
  })

  it('does not count words inside inline code spans', () => {
    expect(wordCount('hello `world inline` again')).toBe(2)
  })

  it('counts digits-only tokens as words', () => {
    expect(wordCount('42 plans for 2026')).toBe(4)
  })
})
