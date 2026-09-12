// Idempotent schema setup for the app tables (Better Auth creates its own tables).
// Usage: pnpm db:migrate   (reads DATABASE_URL from the environment or .env*.local)
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

for (const file of ['.env.local', '.env.development.local']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const index = line.indexOf('=')
    if (index < 1 || line.startsWith('#')) continue
    const key = line.slice(0, index).trim()
    if (!process.env[key]) process.env[key] = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

const statements = [
  `create table if not exists "feed" ("id" text primary key, "userId" text not null, "name" text not null, "url" text not null, "category" text not null default 'Uncategorized', "status" text not null default 'Pending sync', "lastSyncedAt" timestamp, "lastError" text, "createdAt" timestamp not null default now(), "updatedAt" timestamp not null default now(), unique ("userId", "url"))`,
  `create table if not exists "article" ("id" text primary key, "feedId" text not null, "userId" text not null, "title" text not null, "url" text not null, "summary" text, "author" text, "publishedAt" timestamp, "guid" text, "embedding" jsonb, "embeddingModel" text, "clusterId" text, "clusteredAt" timestamp, "readAt" timestamp, "createdAt" timestamp not null default now(), unique ("feedId", "url"))`,
  `create table if not exists "cluster" ("id" text primary key, "userId" text not null, "centroid" jsonb not null, "canonicalTitle" text not null, "summary" jsonb not null default '[]', "articleCount" integer not null default 1, "lastUpdatedAt" timestamp not null default now(), "createdAt" timestamp not null default now())`,
  `alter table "article" add column if not exists "embeddingModel" text`,
  `alter table "article" add column if not exists "clusteredAt" timestamp`,
  `create index if not exists "article_user_cluster_idx" on "article" ("userId", "clusterId")`,
  `create index if not exists "article_user_pending_idx" on "article" ("userId") where "clusteredAt" is null`,
  `create index if not exists "cluster_user_idx" on "cluster" ("userId")`,
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  for (const statement of statements) await pool.query(statement)
  console.log(`Schema is up to date (${statements.length} statements applied).`)
} finally {
  await pool.end()
}
