// Contract test for the API error envelope.
// The SPA reads `{ error: { code, message, details } }`; if this shape
// changes, every error path in the SPA needs updating. We pin the shape
// per HttpError subclass by driving each one through a tiny Hono app.

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  Conflict,
  Forbidden,
  InvalidInput,
  NotFound,
  RateLimited,
  Unauthenticated,
  UpstreamUnavailable,
} from '../src/lib/errors.js'
import { errorHandler } from '../src/middleware/error-handler.js'

function buildApp() {
  const app = new Hono()
  app.onError(errorHandler)
  app.get('/unauthenticated', () => {
    throw Unauthenticated('please sign in')
  })
  app.get('/forbidden', () => {
    throw Forbidden('not allowed')
  })
  app.get('/not_found', () => {
    throw NotFound('gone')
  })
  app.get('/conflict', () => {
    throw Conflict('duplicate', { field: 'email' })
  })
  app.get('/invalid_input', () => {
    throw InvalidInput('bad shape', { issues: ['x'] })
  })
  app.get('/rate_limited', () => {
    throw RateLimited('slow down')
  })
  app.get('/upstream_unavailable', () => {
    throw UpstreamUnavailable('litellm down')
  })
  app.get('/internal', () => {
    throw new Error('boom')
  })
  return app
}

describe('error envelope', () => {
  it('401 unauthenticated', async () => {
    const res = await buildApp().request('/unauthenticated')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body).toEqual({
      error: { code: 'unauthenticated', message: 'please sign in' },
    })
  })

  it('403 forbidden', async () => {
    const res = await buildApp().request('/forbidden')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('forbidden')
  })

  it('404 not_found', async () => {
    const res = await buildApp().request('/not_found')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('gone')
  })

  it('409 conflict carries the details object', async () => {
    const res = await buildApp().request('/conflict')
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { field: string } }
    }
    expect(body.error.code).toBe('conflict')
    expect(body.error.details).toEqual({ field: 'email' })
  })

  it('400 invalid_input carries the details object', async () => {
    const res = await buildApp().request('/invalid_input')
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details?: { issues: string[] } }
    }
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.details).toEqual({ issues: ['x'] })
  })

  it('429 rate_limited', async () => {
    const res = await buildApp().request('/rate_limited')
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('rate_limited')
  })

  it('502 upstream_unavailable', async () => {
    const res = await buildApp().request('/upstream_unavailable')
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('upstream_unavailable')
  })

  it('500 internal masks the message from non-HttpError throws', async () => {
    const res = await buildApp().request('/internal')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('internal')
    // Internal error messages must not leak the underlying exception text.
    expect(body.error.message).toBe('Internal server error')
    expect(JSON.stringify(body)).not.toContain('boom')
  })

  it('omits details when the caller did not supply any', async () => {
    const res = await buildApp().request('/not_found')
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown }
    }
    // The envelope intentionally drops `details` when undefined so the SPA
    // can branch on presence rather than parse `null`.
    expect(body.error.details).toBeUndefined()
  })
})
