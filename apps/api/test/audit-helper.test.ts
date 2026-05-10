// Unit tests for `apps/api/src/lib/audit.ts:writeAudit`.
//
// Per ADR-0115 §Consequences, this helper MUST run inside the caller's
// transaction so that an audit row only commits when the action commits.
// We assert two contracts here:
//   1. writeAudit issues exactly one parametrised `INSERT INTO audit_log`
//      with the actor + target + JSON-encoded meta.
//   2. If the caller's transaction rolls back AFTER writeAudit runs, the
//      audit insert is part of the same logical batch — meaning the test
//      can observe the INSERT was issued, but in production the rollback
//      drops it. We assert the INSERT happens on the supplied client
//      object (not on a fresh pool client) which is what makes the
//      transactional guarantee work.

import { describe, expect, it, vi } from 'vitest'
import { writeAudit } from '../src/lib/audit.js'

interface RecordedQuery {
  text: string
  values: unknown[] | undefined
}

function makeClient(): {
  client: { query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
  calls: RecordedQuery[]
} {
  const calls: RecordedQuery[] = []
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      return { rows: [], rowCount: 0 }
    }),
  }
  return { client, calls }
}

const TENANT = {
  subscriptionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
}

describe('writeAudit', () => {
  it('issues an INSERT against the audit_log table on the supplied client', async () => {
    const { client, calls } = makeClient()
    await writeAudit(
      client as unknown as import('pg').PoolClient,
      TENANT,
      'vault.create',
      'vault-id-1',
      { name: 'Work' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toMatch(/INSERT INTO audit_log/i)
  })

  it('binds the five expected positional parameters', async () => {
    const { client, calls } = makeClient()
    await writeAudit(
      client as unknown as import('pg').PoolClient,
      TENANT,
      'note.delete',
      'note-id-9',
      { hard: false },
    )
    const params = calls[0]!.values!
    expect(params).toHaveLength(5)
    expect(params[0]).toBe(TENANT.subscriptionId)
    expect(params[1]).toBe(TENANT.userId)
    expect(params[2]).toBe('note.delete')
    expect(params[3]).toBe('note-id-9')
    // meta is JSON.stringify'd so the INSERT can cast it to jsonb in SQL.
    expect(typeof params[4]).toBe('string')
    expect(JSON.parse(params[4] as string)).toEqual({ hard: false })
  })

  it('propagates DB errors so the caller can rollback the surrounding tx', async () => {
    const client = {
      query: vi.fn(async () => {
        throw new Error('connection terminated')
      }),
    }
    await expect(
      writeAudit(
        client as unknown as import('pg').PoolClient,
        TENANT,
        'x.y',
        'target',
        {},
      ),
    ).rejects.toThrow(/connection terminated/)
    // The contract is: a thrown writeAudit must bubble up so the outer
    // withTenant() rolls back, taking the action row down with it. We
    // assert that by checking nothing is swallowed.
    expect(client.query).toHaveBeenCalledTimes(1)
  })

  it('serialises meta with no host-side mutation', async () => {
    const { client, calls } = makeClient()
    const meta = { nested: { key: 'value', arr: [1, 2, 3] } }
    await writeAudit(
      client as unknown as import('pg').PoolClient,
      TENANT,
      'x.y',
      'target',
      meta,
    )
    expect(JSON.parse(calls[0]!.values![4] as string)).toEqual(meta)
  })
})
