// Wire shape for an attachment as the SPA's VaultAdapter expects it.
// Mirrors `Attachment` in src/lib/vault-adapter/types.ts — keep in sync.
//
// Lives next to the route module rather than in lib/schemas.ts because this
// is the response shape, not a request validator.

export interface Attachment {
  id: string
  vaultId: string
  noteId: string | null
  mime: string
  sizeBytes: number
  sha256: string
  url: string
}
