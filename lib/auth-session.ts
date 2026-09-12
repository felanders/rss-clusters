import { headers } from 'next/headers'
import { auth } from '@/lib/auth'

/**
 * Resolves the signed-in Better Auth user.
 * Deliberately accepts no override: every export of a 'use server' module is a
 * public endpoint, so a caller-supplied user id would let any visitor read and
 * mutate another account's feeds.
 */
export async function requireUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}
