// Bundle H §6 — daily worker job DELETEs `audit_log` rows older than
// AUDIT_LOG_RETENTION_DAYS. The handler reads the env var at execution time
// and runs the DELETE against the raw pool (no withTenant) because the
// retention sweep must span every tenant in one statement.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryCall {
  text: string
  values: unknown[]
}

const queries: QueryCall[] = []

const fakeClient = {
  query: vi.fn(async (text: string, values: unknown[] = []) => {
    queries.push({ text, values })
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
}

vi.mock('../src/lib/db.js', () => ({
  pool: { connect: () => Promise.resolve(fakeClient) },
  withTenant: async <T>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) =>
    fn(fakeClient),
  SYSTEM_USER_ID: '00000000-0000-0000-0000-000000000000',
}))

const ORIG_ENV = { ...process.env }

beforeEach(() => {
  queries.length = 0
  fakeClient.query.mockClear()
  fakeClient.release.mockClear()
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
})

describe('handleAuditLogPurge (Bundle H §6)', () => {
  it('runs DELETE FROM audit_log with the configured days as an interval', async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = '90'
    const { handleAuditLogPurge } = await import('../src/handlers/audit-log-purge.js')
    await handleAuditLogPurge({ data: {} } as Parameters<typeof handleAuditLogPurge>[0])
    expect(queries).toHaveLength(1)
    expect(queries[0]?.text).toMatch(/DELETE FROM audit_log/)
    expect(queries[0]?.text).toMatch(/now\(\) - \$1::interval/)
    expect(queries[0]?.values).toEqual(['90 days'])
  })

  it('defaults to 365 days when the env var is unset', async () => {
    delete process.env.AUDIT_LOG_RETENTION_DAYS
    const { handleAuditLogPurge } = await import('../src/handlers/audit-log-purge.js')
    await handleAuditLogPurge({ data: {} } as Parameters<typeof handleAuditLogPurge>[0])
    expect(queries[0]?.values).toEqual(['365 days'])
  })

  it('releases the pool client even when the query throws', async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = '30'
    fakeClient.query.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const { handleAuditLogPurge } = await import('../src/handlers/audit-log-purge.js')
    await expect(
      handleAuditLogPurge({ data: {} } as Parameters<typeof handleAuditLogPurge>[0]),
    ).rejects.toThrow(/boom/)
    expect(fakeClient.release).toHaveBeenCalled()
  })

  it('no-ops on a non-finite/non-positive retention setting', async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = 'not-a-number'
    const { handleAuditLogPurge } = await import('../src/handlers/audit-log-purge.js')
    await handleAuditLogPurge({ data: {} } as Parameters<typeof handleAuditLogPurge>[0])
    expect(queries).toHaveLength(0)
  })
})
