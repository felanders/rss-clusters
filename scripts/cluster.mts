// CLI runner for the clustering pipeline — handy for checking the setup without the UI.
// Usage: pnpm cluster <user-email|user-id> [--recluster] [--refresh]
import { existsSync, readFileSync } from 'node:fs'

for (const file of ['.env.local', '.env.development.local']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const index = line.indexOf('=')
    if (index < 1 || line.startsWith('#')) continue
    const key = line.slice(0, index).trim()
    if (!process.env[key]) process.env[key] = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

const [target, ...flags] = process.argv.slice(2)
if (!target) { console.error('Usage: pnpm cluster <user-email|user-id> [--recluster] [--refresh]'); process.exit(1) }

const { eq, or } = await import('drizzle-orm')
const { db, pool } = await import('../lib/db')
const { user } = await import('../lib/db/schema')
const { clusterPendingArticles, embedPendingArticles, reclusterAll } = await import('../lib/clustering')
const { syncAllFeeds } = await import('../lib/feeds')

const [account] = await db.select({ id: user.id, email: user.email }).from(user).where(or(eq(user.email, target), eq(user.id, target)))
if (!account) { console.error(`No user matching "${target}"`); process.exit(1) }
const log = (message: string) => console.log(`  ${message}`)
console.log(`User ${account.email} (${account.id})`)

if (flags.includes('--refresh')) {
  const result = await syncAllFeeds(account.id, { cluster: false })
  result.log.forEach(log)
}
if (flags.includes('--recluster')) {
  const result = await reclusterAll(account.id, log)
  console.log(JSON.stringify({ ...result, errors: result.errors.slice(0, 5) }, null, 2))
} else {
  const embedding = await embedPendingArticles(account.id, log)
  console.log(`  embedded ${embedding.embedded}/${embedding.pending}`)
  const result = await clusterPendingArticles(account.id, log)
  console.log(JSON.stringify({ ...result, errors: result.errors.slice(0, 5) }, null, 2))
}
await pool.end()
