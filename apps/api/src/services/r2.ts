// Cloudflare R2 client and presigning helpers. See ADR-0116.
//
// Surface kept deliberately tiny so the rest of the API never touches the
// AWS SDK directly: presignPut / presignGet / headObject / deleteObject and
// the buildKey helper.
//
// Notes:
//   * R2 speaks the S3 API, so we use @aws-sdk/client-s3 in path-style.
//   * The browser is the only thing that ever sees the bytes — the API never
//     proxies an upload or download. presignPut returns the URL plus the
//     `x-amz-meta-sha256` header the client must include so headObject can
//     verify the upload server-side after the PUT lands.
//   * presigned URL TTLs come from env (R2_PRESIGN_PUT_TTL_SECONDS = 300,
//     R2_PRESIGN_GET_TTL_SECONDS = 600 by default).

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { loadEnv } from '../env.js'
import { NotFound, UpstreamUnavailable } from '../lib/errors.js'

// ── Bucket layout ──────────────────────────────────────────────────────────
//
// `s/<subscription_id>/v/<vault_id>/a/<attachment_id>/<filename>`
//
// The subscription/vault prefix is intentional: a future per-tenant bucket
// rotation or lifecycle rule has a clean cut line. Filename is the original
// client-supplied name, but we sanitize it so only safe URL characters
// survive — the canonical metadata still lives in Postgres.

export interface KeyParts {
  subscriptionId: string
  vaultId: string
  attachmentId: string
  filename: string
}

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]/g

export function sanitizeFilename(input: string): string {
  // Strip any path separators and zero-width / control chars, then collapse
  // anything that isn't a basic url-safe character to '_'. We also clip to a
  // sane length so a malicious 10kB filename can't blow up the key length.
  const lastSegment = input.split(/[\\/]/).pop() ?? ''
  const trimmed = lastSegment.trim().slice(0, 200)
  const safe = trimmed.replace(SAFE_FILENAME_RE, '_')
  // Avoid empty / dot-only filenames; they break some S3 implementations.
  if (safe === '' || safe === '.' || safe === '..') return 'file'
  return safe
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`buildKey: ${label} must be a UUID, got ${JSON.stringify(value)}`)
  }
}

export function buildKey(parts: KeyParts): string {
  assertUuid('subscriptionId', parts.subscriptionId)
  assertUuid('vaultId', parts.vaultId)
  assertUuid('attachmentId', parts.attachmentId)
  const filename = sanitizeFilename(parts.filename)
  return `s/${parts.subscriptionId}/v/${parts.vaultId}/a/${parts.attachmentId}/${filename}`
}

// ── Client ─────────────────────────────────────────────────────────────────

let cachedClient: S3Client | null = null
let cachedBucket: string | null = null
let cachedPutTtl = 300
let cachedGetTtl = 600

function getClient(): { client: S3Client; bucket: string; putTtl: number; getTtl: number } {
  if (!cachedClient) {
    const env = loadEnv()
    cachedClient = new S3Client({
      region: 'auto', // R2 ignores region but the SDK demands a value
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true, // R2 requires path-style addressing
    })
    cachedBucket = env.R2_BUCKET
    cachedPutTtl = env.R2_PRESIGN_PUT_TTL_SECONDS
    cachedGetTtl = env.R2_PRESIGN_GET_TTL_SECONDS
  }
  return {
    client: cachedClient,
    bucket: cachedBucket as string,
    putTtl: cachedPutTtl,
    getTtl: cachedGetTtl,
  }
}

// ── Presign PUT ────────────────────────────────────────────────────────────

export interface PresignPutResult {
  url: string
  headers: Record<string, string>
  expiresIn: number
}

/**
 * Presign a single-PUT upload to R2. The client MUST send the same headers
 * back in its PUT request; otherwise the signature will not match.
 *
 * The `x-amz-meta-sha256` header is what we later read in headObject to
 * verify the upload — keep it on the request.
 */
export async function presignPut(
  key: string,
  mime: string,
  size: number,
  sha256: string,
): Promise<PresignPutResult> {
  const { client, bucket, putTtl } = getClient()
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: mime,
    ContentLength: size,
    Metadata: { sha256 },
    // ChecksumSHA256 is intentionally NOT used — R2 checksum support has
    // gaps, so we verify ourselves via headObject in the verify endpoint.
  })
  const url = await getSignedUrl(client, command, {
    expiresIn: putTtl,
    // Sign these headers so the client can't forge the meta after the fact.
    signableHeaders: new Set([
      'content-type',
      'content-length',
      'x-amz-meta-sha256',
    ]),
  })
  return {
    url,
    headers: {
      'content-type': mime,
      'content-length': String(size),
      'x-amz-meta-sha256': sha256,
    },
    expiresIn: putTtl,
  }
}

// ── Presign GET ────────────────────────────────────────────────────────────

export async function presignGet(key: string): Promise<{ url: string; expiresIn: number }> {
  const { client, bucket, getTtl } = getClient()
  const command = new GetObjectCommand({ Bucket: bucket, Key: key })
  const url = await getSignedUrl(client, command, { expiresIn: getTtl })
  return { url, expiresIn: getTtl }
}

// ── Head ───────────────────────────────────────────────────────────────────

export interface HeadObjectResult {
  contentLength: number
  sha256: string | null
}

/**
 * HEAD the object so we can verify size / sha256 against the metadata row.
 * Returns null sha256 if R2 didn't echo back the user metadata (e.g. the
 * client dropped the header on PUT) — verify must treat that as a mismatch.
 */
export async function headObject(key: string): Promise<HeadObjectResult> {
  const { client, bucket } = getClient()
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    const contentLength =
      typeof out.ContentLength === 'number' && Number.isFinite(out.ContentLength)
        ? out.ContentLength
        : 0
    const sha256 = out.Metadata?.sha256 ?? null
    return { contentLength, sha256 }
  } catch (err) {
    if (isNotFound(err)) {
      throw NotFound('Object not found in R2')
    }
    throw UpstreamUnavailable(`R2 HeadObject failed: ${(err as Error).message}`)
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteObject(key: string): Promise<void> {
  const { client, bucket } = getClient()
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (err) {
    if (isNotFound(err)) return // already gone — treat as success
    throw UpstreamUnavailable(`R2 DeleteObject failed: ${(err as Error).message}`)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true
  return e.$metadata?.httpStatusCode === 404
}

// Test-only: drop the cached client so module mocks can re-init env. Never
// invoked by production code — exported under a leading underscore so the
// linter / reviewers see immediately that it's not part of the public API.
export function __resetR2ClientForTests(): void {
  cachedClient = null
  cachedBucket = null
}
