import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { pool } from '@/lib/db'

/**
 * Sign-up is invitation-only: SIGNUP_ALLOWED_EMAILS is a comma-separated list of addresses that may create an account.
 * When it is empty, sign-up is disabled entirely — every account can trigger LLM calls billed to this deployment.
 */
const allowedSignups = (process.env.SIGNUP_ALLOWED_EMAILS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)

const vercelOrigins = [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL].filter((value): value is string => Boolean(value)).map((host) => `https://${host}`)
const extraOrigins = (process.env.TRUSTED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)

export const auth = betterAuth({
  database: pool,
  // In development the app runs on plain http://localhost; the Vercel/v0 URLs pulled into .env.development.local must not win here,
  // otherwise Better Auth issues an https-only (__Secure-) cookie the browser refuses to store and every sign-in silently drops.
  baseURL: process.env.BETTER_AUTH_URL ?? (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : vercelOrigins[1] ?? vercelOrigins[0]),
  emailAndPassword: { enabled: true, autoSignIn: true, disableSignUp: allowedSignups.length === 0 },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path !== '/sign-up/email') return
      const email = String((context.body as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase()
      if (!allowedSignups.includes(email)) throw new APIError('FORBIDDEN', { message: 'Sign-up is by invitation only.' })
    }),
  },
  trustedOrigins: [...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000'] : []), ...vercelOrigins, ...extraOrigins],
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  ...(process.env.NODE_ENV === 'development' ? { advanced: { defaultCookieAttributes: { sameSite: 'lax' as const, secure: false } } } : {}),
})
