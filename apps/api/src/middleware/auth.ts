import type { Context, MiddlewareHandler } from 'hono'
import { jwtVerify, SignJWT } from 'jose'
import { loadEnv } from '../env.js'
import { Unauthenticated } from '../lib/errors.js'

const env = loadEnv()
const SECRET = new TextEncoder().encode(env.AUTH_JWT_SECRET)
const ISSUER = env.API_PUBLIC_URL
const AUDIENCE = 'tolaria-spa'

export interface AccessTokenClaims {
  sub: string                  // user id
  sid: string                  // subscription id
  role: 'owner' | 'admin' | 'member'
  jti: string
}

export async function mintAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.AUTH_JWT_ACCESS_TTL_SECONDS}s`)
    .sign(SECRET)
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  })
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.jti !== 'string' ||
    (payload.role !== 'owner' && payload.role !== 'admin' && payload.role !== 'member')
  ) {
    throw Unauthenticated('Malformed access token')
  }
  return {
    sub: payload.sub,
    sid: payload.sid,
    role: payload.role,
    jti: payload.jti,
  }
}

/**
 * requireAuth extracts the bearer token (or `?access_token=` for SSE) and
 * stashes the verified claims on `c.set('user', …)` for downstream handlers.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const claims = await tryReadClaims(c)
  if (!claims) throw Unauthenticated()
  c.set('user', claims)
  await next()
}

async function tryReadClaims(c: Context): Promise<AccessTokenClaims | null> {
  const header = c.req.header('authorization')
  if (header?.toLowerCase().startsWith('bearer ')) {
    return verifyAccessToken(header.slice(7).trim())
  }
  const queryToken = c.req.query('access_token')
  if (queryToken) return verifyAccessToken(queryToken)
  return null
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AccessTokenClaims
  }
}
