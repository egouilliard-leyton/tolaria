import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAccessToken, setAccessToken } from '../../vault-adapter/api-client.js'
import { completeLogin, logout, startLogin } from '../web-auth.js'

const ORIGINAL_LOCATION = window.location

function setLocation(href: string) {
  // jsdom forbids reassigning window.location directly; work around it.
  delete (window as unknown as { location: unknown }).location
  ;(window as unknown as { location: Location }).location = {
    ...ORIGINAL_LOCATION,
    href,
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  } as unknown as Location
}

beforeEach(() => {
  setAccessToken(null)
})

afterEach(() => {
  setAccessToken(null)
  ;(window as unknown as { location: Location }).location = ORIGINAL_LOCATION
  vi.restoreAllMocks()
})

describe('startLogin', () => {
  it('redirects to /auth/oidc/<provider>/start with the given provider', () => {
    setLocation('https://app.test.tolaria/login')
    startLogin('acme-okta')
    expect(window.location.assign).toHaveBeenCalledWith('/auth/oidc/acme-okta/start')
  })

  it('defaults to provider "default"', () => {
    setLocation('https://app.test.tolaria/login')
    startLogin()
    expect(window.location.assign).toHaveBeenCalledWith('/auth/oidc/default/start')
  })

  it('encodes hostile provider ids', () => {
    setLocation('https://app.test.tolaria/login')
    startLogin('weird/provider id')
    expect(window.location.assign).toHaveBeenCalledWith('/auth/oidc/weird%2Fprovider%20id/start')
  })
})

describe('completeLogin', () => {
  it('returns null when the URL has no access_token', () => {
    setLocation('https://app.test.tolaria/auth/complete')
    expect(completeLogin()).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it('extracts the token, installs it in memory, and scrubs the URL', () => {
    setLocation('https://app.test.tolaria/auth/complete?access_token=abc.def&expires_at=1234567890')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    const completion = completeLogin()

    expect(completion).toEqual({ accessToken: 'abc.def', expiresAt: 1234567890 })
    expect(getAccessToken()).toBe('abc.def')
    expect(replaceState).toHaveBeenCalled()
    const cleanedUrl = replaceState.mock.calls[0][2] as string
    expect(cleanedUrl).not.toContain('access_token')
    expect(cleanedUrl).not.toContain('expires_at')
  })

  it('parses ISO-format expires_at', () => {
    setLocation(
      'https://app.test.tolaria/auth/complete?access_token=tok&expires_at=2026-05-10T12:00:00Z',
    )
    const completion = completeLogin()
    expect(completion?.expiresAt).toBe(Date.parse('2026-05-10T12:00:00Z'))
  })
})

describe('logout', () => {
  it('POSTs /auth/logout, clears the token, and redirects to /login', async () => {
    setAccessToken('about-to-die')
    setLocation('https://app.test.tolaria/notes')
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await logout('https://api.test.tolaria/')

    expect(fetchMock).toHaveBeenCalledWith('https://api.test.tolaria/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    expect(getAccessToken()).toBeNull()
    expect(window.location.assign).toHaveBeenCalledWith('/login')
    vi.unstubAllGlobals()
  })

  it('still clears the token when the network request fails', async () => {
    setAccessToken('about-to-die')
    setLocation('https://app.test.tolaria/notes')
    const fetchMock = vi.fn(async () => {
      throw new Error('network')
    })
    vi.stubGlobal('fetch', fetchMock)

    await logout('https://api.test.tolaria')

    expect(getAccessToken()).toBeNull()
    expect(window.location.assign).toHaveBeenCalledWith('/login')
    vi.unstubAllGlobals()
  })
})
