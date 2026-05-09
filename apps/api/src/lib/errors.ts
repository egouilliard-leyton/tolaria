// Domain errors carry an HTTP status and a stable code so the SPA can branch
// on them without parsing messages. The error handler middleware turns these
// into JSON responses; anything else becomes a 500.

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_input'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'internal'

export class HttpError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const Unauthenticated = (msg = 'Authentication required') =>
  new HttpError(401, 'unauthenticated', msg)
export const Forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg)
export const NotFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg)
export const Conflict = (msg = 'Conflict', details?: unknown) =>
  new HttpError(409, 'conflict', msg, details)
export const InvalidInput = (msg = 'Invalid input', details?: unknown) =>
  new HttpError(400, 'invalid_input', msg, details)
export const RateLimited = (msg = 'Rate limited') => new HttpError(429, 'rate_limited', msg)
export const UpstreamUnavailable = (msg = 'Upstream unavailable') =>
  new HttpError(502, 'upstream_unavailable', msg)
