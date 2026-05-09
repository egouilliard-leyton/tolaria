import { z } from 'zod'

// Job payload — every job carries the tenant id so the handler can wrap its
// DB work in withTenant() and stay inside RLS. See ADR-0115.
export const IndexNotePayload = z.object({
  subscriptionId: z.string().uuid(),
  vaultId: z.string().uuid(),
  noteId: z.string().uuid(),
})
export type IndexNotePayload = z.infer<typeof IndexNotePayload>

export async function handleIndexNote(_payload: IndexNotePayload): Promise<void> {
  // Real implementation lands with the search agent: read the note, recompute
  // tsvector + embedding, upsert into note_search.
  // Left as a stub so the worker boots and the queue exists.
}
