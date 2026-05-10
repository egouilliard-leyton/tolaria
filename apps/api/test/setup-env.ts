// Minimal env so apps/api's Zod-validated env.ts will load. Real values are
// not required — every test that touches env-dependent surfaces stubs the
// dependency directly.
process.env.NODE_ENV ??= 'test'
process.env.LOG_LEVEL ??= 'fatal'
process.env.API_PUBLIC_URL ??= 'http://localhost:8787'
process.env.WEB_PUBLIC_URL ??= 'http://localhost:5173'
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test'
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-must-be-at-least-32-bytes-long-padding'
process.env.AUTH_PROVIDER_SECRET_KEY ??= '0123456789abcdef0123456789abcdef'
process.env.R2_ENDPOINT ??= 'http://localhost:9000'
process.env.R2_ACCOUNT_ID ??= 'test-account'
process.env.R2_ACCESS_KEY_ID ??= 'test-access'
process.env.R2_SECRET_ACCESS_KEY ??= 'test-secret'
process.env.R2_BUCKET ??= 'test-bucket'
process.env.LITELLM_BASE_URL ??= 'http://litellm.test'
process.env.LITELLM_TOKEN ??= 'test-litellm-token'
