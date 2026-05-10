import { afterEach, describe, expect, it, vi } from 'vitest'

interface QueryCall { text: string; values: unknown[] }
interface QueryResult { rows: unknown[]; rowCount: number }

const queries: QueryCall[] = []
let nextResults: QueryResult[] = []

const fakeClient = {
  query: vi.fn(async (text: string, values: unknown[] = []): Promise<QueryResult> => {
    queries.push({ text, values })
    return nextResults.shift() ?? { rows: [], rowCount: 0 }
  }),
}

vi.mock('../src/lib/db.js', () => ({
  withTenant: async <T>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) =>
    fn(fakeClient),
}))

const enqueueIndexNote = vi.fn(async () => 'job-id')
vi.mock('../src/lib/jobs.js', () => ({
  enqueueIndexNote,
}))

afterEach(() => {
  queries.length = 0
  nextResults = []
  fakeClient.query.mockClear()
  enqueueIndexNote.mockClear()
})

const SUB = '11111111-1111-1111-1111-111111111111'
const VAULT = '22222222-2222-2222-2222-222222222222'
const USER = '33333333-3333-3333-3333-333333333333'
const RUN = '44444444-4444-4444-4444-444444444444'

function makeJob(payload: Record<string, unknown>) {
  return { data: payload } as unknown
}

describe('handleAiToolRun — summarize-vault', () => {
  it('reads notes, calls litellm, and writes ai_runs.output_text', async () => {
    const { handleAiToolRun } = await import('../src/handlers/ai-tool-run.js')

    const litellm = {
      chat: vi.fn(async () => ({
        content: 'a concise summary',
        promptTokens: 12,
        completionTokens: 5,
      })),
    }

    // First withTenant: SELECT notes.
    nextResults.push({
      rows: [
        { title: 'A', body_md: 'body a' },
        { title: 'B', body_md: 'body b' },
      ],
      rowCount: 2,
    })
    // Second withTenant: UPDATE ai_runs + INSERT audit.
    nextResults.push({ rows: [], rowCount: 1 })
    nextResults.push({ rows: [], rowCount: 1 })

    await handleAiToolRun(
      makeJob({
        subscriptionId: SUB,
        vaultId: VAULT,
        userId: USER,
        runId: RUN,
        model: 'gpt-test',
        tool: 'summarize-vault',
        args: {},
      }) as Parameters<typeof handleAiToolRun>[0],
      { litellm },
    )

    expect(litellm.chat).toHaveBeenCalledTimes(1)
    const callArgs = litellm.chat.mock.calls[0]![0]
    expect(callArgs.model).toBe('gpt-test')
    expect(callArgs.messages[0]!.role).toBe('system')
    expect(callArgs.messages[1]!.content).toContain('# A')
    expect(callArgs.messages[1]!.content).toContain('# B')

    // ai_runs UPDATE captured the summary.
    const update = queries.find((q) => q.text.startsWith('UPDATE ai_runs'))!
    expect(update.values[0]).toBe(RUN)
    expect(update.values[1]).toBe(12)
    expect(update.values[2]).toBe(5)
    expect(update.values[3]).toBe('a concise summary')

    const audit = queries.find((q) => q.text.startsWith('INSERT INTO audit_log'))!
    expect(audit.values[2]).toBe('ai.tool_run.completed')
    expect(audit.values[3]).toBe(RUN)
  })
})

describe('handleAiToolRun — rebuild-graph', () => {
  it('enqueues an index-note job for every non-deleted note', async () => {
    const { handleAiToolRun } = await import('../src/handlers/ai-tool-run.js')

    nextResults.push({
      rows: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
      rowCount: 3,
    })
    nextResults.push({ rows: [], rowCount: 1 })
    nextResults.push({ rows: [], rowCount: 1 })

    await handleAiToolRun(
      makeJob({
        subscriptionId: SUB,
        vaultId: VAULT,
        userId: USER,
        runId: RUN,
        model: 'gpt-test',
        tool: 'rebuild-graph',
        args: {},
      }) as Parameters<typeof handleAiToolRun>[0],
    )

    expect(enqueueIndexNote).toHaveBeenCalledTimes(3)
    expect(enqueueIndexNote.mock.calls.map((c) => c[0]!.noteId)).toEqual([
      'n1',
      'n2',
      'n3',
    ])
  })
})

describe('handleAiToolRun — unsupported tool', () => {
  it('marks ai_runs as failed with unsupported_tool', async () => {
    const { handleAiToolRun } = await import('../src/handlers/ai-tool-run.js')
    nextResults.push({ rows: [], rowCount: 1 })

    await handleAiToolRun(
      makeJob({
        subscriptionId: SUB,
        vaultId: VAULT,
        userId: USER,
        runId: RUN,
        model: 'gpt-test',
        tool: 'unknown-tool',
        args: {},
      }) as Parameters<typeof handleAiToolRun>[0],
    )

    const update = queries.find((q) => q.text.startsWith('UPDATE ai_runs'))!
    expect(update.values).toEqual([RUN, 'unsupported_tool'])
  })
})
