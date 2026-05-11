// Integration test for `POST /ai/agent/run`.
//
// We mock the database (`withTenant`) and the LiteLLM client so the route
// runs in isolation. The route's agent loop is server-side, so we drive it
// by canned LiteLLM SSE frames that yield tool_calls or final assistant
// text. The test asserts:
//   - A run with no tool calls produces token, usage, done frames.
//   - A vault.search tool call hits the search SQL and feeds the result
//     back to the model on the next round.
//   - A failing tool produces a `tool_result` frame whose payload carries
//     `{ error: { code, message } }` and the loop continues.
//   - The 20-round safety cap aborts with a final `error` frame.
//   - `ai_runs` rows close as `succeeded` on clean exit and `failed` when
//     the upstream throws mid-stream.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RawSseFrame } from '../src/services/litellm.js'

// ── Test doubles ──────────────────────────────────────────────────────────

const dbState = {
  queries: [] as Array<{ text: string; params: ReadonlyArray<unknown> }>,
  matchers: [] as Array<{ match: RegExp; rows: unknown[] }>,
}

vi.mock('../src/db.js', () => ({
  withTenant: async <T>(
    _ctx: unknown,
    fn: (client: {
      query: (
        text: string,
        params?: ReadonlyArray<unknown>,
      ) => Promise<unknown>
    }) => Promise<T>,
  ): Promise<T> => {
    return fn({
      query: async (text: string, params: ReadonlyArray<unknown> = []) => {
        dbState.queries.push({ text, params })
        for (const m of dbState.matchers) {
          if (m.match.test(text)) return { rows: m.rows, rowCount: m.rows.length }
        }
        return { rows: [], rowCount: 0 }
      },
    })
  },
}))

// Stub the rate-limit middleware so its UPSERT is a no-op in unit tests
// (the real implementation needs a live `pool`, which we don't provide).
vi.mock('../src/middleware/rate-limit.js', () => ({
  AI_RATE_LIMIT: { capacity: 20, refillRate: 0.05 },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

const liteLlmStreamMock = vi.fn<
  (args: unknown, signal: AbortSignal) => AsyncIterable<RawSseFrame>
>()

vi.mock('../src/services/litellm.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/litellm.js')>(
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

const { aiAgent } = await import('../src/routes/ai-agent.js')

beforeEach(() => {
  dbState.queries = []
  dbState.matchers = [
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
    {
      match: /INSERT INTO ai_runs/,
      rows: [{ id: '00000000-0000-0000-0000-0000000000aa' }],
    },
    {
      match: /UPDATE subscriptions/,
      rows: [{ ai_credits_remaining: '321' }],
    },
  ]
  liteLlmStreamMock.mockReset()
})

// ── Helpers ───────────────────────────────────────────────────────────────

function fakeRequest(body: unknown): Request {
  return new Request('http://test.local/ai/agent/run', {
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

interface ParsedEvent {
  event: string
  data: { type: string; [k: string]: unknown }
}

function parseEvents(payload: string): ParsedEvent[] {
  return payload
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))!.slice(7)
      const data = lines.find((l) => l.startsWith('data: '))!.slice(6)
      return { event, data: JSON.parse(data) as ParsedEvent['data'] }
    })
}

function tenantMiddleware(): import('hono').MiddlewareHandler {
  return async (c, next) => {
    c.set('tenant', { subscriptionId: 'sub-1', userId: 'user-1' })
    await next()
  }
}

function frameContent(text: string): RawSseFrame {
  return { choices: [{ index: 0, delta: { content: text } }] }
}

function frameToolCall(
  id: string,
  name: string,
  argsJson: string,
): RawSseFrame {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id, type: 'function', function: { name, arguments: argsJson } },
          ],
        },
      },
    ],
  }
}

