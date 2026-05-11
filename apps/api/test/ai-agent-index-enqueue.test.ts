// Regression test for G50: the AI agent's `vault.create_note` and
// `vault.write_note` tools must enqueue an `index-note` job after each
// successful write, mirroring the human-write path in `routes/notes.ts`.
//
// Before the fix, the agent could write notes that never had their
// `note_search` / `note_links` rows recomputed, so the search index and
// link graph silently drifted on every model-driven write. This test
// pins both paths against the jobs producer.

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

vi.mock('../src/middleware/rate-limit.js', () => ({
  AI_RATE_LIMIT: { capacity: 20, refillRate: 0.05 },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

// pg-boss producer mock — the assertion target.
const enqueueMock = vi.fn(async () => 'job-id')
vi.mock('../src/jobs/index.js', () => ({
  enqueue: enqueueMock,
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

const VAULT_ID = '11111111-1111-1111-1111-111111111111'
const NOTE_ID = '22222222-2222-2222-2222-222222222222'

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
      rows: [{ ai_credits_remaining: '0' }],
    },
  ]
  liteLlmStreamMock.mockReset()
  enqueueMock.mockClear()
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

describe('AI agent write tools enqueue index-note (G50)', () => {
  it('enqueues `index-note` after a successful vault.create_note tool call', async () => {
    // Match the INSERT INTO notes RETURNING row.
    dbState.matchers.push({
      match: /INSERT INTO notes/,
      rows: [
        {
          id: NOTE_ID,
          vault_id: VAULT_ID,
          folder_id: null,
          slug: 'hello',
          title: 'Hello',
          body_md: 'hi',
          frontmatter: {},
          word_count: 1,
          version: 1,
          created_at: new Date().toISOString(),
          modified_at: new Date().toISOString(),
        },
      ],
    })

    let round = 0
    liteLlmStreamMock.mockImplementation(async function* () {
      round += 1
      if (round === 1) {
        yield frameToolCall(
          'tc_1',
          'vault.create_note',
          JSON.stringify({
            vault_id: VAULT_ID,
            title: 'Hello',
            body_md: 'hi',
          }),
        )
        return
      }
      yield frameContent('done')
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: VAULT_ID,
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'make a note' }],
      }),
    )
    // Drain the SSE stream so the route runs to completion (including
    // the post-write enqueue).
    await readSse(res.body!)
    expect(res.status).toBe(200)

    // The producer must have been called with the canonical payload.
    expect(enqueueMock).toHaveBeenCalledWith('index-note', {
      subscriptionId: 'sub-1',
      vaultId: VAULT_ID,
      noteId: NOTE_ID,
    })
  })

  it('enqueues `index-note` after a successful vault.write_note tool call', async () => {
    // First query: the SELECT version FOR UPDATE.
    dbState.matchers.push({
      match: /SELECT version, frontmatter FROM notes/,
      rows: [{ version: 1, frontmatter: {} }],
    })
    // Second query: the UPDATE notes RETURNING.
    dbState.matchers.push({
      match: /UPDATE notes/,
      rows: [
        {
          id: NOTE_ID,
          vault_id: VAULT_ID,
          folder_id: null,
          slug: 'hello',
          title: 'Hello',
          body_md: 'updated',
          frontmatter: {},
          word_count: 1,
          version: 2,
          created_at: new Date().toISOString(),
          modified_at: new Date().toISOString(),
        },
      ],
    })

    let round = 0
    liteLlmStreamMock.mockImplementation(async function* () {
      round += 1
      if (round === 1) {
        yield frameToolCall(
          'tc_1',
          'vault.write_note',
          JSON.stringify({
            note_id: NOTE_ID,
            body_md: 'updated',
            expected_version: 1,
          }),
        )
        return
      }
      yield frameContent('done')
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: VAULT_ID,
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'update a note' }],
      }),
    )
    await readSse(res.body!)
    expect(res.status).toBe(200)

    expect(enqueueMock).toHaveBeenCalledWith('index-note', {
      subscriptionId: 'sub-1',
      vaultId: VAULT_ID,
      noteId: NOTE_ID,
    })
  })

  it('logs but does not fail the tool when enqueue throws', async () => {
    enqueueMock.mockImplementationOnce(() => {
      throw new Error('boss down')
    })

    dbState.matchers.push({
      match: /INSERT INTO notes/,
      rows: [
        {
          id: NOTE_ID,
          vault_id: VAULT_ID,
          folder_id: null,
          slug: 'hello',
          title: 'Hello',
          body_md: 'hi',
          frontmatter: {},
          word_count: 1,
          version: 1,
          created_at: new Date().toISOString(),
          modified_at: new Date().toISOString(),
        },
      ],
    })

    let round = 0
    liteLlmStreamMock.mockImplementation(async function* () {
      round += 1
      if (round === 1) {
        yield frameToolCall(
          'tc_1',
          'vault.create_note',
          JSON.stringify({
            vault_id: VAULT_ID,
            title: 'Hello',
            body_md: 'hi',
          }),
        )
        return
      }
      yield frameContent('done')
    })

    const app = await buildApp()
    const res = await app.fetch(
      fakeRequest({
        vault_id: VAULT_ID,
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'make a note' }],
      }),
    )
    const out = await readSse(res.body!)
    expect(res.status).toBe(200)
    // The stream still terminates cleanly.
    expect(out).toContain('event: done')
  })
})
