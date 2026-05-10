// Integration test for `POST /ai/chat`.
//
// We mock the database (`withTenant`) and the LiteLLM client so the route
// runs in isolation. The test asserts:
//   - the route translates upstream OpenAI-style frames into our
//     `AiStreamEvent` union (token, tool_call, usage, done).
//   - the route emits a final `usage` frame with the post-decrement credit
//     balance, then `done`.
//   - the run is recorded as `running` then closed as `succeeded`.
//
// We also assert `translateFrame`'s behavior directly for a few corner
// cases that are awkward to drive end-to-end.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RawSseFrame } from '../src/services/litellm.js'

// ── Test doubles ──────────────────────────────────────────────────────────

const dbState = {
  // Each call to withTenant gets a fresh "client" backed by `queryMock`.
  queries: [] as Array<{ text: string; params: ReadonlyArray<unknown> }>,
  // Configurable per-test responses, keyed by the SQL substring we match.
  matchers: [] as Array<{ match: RegExp; rows: unknown[] }>,
}

vi.mock('../src/db.js', () => ({
  withTenant: async <T>(
    _ctx: unknown,
    fn: (client: { query: (text: string, params?: ReadonlyArray<unknown>) => Promise<unknown> }) => Promise<T>,
  ): Promise<T> => {
    return fn({
      query: async (text: string, params: ReadonlyArray<unknown> = []) => {
        dbState.queries.push({ text, params })
        for (const m of dbState.matchers) {
          if (m.match.test(text)) return { rows: m.rows }
        }
        return { rows: [] }
      },
    })
  },
}))

const liteLlmStreamMock = vi.fn<
  (args: unknown, signal: AbortSignal) => AsyncIterable<RawSseFrame>
>()

vi.mock('../src/services/litellm.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/services/litellm.js')>(
      '../src/services/litellm.js',
    )
  return {
    ...actual,
    liteLlm: () => ({
      streamChat: liteLlmStreamMock,
      health: async () => 'ok' as const,
    }),
  }
})

// ── System under test ────────────────────────────────────────────────────

const { ai, translateFrame } = await import('../src/routes/ai.js')

beforeEach(() => {
  dbState.queries = []
  dbState.matchers = [
    // resolveModel
    {
      match: /FROM ai_models/,
      rows: [
        {
          id: 'm1',
          subscription_id: null,
          provider: 'openai',
          name: 'gpt-4o',
          display_name: 'GPT-4o',
          capabilities: {},
          enabled: true,
          default_for_kind: 'chat',
        },
      ],
    },
    // startAiRun INSERT … RETURNING id
    {
      match: /INSERT INTO ai_runs/,
      rows: [{ id: '00000000-0000-0000-0000-0000000000aa' }],
    },
    // decrementCredits UPDATE subscriptions … RETURNING ai_credits_remaining
    {
      match: /UPDATE subscriptions/,
      rows: [{ ai_credits_remaining: '987' }],
    },
  ]
  liteLlmStreamMock.mockReset()
})

// ── Helpers ───────────────────────────────────────────────────────────────

function fakeRequest(body: unknown): Request {
  return new Request('http://test.local/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value)
  }
  return out
}

function parseEvents(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))!.slice(7)
      const data = lines.find((l) => l.startsWith('data: '))!.slice(6)
      return { event, data: JSON.parse(data) }
    })
}

function tenantMiddleware(): import('hono').MiddlewareHandler {
  return async (c, next) => {
    c.set('tenant', { subscriptionId: 'sub-1', userId: 'user-1' })
    await next()
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('translateFrame', () => {
  it('emits a token event for each non-empty content delta', () => {
    const frame: RawSseFrame = {
      choices: [{ index: 0, delta: { content: 'Hi' } }],
    }
    const events = [...translateFrame(frame, () => undefined)]
    expect(events).toEqual([{ type: 'token', delta: 'Hi' }])
  })

  it('skips tool_call deltas with unparseable arguments', () => {
    const frame: RawSseFrame = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { id: 'tc_1', type: 'function', function: { name: 'foo', arguments: '{ "x":' } },
            ],
          },
        },
      ],
    }
    const events = [...translateFrame(frame, () => undefined)]
    expect(events).toEqual([])
  })

  it('emits tool_call when arguments JSON is complete', () => {
    const frame: RawSseFrame = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
            ],
          },
        },
      ],
    }
    const events = [...translateFrame(frame, () => undefined)]
    expect(events).toEqual([
      { type: 'tool_call', id: 'tc_1', name: 'search', args: { q: 'x' } },
    ])
  })

  it('reports usage via the callback rather than yielding an event', () => {
    const usage: Array<{ prompt?: number; completion?: number }> = []
    const events = [
      ...translateFrame({ usage: { prompt_tokens: 5, completion_tokens: 7 } }, (u) =>
        usage.push(u),
      ),
    ]
    expect(events).toEqual([])
    expect(usage).toEqual([{ prompt: 5, completion: 7 }])
  })
})

