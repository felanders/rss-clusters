import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { refreshAllFeeds, refreshAndClusterAll } from '@/app/actions/feeds'

export const maxDuration = 300

function isScheduledBerlinTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  return minute === 0 && [7, 10, 13, 17].includes(hour)
}

export async function GET(request: Request) {
  const authorization = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isScheduledBerlinTime()) {
    return NextResponse.json({ skipped: true, reason: 'Outside configured Europe/Berlin schedule' })
  }

  const mode = process.env.SCHEDULED_CLUSTERING_MODE === 'refresh-only' ? 'refresh-only' : 'refresh-and-cluster'
  const users = await db.select({ id: user.id }).from(user)
  const results = []
  for (const account of users) {
    results.push({ userId: account.id, ...(mode === 'refresh-only' ? await refreshAllFeeds(account.id) : await refreshAndClusterAll(account.id)) })
  }
  return NextResponse.json({ mode, ranAt: new Date().toISOString(), results })
}

export const dynamic = 'force-dynamic'
