import { betterAuth } from 'better-auth'
import { pool } from '@/lib/db'

export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.V0_RUNTIME_URL),
  emailAndPassword: { enabled: true, autoSignIn: true, disableSignUp: false, async beforeSignUp({ user }: { user: { email: string } }) { if (user.email.toLowerCase() !== 'tired.afar-08@icloud.com') throw new Error('Sign-up is restricted.') } },
  trustedOrigins: [
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000', ...(process.env.V0_RUNTIME_URL ? [process.env.V0_RUNTIME_URL] : []), ...(process.env.V0_DEV_APP_URL ? [process.env.V0_DEV_APP_URL] : []), ...(process.env.V0_BUILD_URL ? [process.env.V0_BUILD_URL] : []), ...(process.env.V0_SANDBOX_URL ? [process.env.V0_SANDBOX_URL] : []), 'https://v0-felanders-a8ca141f.v0.build'] : []),
    ...(process.env.NODE_ENV === 'production' ? [...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []), ...(process.env.VERCEL_PROJECT_PRODUCTION_URL ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`] : []), ...(process.env.V0_RUNTIME_URL ? [process.env.V0_RUNTIME_URL] : []), ...(process.env.V0_DEV_APP_URL ? [process.env.V0_DEV_APP_URL] : []), ...(process.env.V0_BUILD_URL ? [process.env.V0_BUILD_URL] : []), ...(process.env.V0_SANDBOX_URL ? [process.env.V0_SANDBOX_URL] : []), 'https://v0-felanders-a8ca141f.v0.build'] : []),
  ],
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  ...(process.env.NODE_ENV === 'development' ? { advanced: { defaultCookieAttributes: { sameSite: 'none' as const, secure: true } } } : {}),
})
