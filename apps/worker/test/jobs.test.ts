// Tests for the worker-side pg-boss producer.
//   - `enqueue` forwards name/payload/opts to boss.send
//   - `enqueueIndexNote` pins the singleton key so repeated index requests
//     for the same note coalesce
//   - boss.send errors propagate (unlike the API-side producer which
//     swallows them — the worker is happy to crash a handler so pg-boss
//     can retry)

import { afterEach, describe, expect, it, vi } from 'vitest'

const sendCalls: Array<{ name: string; payload: unknown; opts: unknown }> = []
let sendMode: 'ok' | 'throw' = 'ok'

vi.mock('pg-boss', () => {
  class StubBoss {
    on() {}
    async start() { return this }
    async send(name: string, payload: unknown, opts: unknown) {
      sendCalls.push({ name, payload, opts })
      if (sendMode === 'throw') throw new Error('boss-down')
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

describe('worker enqueue', () => {
  it('forwards the name, payload, and options to pg-boss.send', async () => {
    const { enqueue } = await import('../src/lib/jobs.js')
    const id = await enqueue('some-job', { hello: 'world' }, { retryLimit: 1 })
    expect(id).toBe('job-1')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]!.name).toBe('some-job')
    expect(sendCalls[0]!.payload).toEqual({ hello: 'world' })
    expect(sendCalls[0]!.opts).toEqual({ retryLimit: 1 })
  })

  it('propagates pg-boss failures rather than swallowing them', async () => {
    sendMode = 'throw'
    const { enqueue } = await import('../src/lib/jobs.js')
    await expect(enqueue('x', {})).rejects.toThrow(/boss-down/)
  })
})

describe('worker enqueueIndexNote', () => {
  it('uses a per-noteId singleton key so hot notes coalesce', async () => {
    const { enqueueIndexNote } = await import('../src/lib/jobs.js')
    await enqueueIndexNote({ subscriptionId: SUB, vaultId: VAULT, noteId: NOTE })
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]!.name).toBe('index-note')
    expect(sendCalls[0]!.payload).toEqual({
      subscriptionId: SUB,
      vaultId: VAULT,
      noteId: NOTE,
    })
    expect((sendCalls[0]!.opts as { singletonKey?: string }).singletonKey).toBe(
      `index-note:${NOTE}`,
    )
  })

  it('two concurrent enqueues for the same note share the singleton key', async () => {
    const { enqueueIndexNote } = await import('../src/lib/jobs.js')
    await enqueueIndexNote({ subscriptionId: SUB, vaultId: VAULT, noteId: NOTE })
    await enqueueIndexNote({ subscriptionId: SUB, vaultId: VAULT, noteId: NOTE })
    expect(sendCalls).toHaveLength(2)
    expect((sendCalls[0]!.opts as { singletonKey?: string }).singletonKey).toBe(
      (sendCalls[1]!.opts as { singletonKey?: string }).singletonKey,
    )
  })
})