describe('POST /ai/chat', () => {
  it('streams token, usage, and done events for a successful run', async () => {
    liteLlmStreamMock.mockImplementation(async function* () {
      yield { choices: [{ index: 0, delta: { content: 'Hello' } }] } as RawSseFrame
      yield { choices: [{ index: 0, delta: { content: ' world' } }] } as RawSseFrame
      yield { usage: { prompt_tokens: 3, completion_tokens: 2 } } as RawSseFrame
    })

    const { Hono } = await import('hono')
    const app = new Hono().use('*', tenantMiddleware()).route('/', ai)

    const res = await app.fetch(
      fakeRequest({
        vaultId: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const events = parseEvents(await readSse(res.body!))
    expect(events.map((e) => e.event)).toEqual(['token', 'token', 'usage', 'done'])
    expect(events[0]!.data).toEqual({ type: 'token', delta: 'Hello' })
    expect(events[2]!.data).toMatchObject({
      type: 'usage',
      promptTokens: 3,
      completionTokens: 2,
      creditsRemaining: 987,
    })

    // Audit + ai_runs lifecycle: insert + update + decrement subs.
    const sqls = dbState.queries.map((q) => q.text)
    expect(sqls.some((s) => /INSERT INTO ai_runs/.test(s))).toBe(true)
    expect(sqls.some((s) => /UPDATE ai_runs/.test(s))).toBe(true)
    expect(sqls.some((s) => /UPDATE subscriptions/.test(s))).toBe(true)
    // ai.run.start + ai.run.success audit rows.
    const audits = dbState.queries
      .filter((q) => /INSERT INTO audit_log/.test(q.text))
      .map((q) => q.params[2])
    expect(audits).toContain('ai.run.start')
    expect(audits).toContain('ai.run.success')
  })

  it('emits an error event and closes the run when the upstream throws', async () => {
    liteLlmStreamMock.mockImplementation(async function* () {
      yield { choices: [{ index: 0, delta: { content: 'partial' } }] } as RawSseFrame
      throw new Error('upstream exploded')
    })

    const { Hono } = await import('hono')
    const app = new Hono().use('*', tenantMiddleware()).route('/', ai)

    const res = await app.fetch(
      fakeRequest({
        vaultId: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    const events = parseEvents(await readSse(res.body!))
    const types = events.map((e) => e.event)
    expect(types).toContain('token')
    expect(types[types.length - 1]).toBe('error')
    expect((events[events.length - 1]!.data as { message: string }).message).toContain(
      'upstream exploded',
    )

    const audits = dbState.queries
      .filter((q) => /INSERT INTO audit_log/.test(q.text))
      .map((q) => q.params[2])
    expect(audits).toContain('ai.run.start')
    expect(audits).toContain('ai.run.failure')
  })

  it('rejects an unknown model with 403 forbidden', async () => {
    // Override the ai_models matcher to return zero rows.
    dbState.matchers = dbState.matchers.map((m) =>
      /FROM ai_models/.test(m.match.source) ? { ...m, rows: [] } : m,
    )

    const { Hono } = await import('hono')
    const app = new Hono()
      .onError((err, c) => {
        const e = err as unknown as { status?: number; code?: string; message?: string }
        if (e.status === 403) {
          return c.json(
            { error: { code: e.code ?? 'forbidden', message: e.message ?? '' } },
            403,
          )
        }
        return c.json({ error: { code: 'internal', message: err.message } }, 500)
      })
      .use('*', tenantMiddleware())
      .route('/', ai)

    const res = await app.fetch(
      fakeRequest({
        vaultId: '11111111-1111-1111-1111-111111111111',
        model: 'nope',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: { message: string } }
    expect(json.error.message).toBe('model_unavailable')
  })
})
