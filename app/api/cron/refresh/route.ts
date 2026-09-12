import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { syncAllFeeds } from '@/lib/feeds'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Daily refresh for every user: fetch feeds → embed new articles → cluster them.
 * The schedule lives in vercel.json (cron expressions there are UTC); Vercel may fire it a little after the minute, so no
 * further time checks happen here — the CRON_SECRET header is what protects the route.
 */
export async function GET(request: Request) {
  const authorization = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const mode = process.env.SCHEDULED_CLUSTERING_MODE === 'refresh-only' ? 'refresh-only' : 'refresh-and-cluster'
  const users = await db.select({ id: user.id }).from(user)
  const results = []
  for (const account of users) {
    try {
      results.push({ userId: account.id, ...await syncAllFeeds(account.id, { cluster: mode !== 'refresh-only' }) })
    } catch (error) {
      results.push({ userId: account.id, error: error instanceof Error ? error.message : 'Refresh failed' })
    }
  }
  return NextResponse.json({ mode, ranAt: new Date().toISOString(), results })
}
