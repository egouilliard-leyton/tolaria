// Unit tests for the OIDC discovery validator. We hand in a stubbed
// `fetcher` so there is no real network. Surfaces every failure mode the
// `POST /admin/sso/providers` route depends on:
//   - syntactically bad issuer URL
//   - non-http(s) protocol
//   - trailing-slash normalization
//   - timeout via AbortSignal
//   - non-200 response
//   - response body that is not valid JSON
//   - response that is JSON but missing a required field
//   - happy path

import { describe, expect, it } from 'vitest'
import { fetchDiscoveryDocument } from '../src/lib/discovery-fetcher.js'
import { HttpError } from '../src/lib/errors.js'

const HAPPY_BODY = {
  issuer: 'https://issuer.example',
  authorization_endpoint: 'https://issuer.example/auth',
  token_endpoint: 'https://issuer.example/token',
  jwks_uri: 'https://issuer.example/jwks',
  userinfo_endpoint: 'https://issuer.example/userinfo',
  end_session_endpoint: 'https://issuer.example/logout',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchDiscoveryDocument', () => {
  it('rejects an unparseable issuer URL with invalid_input', async () => {
    const fetcher: typeof fetch = async () => new Response('{}', { status: 200 })
    await expect(
      fetchDiscoveryDocument('not-a-url', { fetcher }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_input',
    })
  })

  it('rejects a non-http(s) protocol', async () => {
    const fetcher: typeof fetch = async () => new Response('{}', { status: 200 })
    await expect(
      fetchDiscoveryDocument('ftp://issuer.example', { fetcher }),
    ).rejects.toBeInstanceOf(HttpError)
  })

  it('strips trailing slash before building the discovery URL', async () => {
    const seen: string[] = []
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input))
      return jsonResponse(HAPPY_BODY)
    }
    await fetchDiscoveryDocument('https://issuer.example/', { fetcher })
    expect(seen).toEqual(['https://issuer.example/.well-known/openid-configuration'])
  })

  it('surfaces timeouts as invalid_input', async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Real fetch rejects with an AbortError when the signal aborts.
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    await expect(
      fetchDiscoveryDocument('https://issuer.example', {
        fetcher,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' })
  })

  it('rejects a non-200 response', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('not found', { status: 404 })
    await expect(
      fetchDiscoveryDocument('https://issuer.example', { fetcher }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' })
  })

  it('rejects a response that is not valid JSON', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    await expect(
      fetchDiscoveryDocument('https://issuer.example', { fetcher }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' })
  })

  it('rejects a JSON object missing required fields', async () => {
    const fetcher: typeof fetch = async () =>
      jsonResponse({
        issuer: 'https://issuer.example',
        // missing authorization_endpoint
        token_endpoint: 'https://issuer.example/token',
        jwks_uri: 'https://issuer.example/jwks',
      })
    await expect(
      fetchDiscoveryDocument('https://issuer.example', { fetcher }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' })
  })

  it('rejects when the response is JSON but not an object (e.g. an array)', async () => {
    const fetcher: typeof fetch = async () => jsonResponse([])
    await expect(
      fetchDiscoveryDocument('https://issuer.example', { fetcher }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' })
  })

  it('returns a normalised DiscoveryDocument on the happy path', async () => {
    const fetcher: typeof fetch = async () => jsonResponse(HAPPY_BODY)
    const doc = await fetchDiscoveryDocument('https://issuer.example', { fetcher })
    expect(doc).toEqual({
      issuer: 'https://issuer.example',
      authorization_endpoint: 'https://issuer.example/auth',
      token_endpoint: 'https://issuer.example/token',
      jwks_uri: 'https://issuer.example/jwks',
      userinfo_endpoint: 'https://issuer.example/userinfo',
      end_session_endpoint: 'https://issuer.example/logout',
    })
  })

  it('falls back to the (normalised) issuer URL when the response omits issuer', async () => {
    const fetcher: typeof fetch = async () =>
      jsonResponse({
        authorization_endpoint: 'https://issuer.example/auth',
        token_endpoint: 'https://issuer.example/token',
        jwks_uri: 'https://issuer.example/jwks',
      })
    const doc = await fetchDiscoveryDocument('https://issuer.example/', { fetcher })
    expect(doc.issuer).toBe('https://issuer.example')
  })
})
