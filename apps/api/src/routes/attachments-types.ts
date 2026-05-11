// Wire shape for an attachment as the SPA's HttpVaultAdapter expects it.
// Mirrors the `AttachmentDto` interface in
// `src/lib/vault-adapter/http-adapter.ts` — keep in sync.
//
// Public vault-adapter API uses snake_case; admin endpoints stay camelCase.
//
// Lives next to the route module rather than in lib/schemas.ts because this
// is the response shape, not a request validator.

export interface AttachmentDto {
  id: string
  vault_id: string
  note_id: string | null
  mime: string
  size_bytes: number
  sha256: string
  url: string
}
