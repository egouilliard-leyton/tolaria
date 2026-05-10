// Plain Node TS script. Run with: pnpm db:migrate
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const url = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_MIGRATOR_URL or DATABASE_URL must be set')

const client = new pg.Client({ connectionString: url })
await client.connect()

// idempotent _migrations table
await client.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`)

const files = (await readdir(join(here, 'migrations')))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()

for (const file of files) {
  const { rowCount } = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file])
  if (rowCount === 1) {
    console.log(`skip  ${file}`)
    continue
  }
  const sql = await readFile(join(here, 'migrations', file), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file])
    await client.query('COMMIT')
    console.log(`apply ${file}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

await client.end()
