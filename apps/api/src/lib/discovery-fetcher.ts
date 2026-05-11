// OIDC discovery validator. Given an issuer URL, fetches
// `${issuer}/.well-known/openid-configuration` and ensures the response is a
// JSON document with the three endpoints we actually use server-side
// (authorization, token, jwks). We do NOT attempt to validate the full set of
// OIDC discovery fields — `openid-client` will do that at runtime when we
// initiate the auth flow. The point here is to fail fast on `POST
// /admin/sso/providers` so an owner cannot save a provider that obviously
// will not work.
//
// See ADR-0117. Throws `InvalidInput` (400) on any failure mode.

import { InvalidInput } from './errors.js'

export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

const DISCOVERY_TIMEOUT_MS = 5_000

export interface FetchOptions {
  /** Override `fetch` for testing. Defaults to global `fetch`. */
  fetcher?: typeof fetch
  /** Override the timeout (ms). */
  timeoutMs?: number
}

/**
 * Fetch and minimally validate the OIDC discovery document for `issuerUrl`.
 *
 * Throws `InvalidInput` if:
 *   - `issuerUrl` is not a syntactically valid http(s) URL
 *   - the discovery document does not return HTTP 200
 *   - the response is not JSON
 *   - any of `authorization_endpoint`, `token_endpoint`, `jwks_uri` are missing
 */
export async function fetchDiscoveryDocument(
  issuerUrl: string,
  opts: FetchOptions = {},
): Promise<DiscoveryDocument> {
  const normalized = normalizeIssuerUrl(issuerUrl)
  const discoveryUrl = `${normalized}/.well-known/openid-configuration`

  const fetcher = opts.fetcher ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetcher(discoveryUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (err) {
    throw InvalidInput(`OIDC discovery request failed: ${(err as Error).message}`, {
      issuerUrl: normalized,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw InvalidInput(
      `OIDC discovery request returned HTTP ${response.status}`,
      { issuerUrl: normalized, status: response.status },
    )
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw InvalidInput('OIDC discovery response was not valid JSON', {
      issuerUrl: normalized,
    })
  }

  return validateDiscoveryDocument(raw, normalized)
}

function normalizeIssuerUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw InvalidInput('issuerUrl must be a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw InvalidInput('issuerUrl must use http or https')
  }
  // Strip trailing slash so we always produce ${issuer}/.well-known/...
  let s = parsed.toString()
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function validateDiscoveryDocument(raw: unknown, issuerUrl: string): DiscoveryDocument {
  if (!raw || typeof raw !== 'object') {
    throw InvalidInput('OIDC discovery response was not a JSON object', { issuerUrl })
  }
  const obj = raw as Record<string, unknown>

  const required = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const
  const missing: string[] = []
  for (const field of required) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      missing.push(field)
    }
  }
  if (missing.length > 0) {
    throw InvalidInput(
      `OIDC discovery document is missing required fields: ${missing.join(', ')}`,
      { issuerUrl, missing },
    )
  }

  return {
    issuer: typeof obj.issuer === 'string' ? obj.issuer : issuerUrl,
    authorization_endpoint: obj.authorization_endpoint as string,
    token_endpoint: obj.token_endpoint as string,
    jwks_uri: obj.jwks_uri as string,
    userinfo_endpoint: typeof obj.userinfo_endpoint === 'string' ? obj.userinfo_endpoint : undefined,
    end_session_endpoint:
      typeof obj.end_session_endpoint === 'string' ? obj.end_session_endpoint : undefined,
  }
}
