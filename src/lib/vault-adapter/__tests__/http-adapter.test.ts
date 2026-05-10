import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, setAccessToken } from '../api-client.js'
import { HttpVaultAdapter } from '../http-adapter.js'

const API_BASE = 'https://api.test.tolaria'

interface FetchCall {
  url: string
  init: RequestInit
}

interface MockHandler {
  match: (url: string, init: RequestInit) => boolean
  handler: (call: FetchCall) => Response | Promise<Response>
}

let handlers: MockHandler[] = []
let calls: FetchCall[] = []

function mockFetch(): typeof fetch {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const call: FetchCall = { url, init: init ?? {} }
    calls.push(call)
    const handler = handlers.find((h) => h.match(url, call.init))
    if (!handler) {
      throw new Error(`No mock handler for ${call.init.method ?? 'GET'} ${url}`)
    }
    return handler.handler(call)
  }) as unknown as typeof fetch
  return fn
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } })
}

beforeEach(() => {
  handlers = []
  calls = []
  setAccessToken('test-access-token')
})

afterEach(() => {
  setAccessToken(null)
})

describe('HttpVaultAdapter', () => {
  describe('listVaults', () => {
    it('maps snake_case DTOs to the camelCase contract', async () => {
      handlers.push({
        match: (url, init) => url === `${API_BASE}/vaults` && (init.method ?? 'GET') === 'GET',
        handler: () =>
          jsonResponse(200, [
            {
              id: 'v1',
              slug: 'work',
              name: 'Work',
              created_at: '2026-01-01T00:00:00Z',
              settings: { theme: 'dark' },
            },
          ]),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const vaults = await adapter.listVaults()

      expect(vaults).toEqual([
        {
          id: 'v1',
          slug: 'work',
          name: 'Work',
          createdAt: '2026-01-01T00:00:00Z',
          settings: { theme: 'dark' },
        },
      ])
    })

    it('attaches the bearer token from in-memory state', async () => {
      handlers.push({
        match: (url) => url === `${API_BASE}/vaults`,
        handler: () => jsonResponse(200, []),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      await adapter.listVaults()

      const headers = new Headers(calls[0].init.headers)
      expect(headers.get('Authorization')).toBe('Bearer test-access-token')
    })
  })

  describe('401 -> refresh -> retry', () => {
    it('refreshes the access token once and replays the original request', async () => {
      let firstAttempt = true
      handlers.push({
        match: (url) => url === `${API_BASE}/vaults`,
        handler: () => {
          if (firstAttempt) {
            firstAttempt = false
            return errorResponse(401, 'unauthorized', 'token expired')
          }
          return jsonResponse(200, [])
        },
      })
      handlers.push({
        match: (url, init) => url === `${API_BASE}/auth/refresh` && init.method === 'POST',
        handler: () => jsonResponse(200, { accessToken: 'rotated-token' }),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const vaults = await adapter.listVaults()

      expect(vaults).toEqual([])
      expect(calls.map((c) => c.url)).toEqual([
        `${API_BASE}/vaults`,
        `${API_BASE}/auth/refresh`,
        `${API_BASE}/vaults`,
      ])
      // Replay must use the rotated token
      const replayHeaders = new Headers(calls[2].init.headers)
      expect(replayHeaders.get('Authorization')).toBe('Bearer rotated-token')
    })

    it('coalesces concurrent 401s onto one refresh', async () => {
      let refreshes = 0
      let firstNotes = true
      let firstFolders = true
      handlers.push({
        match: (url) => url === `${API_BASE}/vaults/v1/folders`,
        handler: () => {
          if (firstFolders) {
            firstFolders = false
            return errorResponse(401, 'unauthorized', 'expired')
          }
          return jsonResponse(200, [])
        },
      })
      handlers.push({
        match: (url) => url.startsWith(`${API_BASE}/vaults/v1/notes`),
        handler: () => {
          if (firstNotes) {
            firstNotes = false
            return errorResponse(401, 'unauthorized', 'expired')
          }
          return jsonResponse(200, { items: [], next_cursor: null })
        },
      })
      handlers.push({
        match: (url) => url === `${API_BASE}/auth/refresh`,
        handler: () => {
          refreshes++
          return jsonResponse(200, { accessToken: 'rotated' })
        },
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const [folders, notes] = await Promise.all([
        adapter.listFolders('v1'),
        adapter.listNotes('v1'),
      ])

      expect(folders).toEqual([])
      expect(notes).toEqual({ items: [], nextCursor: null })
      expect(refreshes).toBe(1)
    })
  })

  describe('saveNote version conflict', () => {
    it('throws ApiError with status 409 when the server reports a stale version', async () => {
      handlers.push({
        match: (url, init) => url === `${API_BASE}/notes/n1` && init.method === 'PUT',
        handler: () =>
          jsonResponse(409, {
            error: {
              code: 'version_conflict',
              message: 'note has been modified',
              details: { latestVersion: 7 },
            },
          }),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      let caught: unknown
      try {
        await adapter.saveNote('n1', { bodyMd: 'hi', frontmatter: {}, expectedVersion: 5 })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(ApiError)
      const apiError = caught as ApiError
      expect(apiError.status).toBe(409)
      expect(apiError.code).toBe('version_conflict')
      expect(apiError.details).toEqual({ latestVersion: 7 })

      // Body sent to server uses snake_case
      const body = JSON.parse((calls[0].init.body as string) ?? '{}')
      expect(body).toEqual({ body_md: 'hi', frontmatter: {}, expected_version: 5 })
    })

    it('returns the new version on success', async () => {
      handlers.push({
        match: (url, init) => url === `${API_BASE}/notes/n1` && init.method === 'PUT',
        handler: () => jsonResponse(200, { version: 8 }),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const result = await adapter.saveNote('n1', {
        bodyMd: 'hi',
        frontmatter: {},
        expectedVersion: 7,
      })
      expect(result).toEqual({ version: 8 })
    })
  })

  describe('uploadAttachment', () => {
    it('runs the presign -> R2 PUT -> verify dance and returns the verified attachment', async () => {
      const fileBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      const file = new Blob([fileBytes], { type: 'image/png' })
      // jsdom's Blob lacks arrayBuffer, so stub it so the adapter can hash.
      ;(file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
        Promise.resolve(fileBytes.buffer)

      // Stub crypto.subtle.digest because jsdom doesn't implement it.
      const fakeDigest = new Uint8Array(32).fill(0xab).buffer
      const subtle = {
        digest: vi.fn().mockResolvedValue(fakeDigest),
      } as unknown as SubtleCrypto
      vi.stubGlobal('crypto', { subtle })

      handlers.push({
        match: (url, init) =>
          url === `${API_BASE}/vaults/v1/attachments` && init.method === 'POST',
        handler: () =>
          jsonResponse(200, {
            id: 'att-1',
            put_url: 'https://r2.example/put/abc',
            get_url: 'https://r2.example/get/abc',
            key: 'abc',
            sha256_header: 'ab'.repeat(32),
          }),
      })
      handlers.push({
        match: (url, init) => url === 'https://r2.example/put/abc' && init.method === 'PUT',
        handler: () => new Response(null, { status: 200 }),
      })
      handlers.push({
        match: (url, init) =>
          url === `${API_BASE}/attachments/att-1/verify` && init.method === 'POST',
        handler: () =>
          jsonResponse(200, {
            id: 'att-1',
            vault_id: 'v1',
            note_id: null,
            mime: 'image/png',
            size_bytes: 4,
            sha256: 'ab'.repeat(32),
            url: 'https://r2.example/get/abc',
          }),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const result = await adapter.uploadAttachment(file, {
        mime: 'image/png',
        size: 4,
        sha256: '',
        filename: 'pixel.png',
        // smuggled extra field: see http-adapter.ts notes
        ...({ vaultId: 'v1' } as { vaultId: string }),
      })

      expect(result).toEqual({
        id: 'att-1',
        vaultId: 'v1',
        noteId: null,
        mime: 'image/png',
        sizeBytes: 4,
        sha256: 'ab'.repeat(32),
        url: 'https://r2.example/get/abc',
      })

      // Step 1: presign request
      const presignBody = JSON.parse(calls[0].init.body as string)
      expect(presignBody).toEqual({
        mime: 'image/png',
        size: 4,
        sha256: 'ab'.repeat(32),
        filename: 'pixel.png',
        note_id: null,
      })

      // Step 2: R2 PUT carries the sha header
      const putHeaders = new Headers(calls[1].init.headers)
      expect(putHeaders.get('x-amz-meta-sha256')).toBe('ab'.repeat(32))
      expect(putHeaders.get('Content-Type')).toBe('image/png')

      vi.unstubAllGlobals()
    })

    it('throws ApiError when the R2 PUT fails', async () => {
      const fakeDigest = new Uint8Array(32).fill(1).buffer
      vi.stubGlobal('crypto', {
        subtle: { digest: vi.fn().mockResolvedValue(fakeDigest) } as unknown as SubtleCrypto,
      })

      handlers.push({
        match: (url) => url === `${API_BASE}/vaults/v1/attachments`,
        handler: () =>
          jsonResponse(200, {
            id: 'att-9',
            put_url: 'https://r2.example/put/zzz',
            get_url: 'https://r2.example/get/zzz',
            key: 'zzz',
          }),
      })
      handlers.push({
        match: (url) => url === 'https://r2.example/put/zzz',
        handler: () => new Response('forbidden', { status: 403 }),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const fileBytes = new Uint8Array(2)
      const file = new Blob([fileBytes], { type: 'image/png' })
      ;(file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
        Promise.resolve(fileBytes.buffer)
      let caught: unknown
      try {
        await adapter.uploadAttachment(file, {
          mime: 'image/png',
          size: 2,
          sha256: '',
          filename: 'a.png',
          ...({ vaultId: 'v1' } as { vaultId: string }),
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(ApiError)
      expect((caught as ApiError).status).toBe(403)
      expect((caught as ApiError).code).toBe('attachment_upload_failed')

      vi.unstubAllGlobals()
    })
  })

  describe('search', () => {
    it('forwards mode and returns camelCase results', async () => {
      handlers.push({
        match: (url) =>
          url ===
          `${API_BASE}/vaults/v1/search?${new URLSearchParams({ q: 'foo', mode: 'prefix' }).toString()}`,
        handler: () =>
          jsonResponse(200, {
            results: [{ note_id: 'n1', title: 'Foo', snippet: 'foo bar', score: 0.8 }],
            query: 'foo',
            mode: 'prefix',
            elapsed_ms: 12,
          }),
      })

      const adapter = new HttpVaultAdapter({ baseUrl: API_BASE, fetchImpl: mockFetch() })
      const result = await adapter.search('v1', 'foo', 'prefix')
      expect(result).toEqual({
        query: 'foo',
        mode: 'prefix',
        elapsedMs: 12,
        results: [{ noteId: 'n1', title: 'Foo', snippet: 'foo bar', score: 0.8 }],
      })
    })
  })
})