async function buildApp(): Promise<import('hono').Hono> {
  const { Hono } = await import('hono')
  return new Hono().use('*', tenantMiddleware()).route('/', aiAgent)
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('POST /ai/agent/run', () => {
  it('streams token, usage, and done events when the model emits no tool calls', async () => {
    liteLlmStreamMock.mockImplementation(async function* () {
      yield frameContent('Hello')
      yield frameContent(' world')
      yield { usage: { prompt_tokens: 4, completion_tokens: 6 } } as RawSseFrame
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(res.status).toBe(200)
    const events = parseEvents(await readSse(res.body!))
    const types = events.map((e) => e.event)
    expect(types).toContain('token')
    expect(types).toContain('usage')
    expect(types[types.length - 1]).toBe('done')
    expect(events.find((e) => e.event === 'usage')!.data).toMatchObject({
      type: 'usage',
      prompt_tokens: 4,
      completion_tokens: 6,
      credits_remaining: 321,
    })

    // Lifecycle: insert + update + audit start/success.
    const sqls = dbState.queries.map((q) => q.text)
    expect(sqls.some((s) => /INSERT INTO ai_runs/.test(s))).toBe(true)
    expect(sqls.some((s) => /UPDATE ai_runs/.test(s))).toBe(true)
    const audits = dbState.queries
      .filter((q) => /INSERT INTO audit_log/.test(q.text))
      .map((q) => q.params[2])
    expect(audits).toContain('ai.run.start')
    expect(audits).toContain('ai.run.success')
  })

  it('runs vault.search server-side and feeds the result back to the model', async () => {
    let round = 0
    liteLlmStreamMock.mockImplementation(async function* () {
      round += 1
      if (round === 1) {
        // First round: model asks for vault.search.
        yield frameToolCall(
          'tc_1',
          'vault.search',
          '{"vault_id":"11111111-1111-1111-1111-111111111111","query":"foo"}',
        )
        return
      }
      // Second round: with the tool result in scope, the model answers.
      yield frameContent('Found it.')
    })

    // Inject a row for the search SQL match.
    dbState.matchers.push({
      match: /websearch_to_tsquery/,
      rows: [
        {
          note_id: 'note-1',
          title: 'Foo',
          snippet: 'a foo snippet',
          score: 0.5,
        },
      ],
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'find foo' }],
      }),
    )
    const events = parseEvents(await readSse(res.body!))
    const types = events.map((e) => e.event)
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_result')
    expect(types).toContain('token')
    expect(types[types.length - 1]).toBe('done')
    expect(round).toBe(2) // model was re-invoked after the tool ran

    const toolResult = events.find((e) => e.event === 'tool_result')!.data as {
      type: string
      id: string
      result: { results: Array<{ note_id: string }> }
    }
    expect(toolResult.id).toBe('tc_1')
    expect(toolResult.result.results[0]!.note_id).toBe('note-1')

    // The search SQL ran (proof of server-side execution).
    const sqls = dbState.queries.map((q) => q.text)
    expect(sqls.some((s) => /websearch_to_tsquery/.test(s))).toBe(true)

    // ai.tool.run audit row landed for the invocation.
    const audits = dbState.queries
      .filter((q) => /INSERT INTO audit_log/.test(q.text))
      .map((q) => q.params[2])
    expect(audits).toContain('ai.tool.run')
  })

  it('emits a tool_result error and continues the loop when a tool fails', async () => {
    let round = 0
    liteLlmStreamMock.mockImplementation(async function* () {
      round += 1
      if (round === 1) {
        // Unknown tool name → runner throws → tool_result carries error.
        yield frameToolCall('tc_x', 'vault.does_not_exist', '{}')
        return
      }
      // Loop survived; model produces a final answer.
      yield frameContent('OK')
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'try a bad tool' }],
      }),
    )
    const events = parseEvents(await readSse(res.body!))
    const types = events.map((e) => e.event)
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_result')
    // Loop did NOT crash; we still emit token + done.
    expect(types).toContain('token')
    expect(types[types.length - 1]).toBe('done')

    const toolResult = events.find((e) => e.event === 'tool_result')!.data as {
      result: { error?: { code: string; message: string } }
    }
    expect(toolResult.result.error).toBeDefined()
    expect(toolResult.result.error!.code).toBe('unknown_tool')
    expect(toolResult.result.error!.message).toContain('vault.does_not_exist')
  })

  it('aborts with an error frame when the safety cap is exceeded', async () => {
    // Every round produces a (different) tool call so the loop never
    // converges on a final answer. With the 20-round ceiling we should
    // see exactly 20 tool_call events and a terminal `error` frame.
    let round = 0
    liteLlmStreamMock.mockImplementation(async function* () {
      round += 1
      yield frameToolCall(
        `tc_${round}`,
        'vault.list_notes',
        '{"vault_id":"11111111-1111-1111-1111-111111111111"}',
      )
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'spin forever' }],
      }),
    )
    const events = parseEvents(await readSse(res.body!))
    const types = events.map((e) => e.event)
    expect(types[types.length - 1]).toBe('error')
    const errorFrame = events[events.length - 1]!.data as {
      type: 'error'
      message: string
    }
    expect(errorFrame.message).toBe('agent_safety_cap_exceeded')
    // Hard ceiling is 20 rounds of upstream invocations.
    expect(round).toBe(20)

    // Run was closed as failed.
    const audits = dbState.queries
      .filter((q) => /INSERT INTO audit_log/.test(q.text))
      .map((q) => q.params[2])
    expect(audits).toContain('ai.run.failure')
  })

  it('marks the run as failed and emits an error frame on upstream failure mid-stream', async () => {
    liteLlmStreamMock.mockImplementation(async function* () {
      yield frameContent('partial')
      throw new Error('upstream exploded')
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: '11111111-1111-1111-1111-111111111111',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'go' }],
      }),
    )
    const events = parseEvents(await readSse(res.body!))
    const types = events.map((e) => e.event)
    expect(types).toContain('token')
    expect(types[types.length - 1]).toBe('error')
    const last = events[events.length - 1]!.data as { message: string }
    expect(last.message).toContain('upstream exploded')

    const audits = dbState.queries
      .filter((q) => /INSERT INTO audit_log/.test(q.text))
      .map((q) => q.params[2])
    expect(audits).toContain('ai.run.start')
    expect(audits).toContain('ai.run.failure')
  })
})
