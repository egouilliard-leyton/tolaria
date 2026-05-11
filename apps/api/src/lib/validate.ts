// Small wrappers that turn Zod errors into our typed InvalidInput.
// Keeps every route handler from repeating the same try/catch.

import type { Context } from 'hono'
import type { ZodTypeAny, infer as ZodInfer } from 'zod'
import { InvalidInput } from './errors.js'

export async function readJson<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<ZodInfer<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw InvalidInput('request body must be valid JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw InvalidInput('invalid request body', formatZodIssues(parsed.error.issues))
  }
  return parsed.data
}

export function readQuery<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): ZodInfer<S> {
  const parsed = schema.safeParse(c.req.query())
  if (!parsed.success) {
    throw InvalidInput('invalid query string', formatZodIssues(parsed.error.issues))
  }
  return parsed.data
}

export function readParams<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): ZodInfer<S> {
  const parsed = schema.safeParse(c.req.param())
  if (!parsed.success) {
    throw InvalidInput('invalid path parameter', formatZodIssues(parsed.error.issues))
  }
  return parsed.data
}

interface ZodIssueLike {
  path: ReadonlyArray<string | number>
  message: string
}

function formatZodIssues(
  issues: ReadonlyArray<ZodIssueLike>,
): { issues: Array<{ path: string; message: string }> } {
  return {
    issues: issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  }
}
