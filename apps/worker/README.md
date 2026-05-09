# @tolaria/worker

Background job runner backed by [`pg-boss`](https://github.com/timgit/pg-boss).
See [`docs/ARCHITECTURE-WEB-SAAS.md`](../../docs/ARCHITECTURE-WEB-SAAS.md) §8.

## Run locally

```bash
pnpm --filter @tolaria/worker dev
```

The worker connects to the same `DATABASE_URL` as the API and uses RLS the
same way — every job payload carries `subscriptionId` so the handler can wrap
its DB work in `withTenant({ subscriptionId, userId }, …)`.

## Job kinds

| name | producer | what it does |
|---|---|---|
| `index-note` | notes write path | recompute tsvector + embedding for one note |
| `rebuild-vault-index` | vault repair | full reindex |
| `propagate-rename` | rename RPC | update wikilinks across notes |
| `ai-tool-run` | AI agent route | long-running agent step |
| `r2-gc` | attachment delete | drop the R2 object after grace period |
