import type { Context } from 'hono'
import { HttpError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

export async function errorHandler(err: Error, c: Context): Promise<Response> {
  if (err instanceof HttpError) {
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
