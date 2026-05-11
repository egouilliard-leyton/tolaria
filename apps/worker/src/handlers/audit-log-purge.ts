import type { Job } from 'pg-boss'
import { pool } from '../lib/db.js'

// Daily retention sweep over `audit_log`. Plan §9 left retention unspecified
// and the table grows forever today; Bundle H §6 of the 2026-05-10 audit asks
// us to age rows out on a configurable window.
//
// RLS note: `audit_log` has a tenant-scoped policy, so a regular tenant role
// can only see/delete its own rows. The purge needs to span every tenant in
// one statement, so we run it on a raw `pool.connect()` client WITHOUT
// installing the tenant session vars. The `tolaria_app` role used by the
// worker has BYPASSRLS in production (see db/migrations role grants), which
// lets the DELETE touch every subscription's rows. If you tighten the role
// later, switch to a dedicated `platform_admin` connection (or wrap in
// `SET LOCAL ROLE platform_admin`) and update the migration accordingly.
export async function handleAuditLogPurge(_job: Job<unknown>): Promise<void> {
  const days = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 365)
  if (!Number.isFinite(days) || days <= 0) return
  const client = await pool.connect()
  try {
    await client.query(
      `DELETE FROM audit_log WHERE created_at < now() - $1::interval`,
      [`${days} days`],
    )
  } finally {
    client.release()
  }
}
