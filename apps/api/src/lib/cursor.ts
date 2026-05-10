// Opaque pagination cursor for note listings.
// Encodes (modifiedAt, id) as base64url JSON. The shape is intentionally
// not exposed in the API surface — callers only ever round-trip the string.

import { InvalidInput } from './errors.js'

export interface NoteCursor {
  modifiedAt: string  // ISO-8601
  id: string          // uuid
}

export function encodeCursor(c: NoteCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): NoteCursor {
  let parsed: unknown
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    throw InvalidInput('invalid cursor')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { modifiedAt?: unknown }).modifiedAt !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    throw InvalidInput('invalid cursor')
  }
  const c = parsed as NoteCursor
  // Validate the fields look like what we wrote.
  if (Number.isNaN(Date.parse(c.modifiedAt))) throw InvalidInput('invalid cursor')
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.id)
  )
    throw InvalidInput('invalid cursor')
  return c
}
