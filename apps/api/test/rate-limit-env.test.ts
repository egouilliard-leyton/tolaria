// Bundle H §3 — the AUTH_RATE_LIMIT / AI_RATE_LIMIT / SEARCH_RATE_LIMIT named
// exports keep the same shape, but their values now come from env vars. This
// test sets each env override before the module is loaded and asserts the
// exported config reflects the override.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'k'.repeat(32)
  process.env.R2_ENDPOINT = 'http://localhost:9000'
  process.env.R2_ACCOUNT_ID = 'x'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  process.env.R2_BUCKET = 'x'
  process.env.LITELLM_BASE_URL = 'http://localhost:4000'
  process.env.LITELLM_TOKEN = 'x'
})

afterAll(() => {
  process.env = { ...ORIG_ENV }
})

afterEach(() => {
  // Clear so each test starts from a clean slate.
  delete process.env.AUTH_RATE_LIMIT_BURST
  delete process.env.AUTH_RATE_LIMIT_REFILL
  delete process.env.AI_RATE_LIMIT_BURST
  delete process.env.AI_RATE_LIMIT_REFILL
  delete process.env.SEARCH_RATE_LIMIT_BURST
  delete process.env.SEARCH_RATE_LIMIT_REFILL
})

describe('rate-limit env tuning (Bundle H §3)', () => {
  it('exports the default budgets when the env vars are absent', async () => {
    vi.resetModules()
    const mod = await import('../src/middleware/rate-limit.js')
    expect(mod.AUTH_RATE_LIMIT).toEqual({ capacity: 10, refillRate: 0.5 })
    expect(mod.AI_RATE_LIMIT).toEqual({ capacity: 20, refillRate: 0.05 })
    expect(mod.SEARCH_RATE_LIMIT).toEqual({ capacity: 60, refillRate: 1 })
  })

  it('honors AUTH_RATE_LIMIT_BURST + AUTH_RATE_LIMIT_REFILL', async () => {
    process.env.AUTH_RATE_LIMIT_BURST = '99'
    process.env.AUTH_RATE_LIMIT_REFILL = '2.5'
    vi.resetModules()
    const mod = await import('../src/middleware/rate-limit.js')
    expect(mod.AUTH_RATE_LIMIT.capacity).toBe(99)
    expect(mod.AUTH_RATE_LIMIT.refillRate).toBe(2.5)
  })

  it('honors AI_RATE_LIMIT_BURST + AI_RATE_LIMIT_REFILL', async () => {
    process.env.AI_RATE_LIMIT_BURST = '7'
    process.env.AI_RATE_LIMIT_REFILL = '0.25'
    vi.resetModules()
    const mod = await import('../src/middleware/rate-limit.js')
    expect(mod.AI_RATE_LIMIT.capacity).toBe(7)
    expect(mod.AI_RATE_LIMIT.refillRate).toBe(0.25)
  })

  it('honors SEARCH_RATE_LIMIT_BURST + SEARCH_RATE_LIMIT_REFILL', async () => {
    process.env.SEARCH_RATE_LIMIT_BURST = '120'
    process.env.SEARCH_RATE_LIMIT_REFILL = '5'
    vi.resetModules()
    const mod = await import('../src/middleware/rate-limit.js')
    expect(mod.SEARCH_RATE_LIMIT.capacity).toBe(120)
    expect(mod.SEARCH_RATE_LIMIT.refillRate).toBe(5)
  })
})
