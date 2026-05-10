// Tests for the API-side pg-boss producers:
//   - `enqueue` — generic dispatch with options pass-through, swallows
//     boss errors so a failed write never bricks a successful response.
//   - `enqueueRebuildVaultIndex` — pins the singleton key shape so two
//     concurrent reindex requests for the same vault coalesce.
//   - `scheduleR2Gc` — pins the per-attachment singleton key + retry
//     budget.

import { afterEach, describe, expect, it, vi } from 'vitest'

// pg-boss is the only side-effect target. We replace the default export
// with a stub class that records `send` calls.
const sendCalls: Array<{ name: string; payload: unknown; opts: unknown }> = []
let sendMode: 'ok' | 'throw' = 'ok'

vi.mock('pg-boss', () => {
  class StubBoss {
    on() {}
    async start() {
      return this
    }
    async send(name: string, payload: unknown, opts: unknown) {
      sendCalls.push({ name, payload, opts })
      if (sendMode === 'throw') throw new Error('pg-boss down')
      return `job-${sendCalls.length}`
    }
    async stop() {}
  }
  return { default: StubBoss }
})

afterEach(() => {
  sendCalls.length = 0
  sendMode = 'ok'
  vi.resetModules()
})

const SUB = '11111111-1111-4111-8111-111111111111'
const VAULT = '22222222-2222-4222-8222-222222222222'
const NOTE = '33333333-3333-4333-8333-333333333333'
const ATT = '44444444-4444-4444-4444-444444444444'

describe('enqueue', () => {
  it('forwards name, payload and options to pg-boss.send and returns the job id', async () => {
    const { enqueue } = await import('../src/jobs/index.js')
    const id = await enqueue(
      'index-note',
      { subscriptionId: SUB, vaultId: VAULT, noteId: NOTE },
      { retryLimit: 2, singletonKey: 'k' },
    )
    expect(id).toBe('job-1')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]!.name).toBe('index-note')
    expect(sendCalls[0]!.payload).toEqual({
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: NOTE,
    })
    expect(sendCalls[0]!.opts).toEqual({ retryLimit: 2, singletonKey: 'k' })
  })

  it('swallows pg-boss failures and returns null instead of throwing', async () => {
    sendMode = 'throw'
    const { enqueue } = await import('../src/jobs/index.js')
    const id = await enqueue('index-note', {
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: NOTE,
    })
    expect(id).toBeNull()
  })
})

describe('enqueueRebuildVaultIndex', () => {
  it('pins the singleton key to `rebuild-vault-index:<sub>:<vault>`', async () => {
    const { enqueueRebuildVaultIndex } = await import('../src/jobs/index.js')
    await enqueueRebuildVaultIndex(SUB, VAULT)
    expect(sendCalls).toHaveLength(1)
    const { name, payload, opts } = sendCalls[0]!
    expect(name).toBe('rebuild-vault-index')
    expect(payload).toEqual({ subscriptionId: SUB, vaultId: VAULT })
    expect((opts as { singletonKey?: string }).singletonKey).toBe(
      `rebuild-vault-index:${SUB}:${VAULT}`,
    )
    expect((opts as { retryLimit?: number }).retryLimit).toBe(3)
  })
})

describe('scheduleR2Gc', () => {
  it('pins the singleton key to the attachmentId and sets a retry budget of 5', async () => {
    const { scheduleR2Gc } = await import('../src/jobs/r2-gc.js')
    await scheduleR2Gc({
      subscriptionId: SUB,
      attachmentId: ATT,
      keyR2: 'some/key',
    })
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]!.name).toBe('r2-gc')
    expect((sendCalls[0]!.opts as { singletonKey?: string }).singletonKey).toBe(
      ATT,
    )
    expect((sendCalls[0]!.opts as { retryLimit?: number }).retryLimit).toBe(5)
  })

  it('returns null when pg-boss is unhealthy without bubbling up', async () => {
    sendMode = 'throw'
    const { scheduleR2Gc } = await import('../src/jobs/r2-gc.js')
    const id = await scheduleR2Gc({
      subscriptionId: SUB,
      attachmentId: ATT,
    })
    expect(id).toBeNull()
  })
})
