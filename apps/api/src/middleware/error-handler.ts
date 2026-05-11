import type { Context } from 'hono'
import { HttpError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

export async function errorHandler(err: Error, c: Context): Promise<Response> {
  if (err instanceof HttpError) {
    // RFC 7235 §4.1: a 401 response MUST include a `WWW-Authenticate` header
    // so clients (and curl, and HTTP linters) know which scheme/realm is in
    // play. We don't actually do RFC challenges — the SPA uses bearer tokens
    // — but the header makes the response semantically correct and silences
    // a class of audit findings. See Bundle H §5.
    if (err.status === 401) {
      c.header('WWW-Authenticate', 'Bearer realm="tolaria"')
    }
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details ?? undefined } },
      err.status as 400 | 401 | 403 | 404 | 409 | 429 | 502,
    )
  }
  // Anything else is a programming error: log with stack, return generic 500.
  logger.error({ err }, 'unhandled error')
  return c.json(
    { error: { code: 'internal', message: 'Internal server error' } },
    500,
  )
}
