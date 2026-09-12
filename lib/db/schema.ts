import { integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('emailVerified'),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(), expiresAt: timestamp('expiresAt').notNull(), token: text('token').notNull().unique(), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(), ipAddress: text('ipAddress'), userAgent: text('userAgent'), userId: text('userId').notNull(),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(), accountId: text('accountId').notNull(), providerId: text('providerId').notNull(), userId: text('userId').notNull(), accessToken: text('accessToken'), refreshToken: text('refreshToken'), idToken: text('idToken'), accessTokenExpiresAt: timestamp('accessTokenExpiresAt'), refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'), scope: text('scope'), password: text('password'), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(), expiresAt: timestamp('expiresAt').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const feed = pgTable('feed', {
  id: text('id').primaryKey(), userId: text('userId').notNull(), name: text('name').notNull(), url: text('url').notNull(), category: text('category').notNull().default('Uncategorized'),
  // 'rss': every entry is an article. 'newsletter': every entry is an email issue (e.g. a Kill the Newsletter feed) that an LLM splits into stories.
  kind: text('kind').$type<FeedKind>().notNull().default('rss'),
  status: text('status').notNull().default('Pending sync'), lastSyncedAt: timestamp('lastSyncedAt'), lastError: text('lastError'), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
}, (table) => ({ userUrl: unique().on(table.userId, table.url) }))

export type FeedKind = 'rss' | 'newsletter'

/** One received newsletter email. Its stories live in `article` (linked via issueId) once it has been split. */
export const issue = pgTable('issue', {
  id: text('id').primaryKey(), feedId: text('feedId').notNull(), userId: text('userId').notNull(), title: text('title').notNull(), url: text('url').notNull(), content: text('content').notNull(), publishedAt: timestamp('publishedAt'),
  processedAt: timestamp('processedAt'), itemCount: integer('itemCount'), lastError: text('lastError'), createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (table) => ({ feedUrl: unique().on(table.feedId, table.url) }))

export const article = pgTable('article', {
  id: text('id').primaryKey(), feedId: text('feedId').notNull(), userId: text('userId').notNull(), title: text('title').notNull(), url: text('url').notNull(), summary: text('summary'), author: text('author'), publishedAt: timestamp('publishedAt'), guid: text('guid'),
  // Embedding of "title + summary", produced right after retrieval. `embeddingModel` records which provider/model made it so a model switch can be detected.
  embedding: jsonb('embedding').$type<number[]>(), embeddingModel: text('embeddingModel'),
  // `clusterId` is null for singletons. `clusteredAt` is null until the article has been through the neighbour search + LLM pass at least once.
  clusterId: text('clusterId'), clusteredAt: timestamp('clusteredAt'), readAt: timestamp('readAt'),
  // Set for stories extracted from a newsletter issue.
  issueId: text('issueId'), createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (table) => ({ feedUrl: unique().on(table.feedId, table.url) }))

export const cluster = pgTable('cluster', {
  id: text('id').primaryKey(), userId: text('userId').notNull(), centroid: jsonb('centroid').$type<number[]>().notNull(), canonicalTitle: text('canonicalTitle').notNull(), summary: jsonb('summary').$type<string[]>().notNull().default([]), articleCount: integer('articleCount').notNull().default(1), lastUpdatedAt: timestamp('lastUpdatedAt').notNull().defaultNow(), createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export type Feed = typeof feed.$inferSelect
export type Article = typeof article.$inferSelect
export type Cluster = typeof cluster.$inferSelect
export type Issue = typeof issue.$inferSelect
/** What the client receives: the vectors stay on the server. */
export type ArticleView = Omit<Article, 'embedding'>
export type ClusterView = Omit<Cluster, 'centroid'>

export const schema = { user, session, account, verification, feed, article, cluster, issue }
