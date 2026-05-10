// Unit tests for src/services/model-registry.ts.
//
// We mock `withTenant` to feed the resolver synthetic rows. The point of
// these tests is not to exercise the SQL — that's a job for a future
// integration suite — but to lock in the fallback ordering: tenant rows
// must beat platform rows for the same name, and a missing-or-disabled
// model must throw `Forbidden('model_unavailable')`.

import { afterEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()

vi.mock('../src/db.js', () => ({
  withTenant: async <T>(
    _ctx: unknown,
    fn: (client: { query: typeof queryMock }) => Promise<T>,
  ): Promise<T> => fn({ query: queryMock }),
}))

const { resolveModel, listModels } = await import('../src/services/model-registry.js')

const ctx = { subscriptionId: '11111111-1111-1111-1111-111111111111', userId: 'u' }

afterEach(() => queryMock.mockReset())

describe('resolveModel', () => {
  it('returns the tenant override when one exists', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'a',
          subscription_id: ctx.subscriptionId,
          provider: 'openai',
          name: 'gpt-4o',
          display_name: 'GPT-4o (custom)',
          capabilities: {},
          enabled: true,
          default_for_kind: null,
        },
      ],
    })
    const out = await resolveModel(ctx, 'gpt-4o')
    expect(out.subscriptionId).toBe(ctx.subscriptionId)
    expect(out.displayName).toBe('GPT-4o (custom)')
  })

  it('falls back to a platform-default when no tenant row exists', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'b',
          subscription_id: null,
          provider: 'openai',
          name: 'gpt-4o',
          display_name: 'GPT-4o',
          capabilities: {},
          enabled: true,
          default_for_kind: 'chat',
        },
      ],
    })
    const out = await resolveModel(ctx, 'gpt-4o')
    expect(out.subscriptionId).toBeNull()
  })

  it('throws Forbidden(model_unavailable) when neither row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await expect(resolveModel(ctx, 'mystery')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'model_unavailable',
    })
  })

  it('issues a query that filters on enabled=true and orders tenant rows first', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await expect(resolveModel(ctx, 'x')).rejects.toMatchObject({ code: 'forbidden' })
    const sql = queryMock.mock.calls[0]![0] as string
    expect(sql).toMatch(/enabled\s*=\s*true/)
    // Tenant rows have subscription_id IS NOT NULL, so we sort by
    // (subscription_id IS NULL) ASC to put them first.
    expect(sql).toMatch(/subscription_id IS NULL\)\s+ASC/)
    expect(sql).toMatch(/LIMIT 1/)
  })
})

describe('listModels', () => {
  it('dedupes by name with subscription override winning over platform', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        // Sorted by name asc, then (subscription_id IS NULL) asc, so the
        // tenant row precedes the global row for the same name.
        {
          id: 'a',
          subscription_id: ctx.subscriptionId,
          provider: 'openai',
          name: 'gpt-4o',
          display_name: 'GPT-4o (custom)',
          capabilities: {},
          enabled: true,
          default_for_kind: null,
        },
        {
          id: 'b',
          subscription_id: null,
          provider: 'openai',
          name: 'gpt-4o',
          display_name: 'GPT-4o',
          capabilities: {},
          enabled: true,
          default_for_kind: 'chat',
        },
        {
          id: 'c',
          subscription_id: null,
          provider: 'anthropic',
          name: 'sonnet-4',
          display_name: 'Claude Sonnet 4',
          capabilities: {},
          enabled: true,
          default_for_kind: null,
        },
      ],
    })
    const out = await listModels(ctx)
    expect(out.map((m) => m.name)).toEqual(['gpt-4o', 'sonnet-4'])
    expect(out[0]!.displayName).toBe('GPT-4o (custom)')
    expect(out[0]!.subscriptionId).toBe(ctx.subscriptionId)
  })
})
