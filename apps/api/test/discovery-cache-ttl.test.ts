// OIDC discovery cache TTL — closes verification defect #7. The cache lives
// for 10 minutes; once the entry is older than the TTL the next caller must
// trigger a fresh `oidc.discovery(...)`. Without this, an Authentik key
// rotation silently breaks ID-token verification until the API restarts.
//
// We mock `openid-client` so we can count `discovery` calls without doing any
// real HTTP. `vi.useFakeTimers()` lets us advance the clock past the TTL
// instead of waiting wall-clock minutes.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'b'.repeat(32)
  process.env.R2_ENDPOINT = 'http://localhost:9000'
  process.env.R2_ACCOUNT_ID = 'x'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  process.env.R2_BUCKET = 'x'
  process.env.LITELLM_BASE_URL = 'http://localhost:4000'
  process.env.LITELLM_TOKEN = 'x'
})
afterAll(() => {
  process.env = { ...ORIG_ENV }
})

// `openid-client` is the heavy dependency; we replace `discovery` with a
// counter-backed stub that returns a sentinel value the test can identify.
vi.mock('openid-client', () => {
  const discovery = vi.fn(async () => ({ __sentinel: 'config' }) as unknown)
  return {
    discovery,
    randomPKCECodeVerifier: () => 'verifier',
    calculatePKCECodeChallenge: async () => 'challenge',
    randomState: () => 'state',
    randomNonce: () => 'nonce',
    buildAuthorizationUrl: () => new URL('https://idp.example/authorize'),
    authorizationCodeGrant: vi.fn(),
  }
})

const INPUT = {
  issuerUrl: 'https://idp.example',
  clientId: 'client-abc',
  clientSecret: 'shh',
  scopes: ['openid', 'profile'] as const,
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-09T00:00:00Z'))
  // Drop any cache leftovers from a previous test before we count fetches.
  const mod = await import('../src/services/authentik.js')
  mod._invalidateDiscoveryCache()
  const oidc = await import('openid-client')
  ;(oidc.discovery as unknown as ReturnType<typeof vi.fn>).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OIDC discovery cache TTL', () => {
  it('serves the cached config for repeated calls within the TTL', async () => {
    const { getProviderConfig } = await import('../src/services/authentik.js')
    const oidc = await import('openid-client')
    const discovery = oidc.discovery as unknown as ReturnType<typeof vi.fn>

    await getProviderConfig(INPUT)
    // Five minutes pass — well under the 10-minute TTL.
    vi.advanceTimersByTime(5 * 60 * 1000)
    await getProviderConfig(INPUT)

    expect(discovery).toHaveBeenCalledTimes(1)
  })

  it('refetches once the entry is older than the 10-minute TTL', async () => {
    const { getProviderConfig } = await import('../src/services/authentik.js')
    const oidc = await import('openid-client')
    const discovery = oidc.discovery as unknown as ReturnType<typeof vi.fn>

    await getProviderConfig(INPUT)
    expect(discovery).toHaveBeenCalledTimes(1)

    // Push the wall-clock just past the TTL boundary. The next call MUST
    // trigger a fresh discovery — otherwise an IdP key rotation would never
    // be observed.
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    await getProviderConfig(INPUT)

    expect(discovery).toHaveBeenCalledTimes(2)
  })

  it('exposes _invalidateDiscoveryCache for tests', async () => {
    const { getProviderConfig, _invalidateDiscoveryCache } = await import(
      '../src/services/authentik.js'
    )
    const oidc = await import('openid-client')
    const discovery = oidc.discovery as unknown as ReturnType<typeof vi.fn>

    await getProviderConfig(INPUT)
    _invalidateDiscoveryCache(INPUT)
    await getProviderConfig(INPUT)

    expect(discovery).toHaveBeenCalledTimes(2)
  })
})
