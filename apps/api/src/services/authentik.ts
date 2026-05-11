import * as oidc from 'openid-client'
import { loadEnv } from '../env.js'
import { logger } from '../lib/logger.js'
import { Unauthenticated, UpstreamUnavailable } from '../lib/errors.js'

// Thin wrapper around `openid-client` v6 that hides the small but easy-to-
// get-wrong details of an Authorization Code + PKCE flow against an Authentik
// (or any OIDC-compliant) Authorization Server. This module is invoked from
// `routes/auth.ts` for the platform-default provider; per-subscription
// providers are constructed by `services/sso-provider.ts`, which then calls
// these same primitives. See ADR-0117 §3 — PKCE only, no implicit/hybrid.

export interface ProviderConfigInput {
  issuerUrl: string
  clientId: string
  clientSecret: string
  scopes: readonly string[]
}

export interface AuthorizeStartResult {
  /** URL to redirect the user-agent to. */
  authorizationUrl: URL
  /** PKCE code_verifier — store in a short-lived signed cookie, never log. */
  codeVerifier: string
  /** Opaque state value — stash alongside the verifier and check on callback. */
  state: string
  /** Optional ID-Token nonce, returned for the callback to verify. */
  nonce: string
}

export interface NormalizedClaims {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
}

export interface CallbackResult {
  claims: NormalizedClaims
  /** Raw token response in case a caller needs the access_token (we currently don't). */
  raw: oidc.TokenEndpointResponse
}

/**
 * Build (or fetch from a tiny in-process cache) an `openid-client`
 * Configuration. Discovery is network-bound, so we cache per-issuer and
 * fall through cleanly if the discovery document is stale.
 *
 * The cache has a 10-minute TTL so that an Authentik (or other IdP) key
 * rotation does not silently break ID-token verification until the process
 * restarts — see ADR-0117 §Consequences and `docs/web-saas/verification-2026-05-09.md`
 * defect #7. We evict on TTL expiry only; failed re-fetches do not poison
 * the cache (the next caller will retry from scratch), and a stale-but-
 * still-within-TTL entry is preferred to a thundering herd of discoveries.
 */
const DISCOVERY_TTL_MS = 10 * 60 * 1000

interface CacheEntry {
  config: Promise<oidc.Configuration>
  fetchedAt: number
}

const configCache = new Map<string, CacheEntry>()

export async function getProviderConfig(input: ProviderConfigInput): Promise<oidc.Configuration> {
  const cacheKey = `${input.issuerUrl}|${input.clientId}`
  const cached = configCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt <= DISCOVERY_TTL_MS) {
    return cached.config
  }
  // Either no entry, or the existing one has aged out. Either way, refetch.
  // We hold off on evicting the stale entry until the new fetch resolves,
  // so a discovery failure leaves the previous (working) entry in place.
  const p = discover(input).catch((err) => {
    // Don't poison the cache with a failed discovery — drop only the in-flight
    // entry we just inserted. If a stale entry was present we leave it alone.
    const current = configCache.get(cacheKey)
    if (current && current.config === p) {
      configCache.delete(cacheKey)
    }
    throw err
  })
  configCache.set(cacheKey, { config: p, fetchedAt: Date.now() })
  return p
}

async function discover(input: ProviderConfigInput): Promise<oidc.Configuration> {
  try {
    return await oidc.discovery(
      new URL(input.issuerUrl),
      input.clientId,
      // Short-form: pass the client secret string and openid-client picks
      // ClientSecretPost by default.
      input.clientSecret,
    )
  } catch (err) {
    logger.error(
      { issuer: input.issuerUrl, errKind: (err as Error).name },
      'oidc discovery failed',
    )
    throw UpstreamUnavailable('OIDC discovery failed')
  }
}

/**
 * Build an authorization URL with PKCE. The caller is responsible for
 * persisting `codeVerifier`, `state`, and `nonce` so the callback can match
 * them. The state cookie should be signed and short-lived (~10 min).
 */
