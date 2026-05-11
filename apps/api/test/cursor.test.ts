// Pure unit tests for the opaque pagination cursor used by GET /notes.
// The encoded cursor is base64url JSON; consumers only ever round-trip it.
// We assert: round-trip identity, rejection of garbage input, rejection of
// payloads that don't carry both `modifiedAt` (ISO-8601) and `id` (UUID).

import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../src/lib/cursor.js'
import { HttpError } from '../src/lib/errors.js'

const SAMPLE_UUID = '11111111-1111-4111-8111-111111111111'

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a valid cursor', () => {
    const c = { modifiedAt: '2026-05-10T12:00:00.000Z', id: SAMPLE_UUID }
    const enc = encodeCursor(c)
    // base64url has no `+`, `/`, or `=` padding.
    expect(enc).not.toMatch(/[+/=]/)
    expect(decodeCursor(enc)).toEqual(c)
  })

  it('encodes deterministically for stable wire output', () => {
    const c = { modifiedAt: '2026-01-01T00:00:00.000Z', id: SAMPLE_UUID }
    expect(encodeCursor(c)).toEqual(encodeCursor(c))
  })

  it('rejects an unparseable string with InvalidInput', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(HttpError)
    try {
      decodeCursor('not-base64-not-json')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).status).toBe(400)
      expect((err as HttpError).code).toBe('invalid_input')
    }
  })

  it('rejects valid base64url that is not a JSON object', () => {
    const notObject = Buffer.from('"hello"', 'utf8').toString('base64url')
    expect(() => decodeCursor(notObject)).toThrow(HttpError)
  })

  it('rejects a payload missing modifiedAt', () => {
    const bad = Buffer.from(JSON.stringify({ id: SAMPLE_UUID }), 'utf8').toString(
      'base64url',
    )
    expect(() => decodeCursor(bad)).toThrow(HttpError)
  })

  it('rejects a payload missing id', () => {
    const bad = Buffer.from(
      JSON.stringify({ modifiedAt: '2026-05-10T12:00:00.000Z' }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(HttpError)
  })

  it('rejects a payload whose modifiedAt is not a parseable date', () => {
    const bad = Buffer.from(
      JSON.stringify({ modifiedAt: 'not-a-date', id: SAMPLE_UUID }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(HttpError)
  })

  it('rejects a payload whose id is not a UUID', () => {
    const bad = Buffer.from(
      JSON.stringify({ modifiedAt: '2026-05-10T12:00:00.000Z', id: 'not-uuid' }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(HttpError)
  })

  it('rejects a payload with non-string fields', () => {
    const bad = Buffer.from(
      JSON.stringify({ modifiedAt: 1234, id: SAMPLE_UUID }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(HttpError)
  })
})
