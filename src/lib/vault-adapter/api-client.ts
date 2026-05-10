// Thin fetch wrapper for the SaaS HTTP backend.
//
// Responsibilities:
//   - Attach the in-memory access token to every request.
//   - Auto-refresh on 401 by calling POST /auth/refresh and replaying the
//     original request once. The refresh cookie is httpOnly and is sent by
//     the browser automatically, so this module never reads or writes
//     localStorage / sessionStorage.
//   - Single-flight refresh: if a refresh is already in progress, every
//     awaiting caller shares the same promise. This avoids the thundering-
//     herd N×refresh after a token expiry.
//   - Convert structured error responses
//       { error: { code, message, details? } }
//     into a typed `ApiError` so callers can `instanceof` check.
//   - Provide a small SSE helper. EventSource cannot set Authorization
//     headers, so streaming endpoints take the access token as a query
//     parameter (the server validates it the same way).
//
// This module deliberately exposes only `getAccessToken` / `setAccessToken`
// for token plumbing. The auth controller in `src/lib/auth/web-auth.ts` is
// the single source of truth that drives those setters.

export interface ApiErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
    this.status = status
    this.code = payload.code
    this.details = payload.details
  }
}

export interface ApiClientOptions {
  /**
   * Absolute base URL of `apps/api`, e.g. `https://api.tolaria.app`.
   * No trailing slash.
   */
  baseUrl: string
  /**
   * Optional override for `fetch`, primarily for tests. Defaults to
   * `globalThis.fetch.bind(globalThis)` so it picks up `vi.stubGlobal`.
   */
  fetchImpl?: typeof fetch
  /**
   * Optional callback invoked when the refresh attempt itself fails. The
   * AuthProvider uses this to log the user out and redirect to the login
   * page.
   */
  onAuthError?: (error: ApiError) => void
}

let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/**
 * One refresh promise can be in flight at a time. Concurrent 401s wait on
 * the same `Promise<boolean>` — `true` means the refresh succeeded and the
 * caller should retry, `false` means the caller should give up.
 */
let inflightRefresh: Promise<boolean> | null = null

export class ApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly onAuthError?: (error: ApiError) => void

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.onAuthError = options.onAuthError
  }

  get apiBaseUrl(): string {
    return this.baseUrl
  }

  /** Build an absolute URL for `path` (which must start with `/`). */
  url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  /** Issue a GET request expecting JSON. */
  getJson<T>(path: string, init?: RequestInit): Promise<T> {
    return this.requestJson<T>(path, { ...init, method: 'GET' })
  }

  /** Issue a JSON-encoded request and decode the JSON response. */
  async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /**
   * Core request method: attaches the bearer token, handles 401 + refresh
   * once, throws `ApiError` for non-2xx responses.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.send(path, init)
    if (response.status !== 401) {
      if (!response.ok) throw await toApiError(response)
      return response
    }

    const refreshed = await this.refreshOnce()
    if (!refreshed) throw await toApiError(response)

    const replay = await this.send(path, init)
    if (!replay.ok) throw await toApiError(replay)
    return replay
  }

  /** Send a single attempt. No refresh, no error mapping. */
  private send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers ?? {})
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    if (init.body !== undefined && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json')
    }
    headers.set('Accept', headers.get('Accept') ?? 'application/json')
    return this.fetchImpl(this.url(path), {
      ...init,
      headers,
      // Always include the refresh cookie on cross-origin calls.
      credentials: init.credentials ?? 'include',
    })
  }

  /**
   * Coalesce concurrent refresh attempts to a single network round-trip.
   * Returns true when a fresh token was installed via setAccessToken.
   */
  private async refreshOnce(): Promise<boolean> {
    inflightRefresh ??= this.performRefresh().finally(() => {
      inflightRefresh = null
    })
    return inflightRefresh
  }

  private async performRefresh(): Promise<boolean> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
    } catch {
      return false
    }
    if (!response.ok) {
      try {
        this.onAuthError?.(await toApiError(response))
      } catch {
        // already an ApiError — fall through
      }
      return false
    }
    const body = (await response.json()) as { accessToken?: string; access_token?: string }
    const next = body.accessToken ?? body.access_token ?? null
    if (!next) return false
    setAccessToken(next)
    return true
  }

  /**
   * Open a Server-Sent Events stream and forward parsed events to
   * `onEvent`. Returns when the stream closes (server `event: done`,
   * connection drop, or `signal.aborted`).
   *
   * Why not `EventSource`?
   *   `EventSource` cannot set request headers, so authenticated streams
   *   must pass the access token as a query parameter. We use `fetch` +
   *   manual parsing instead so we can carry POST bodies and Authorization
   *   headers when the server permits them.
   */
  async streamSse(
    path: string,
    init: RequestInit,
    onEvent: (event: SseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = new Headers(init.headers ?? {})
    headers.set('Accept', 'text/event-stream')
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const response = await this.fetchImpl(this.url(path), {
      ...init,
      headers,
      signal,
      credentials: init.credentials ?? 'include',
    })
    if (!response.ok) throw await toApiError(response)
    if (!response.body) throw new Error('SSE response has no body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        if (signal?.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let separatorIndex = buffer.indexOf('\n\n')
        while (separatorIndex !== -1) {
          const frame = buffer.slice(0, separatorIndex)
          buffer = buffer.slice(separatorIndex + 2)
          const event = parseSseFrame(frame)
          if (event) onEvent(event)
          separatorIndex = buffer.indexOf('\n\n')
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // already cancelled
      }
    }
  }
}

export interface SseEvent {
  /** The `event:` field, defaulting to `'message'`. */
  type: string
  /** The raw `data:` field joined with newlines. */
  data: string
  /** `data` parsed as JSON, or null if it isn't valid JSON. */
  json: unknown
}

function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split(/\r?\n/)
  let type = 'message'
  const dataLines: string[] = []
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      type = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')
  let json: unknown = null
  try {
    json = JSON.parse(data)
  } catch {
    json = null
  }
  return { type, data, json }
}

async function toApiError(response: Response): Promise<ApiError> {
  const fallback: ApiErrorPayload = {
    code: errorCodeForStatus(response.status),
    message: response.statusText || `HTTP ${response.status}`,
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return new ApiError(response.status, fallback)
  }
  try {
    const body = (await response.json()) as { error?: ApiErrorPayload }
    return new ApiError(response.status, body.error ?? fallback)
  } catch {
    return new ApiError(response.status, fallback)
  }
}

function errorCodeForStatus(status: number): string {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}
