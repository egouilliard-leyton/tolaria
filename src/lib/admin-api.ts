// Typed client for `/admin/*` endpoints exposed by `apps/api`.
//
// Why this file calls `fetch` directly instead of going through the
// VaultAdapter:
//   - The VaultAdapter (agent F) is intentionally narrow — it models
//     vault/note/search/AI primitives, not subscription administration.
//     None of its methods cover SSO providers or member roles.
//   - Agent F's API client (`src/lib/api/client.ts`) handles JWT
//     injection and 401-refresh. It does not yet exist in this worktree;
//     when it lands, swap `request()` below to call it. Until then, this
//     module talks to the API directly with `fetch` + `credentials:
//     'include'` so the refresh-cookie round-trip still works.
//
// The base URL comes from `VITE_API_BASE_URL` (set by agent F's web
// build config). In tests, mock this whole module — see the page tests
// under `src/components/admin/**`.

export type UserRole = 'owner' | 'admin' | 'member'
export type ProviderRole = 'viewer' | 'member' | 'admin'

export interface SsoProvider {
  id: string
  name: string
  issuerUrl: string
  clientId: string
  scopes: string[]
  defaultRole: ProviderRole
  jit: boolean
  hasSecret: boolean
}

export interface SsoProviderInput {
  name: string
  issuerUrl: string
  clientId: string
  /** Empty string on edit means "leave the stored secret unchanged". */
  clientSecret: string
  scopes: string[]
  defaultRole: ProviderRole
  jit: boolean
}

/**
 * Lifecycle status of a member as surfaced by the admin API.
 *
 * - `invited`: row exists but the user has not yet accepted (no
 *   `password_hash` and no recorded sign-in).
 * - `active`: the user is provisioned and may sign in.
 * - `revoked`: the user was soft-revoked by an admin/owner.
 *
 * The server may omit this in older responses; the SPA should default to
 * `'active'` when absent.
 */
export type MemberStatus = 'invited' | 'active' | 'revoked'

export interface Member {
  id: string
  email: string
  role: UserRole
  createdAt: string
  /** Optional: server may omit on older responses. Falls back to "active". */
  status?: MemberStatus
  /** Optional: human-friendly name; null/absent if the user has not set one. */
  displayName?: string | null
  /** Optional: ISO-8601; absent on older responses. */
  updatedAt?: string
}

export interface InviteResult {
  inviteUrl: string
  member: Member
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: unknown

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

interface ApiErrorBody {
  code?: unknown
  message?: unknown
  detail?: unknown
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody = {}
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    // non-JSON response; keep defaults
  }
  const code = pickString(body.code, `http_${response.status}`)
  const message = pickString(body.message, response.statusText || 'Request failed')
  return new ApiError(response.status, code, message, body.detail)
}

interface RequestOptions {
  method: string
  body?: unknown
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const response = await fetch(resolveUrl(path), {
    method: options.method,
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'include',
  })
  if (!response.ok) throw await parseError(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function resolveUrl(path: string): string {
  const base = readApiBaseUrl()
  if (!base) return path
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmedBase}${path}`
}

function readApiBaseUrl(): string {
  const env = (import.meta as ImportMeta).env as Record<string, string | undefined> | undefined
  return env?.VITE_API_BASE_URL ?? ''
}

export async function listSsoProviders(): Promise<SsoProvider[]> {
  return request<SsoProvider[]>('/admin/sso/providers', { method: 'GET' })
}

export async function createSsoProvider(input: SsoProviderInput): Promise<SsoProvider> {
  return request<SsoProvider>('/admin/sso/providers', {
    method: 'POST',
    body: input,
  })
}

export async function updateSsoProvider(
  id: string,
  input: SsoProviderInput,
): Promise<SsoProvider> {
  return request<SsoProvider>(`/admin/sso/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })
}

export async function deleteSsoProvider(id: string): Promise<void> {
  await request<void>(`/admin/sso/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function listUsers(): Promise<Member[]> {
  return request<Member[]>('/admin/users', { method: 'GET' })
}

export async function inviteUser(email: string, role: UserRole): Promise<InviteResult> {
  return request<InviteResult>('/admin/users/invite', {
    method: 'POST',
    body: { email, role },
  })
}

export async function updateUserRole(id: string, role: UserRole): Promise<Member> {
  return request<Member>(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { role },
  })
}

export async function removeUser(id: string): Promise<void> {
  await request<void>(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export const __testing__ = { parseError, resolveUrl }
