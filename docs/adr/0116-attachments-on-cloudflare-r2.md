---
type: ADR
id: "0116"
title: "Attachments on Cloudflare R2 with presigned URLs"
status: active
date: 2026-05-09
---

## Context

The Tolaria desktop app stores image, audio, video, and PDF attachments next
to the markdown that references them. The web SaaS cannot do this — there is
no shared filesystem, the API server should not proxy multi-megabyte uploads,
and bandwidth costs out of mainstream IaaS object storage (S3) eat into a
note-taking product's slim margins.

Three storage backends were compared:

1. **AWS S3** — the obvious default; S3-compatible API, mature SDKs,
   excellent durability. Egress is $0.09/GB which is unacceptable for a
   product where users routinely embed photos and PDFs that the app then
   re-downloads to render.
2. **Cloudflare R2** — S3-compatible API, zero egress charge, comparable
   durability, integrated with Cloudflare's CDN if we ever need it. Storage
   pricing is similar to S3.
3. **Postgres `bytea` columns** — operationally trivial, but Postgres is the
   wrong store for binary blobs at this size class (page bloat, vacuum cost,
   backup size).

The dominant cost driver in a notes product is read traffic — every time a
note opens, every embedded image is fetched. Free egress on R2 turns that from
a recurring expense into a fixed cost.

## Decision

**Attachments are stored in Cloudflare R2. The API never proxies bytes;
clients PUT and GET via short-lived presigned URLs. Postgres holds metadata
only.**

Specifics:

1. `attachments` table stores `id`, `vault_id`, optional `note_id`, the R2
   object `key`, declared `mime`, `size_bytes`, `sha256`, `created_by`,
   `created_at`, and `verified_at`. RLS on `vault_id` (via the parent vault's
   `subscription_id`) keeps tenants isolated.
2. R2 bucket layout is
   `s/<subscription_id>/v/<vault_id>/a/<attachment_id>/<filename>`. The
   subscription/vault prefix exists so a future bucket-policy or per-tenant
   bucket rotation has a clean cut line.
3. **Upload**: `POST /vaults/:id/attachments` with `{mime, size, sha256}`
   returns a presigned PUT URL valid 5 minutes plus the new attachment id.
   The server validates declared `mime` against an allowlist (image/*,
   audio/*, video/*, application/pdf, text/plain) and rejects sizes above
   the per-plan cap.
4. **Verify**: after PUT, the client calls `POST /attachments/:id/verify`.
   The API issues an R2 `HeadObject`, compares `Content-Length` and the
   `x-amz-meta-sha256` header to the row, and sets `verified_at`. Unverified
   rows are GC'd by the worker after 1 hour.
5. **Read**: `GET /attachments/:id` returns a 302 to a presigned GET URL
   valid 10 minutes. The browser caches via the URL hash. Public sharing is
   out of scope for v1.
6. R2 credentials live in the API process only (`R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ACCOUNT_ID`). The browser never
   sees them. The desktop app, when in synced mode, follows the same flow.
7. Object deletion is asynchronous: marking the row as deleted enqueues an
   `r2-gc` job that issues `DeleteObject` and removes the metadata row only
   after R2 confirms.

## Alternatives considered

- **AWS S3** (rejected): egress cost on a notes product with embedded media
  is the dominant variable cost; R2 removes it.
- **Postgres bytea / Large Objects** (rejected): wrong tool for the size,
  ruins backups, fights vacuum.
- **Direct browser-to-R2 with public-read ACL** (rejected): leaks the URL
  perpetually and skips RLS-backed authorization.

## Consequences

- The API stays small and stateless — no upload buffering, no streaming
  through Node, no chunked-multipart headaches.
- Quota enforcement happens before the presign step; the client cannot
  exceed plan limits even by writing directly to R2.
- Local development uses MinIO with the S3-compatible API and the same code
  path; only `R2_ENDPOINT` differs in `.env.local`.
- Migration off R2 (e.g. to S3 or to a customer-owned bucket for an
  enterprise plan) is a metadata-only operation: re-presign against a
  different endpoint, copy, repoint `key_r2`. No code change.
- Public sharing, hotlink protection, watermarking, and image transforms are
  all later work and intentionally not in v1.