export async function buildAuthorizeStart(
  input: ProviderConfigInput,
  redirectUri: string,
): Promise<AuthorizeStartResult> {
  const config = await getProviderConfig(input)
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  const params: Record<string, string> = {
    redirect_uri: redirectUri,
    scope: input.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    response_type: 'code',
  }
  const authorizationUrl = oidc.buildAuthorizationUrl(config, params)
  return { authorizationUrl, codeVerifier, state, nonce }
}

/**
 * Exchange the authorization code at the callback URL for tokens, then
 * validate the ID token claims and project them onto our normalized shape.
 *
 * `currentUrl` should be the full request URL hitting our callback, including
 * the query string — `openid-client` parses it.
 */
export async function exchangeCallback(
  input: ProviderConfigInput,
  currentUrl: URL,
  expected: { state: string; codeVerifier: string; nonce: string },
): Promise<CallbackResult> {
  const config = await getProviderConfig(input)
  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      pkceCodeVerifier: expected.codeVerifier,
      idTokenExpected: true,
    })
  } catch (err) {
    logger.warn(
      { errKind: (err as Error).name },
      'oidc authorization_code grant rejected',
    )
    throw Unauthenticated('OIDC code exchange failed')
  }

  const claims = tokens.claims()
  if (!claims) {
    throw Unauthenticated('OIDC response missing ID token claims')
  }
  return { claims: normalize(claims), raw: tokens }
}

function normalize(claims: oidc.IDToken): NormalizedClaims {
  // `sub` is required by spec; openid-client would have rejected the token
  // already if it were missing, but we re-check defensively because the
  // value is about to anchor the `users.email + sub` JIT lookup.
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw Unauthenticated('OIDC ID token missing subject')
  }
  const email = readString(claims, 'email')
  if (!email) {
    throw Unauthenticated('OIDC provider must release an email claim')
  }
  return {
    sub: claims.sub,
    email: email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: readString(claims, 'name') ?? readString(claims, 'preferred_username') ?? null,
  }
}

function readString(claims: oidc.IDToken, key: string): string | null {
  const v = (claims as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

/**
 * Load the platform-default Authentik provider configuration straight from
 * env vars. This is *only* used when there is no `sso_providers` row at all
 * (first boot / smoke tests). The normal path resolves provider rows via
 * `services/sso-provider.ts` so the encrypted client secret column is the
 * source of truth.
 */
export function defaultAuthentikFromEnv(): ProviderConfigInput | null {
  const env = loadEnv()
  if (!env.AUTHENTIK_ISSUER_URL || !env.AUTHENTIK_CLIENT_ID || !env.AUTHENTIK_CLIENT_SECRET) {
    return null
  }
  return {
    issuerUrl: env.AUTHENTIK_ISSUER_URL,
    clientId: env.AUTHENTIK_CLIENT_ID,
    clientSecret: env.AUTHENTIK_CLIENT_SECRET,
    scopes: env.AUTHENTIK_DEFAULT_SCOPES.split(/\s+/).filter(Boolean),
  }
}

/**
 * Test-only override: stub the discovery cache with a pre-built Configuration
 * so unit tests don't have to talk to a real Authentik. Keyed exactly the same
 * way as production (`issuerUrl|clientId`).
 */
export function _setProviderConfigForTests(
  input: ProviderConfigInput,
  config: oidc.Configuration,
): void {
  const key = `${input.issuerUrl}|${input.clientId}`
  configCache.set(key, { config: Promise.resolve(config), fetchedAt: Date.now() })
}

export function _clearProviderConfigCacheForTests(): void {
  configCache.clear()
}

/**
 * Test-only: drop a single cache entry (or all entries when `input` is
 * omitted) so a TTL test can simulate the post-eviction refetch without
 * waiting wall-clock minutes. Production code paths must NOT call this.
 */
export function _invalidateDiscoveryCache(input?: ProviderConfigInput): void {
  if (!input) {
    configCache.clear()
    return
  }
  configCache.delete(`${input.issuerUrl}|${input.clientId}`)
}

// Auth flow note: this module is the OIDC half of plan §6 "Web auth flow".
// `routes/auth.ts` calls `buildAuthorizeStart` to issue the 302, stashes
// `codeVerifier+state+nonce` in a signed cookie, and on the callback hands
// the URL plus those expected values to `exchangeCallback`. The returned
// claims feed JIT provisioning + JWT minting.
