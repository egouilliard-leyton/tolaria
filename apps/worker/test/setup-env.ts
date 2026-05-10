// Worker tests stub the env so the loader does not throw on missing values.
// Real values are not required — every test that touches env-dependent
// surfaces stubs the dependency directly via vi.mock.
process.env.NODE_ENV ??= 'test'
process.env.LOG_LEVEL ??= 'fatal'
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test'
process.env.WORKER_CONCURRENCY ??= '4'
process.env.R2_ENDPOINT ??= 'http://localhost:9000'
process.env.R2_ACCESS_KEY_ID ??= 'test-access'
process.env.R2_SECRET_ACCESS_KEY ??= 'test-secret'
process.env.R2_BUCKET ??= 'test-bucket'
process.env.LITELLM_BASE_URL ??= 'http://litellm.test'
process.env.LITELLM_TOKEN ??= 'test-litellm-token'
