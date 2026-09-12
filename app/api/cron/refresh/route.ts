import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { errorMessage } from '@/lib/ai/openrouter'
import { refreshAllFeedsForUser, refreshAndClusterAllForUser } from '@/lib/feeds/service'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Vercel cron schedules are UTC. The Berlin gate below only matches when the
 * cron actually fires at 07:00 Europe/Berlin, which is 05:00 UTC in summer and
 * 06:00 UTC in winter -- hence two entries in vercel.json.
 */
function isScheduledBerlinHour(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  )

  return hour === 7
}

export async function GET(request: Request) {
  const authorization = request.headers.get('authorization')

  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isScheduledBerlinHour()) {
    return NextResponse.json({
      skipped: true,
      reason: 'Outside configured Europe/Berlin schedule',
    })
  }

  const mode =
    process.env.SCHEDULED_CLUSTERING_MODE === 'refresh-only'
      ? 'refresh-only'
      : 'refresh-and-cluster'

  const accounts = await db.select({ id: user.id }).from(user)
  const results = []

  for (const account of accounts) {
    try {
      const result =
        mode === 'refresh-only'
          ? { feeds: await refreshAllFeedsForUser(account.id) }
          : await refreshAndClusterAllForUser(account.id)

      results.push({ userId: account.id, ...result })
    } catch (error) {
      // One failing account must not abort the whole scheduled run.
      results.push({ userId: account.id, error: errorMessage(error, 'Scheduled run failed') })
    }
  }

  return NextResponse.json({ mode, ranAt: new Date().toISOString(), results })
}
