import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { article, feed, issue } from '@/lib/db/schema'
import { openRouterJson } from '@/lib/openrouter'

/**
 * Newsletter feeds (e.g. from kill-the-newsletter.com) deliver one entry per email. Each entry is stored as an `issue`, then an
 * LLM splits it into its individual stories, which become ordinary `article` rows and go through embedding + clustering like
 * everything else.
 */

/** Extraction is easy work; 2.5 Flash-Lite is ~5x cheaper on output tokens than 3.5 and handles it fine (≈ $0.001 per issue). */
const SPLIT_MODEL = process.env.OPENROUTER_NEWSLETTER_MODEL ?? 'google/gemini-2.5-flash-lite'
/** Characters of newsletter text sent to the model (≈ 15k tokens). */
const MAX_ISSUE_CHARS = 60_000
const MAX_ITEMS = 40

export function looksLikeNewsletterFeed(url: string) {
  return /kill-the-newsletter\.com|newsletter/i.test(url)
}

/** Email HTML → readable text that keeps link targets, so the model can attach the right URL to each story. */
export function emailToText(html: string) {
  let text = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const clean = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      // Tracking redirects are still useful to the reader; only drop obvious anchors/mailto and empty labels.
      return clean && /^https?:/i.test(href) ? ` ${clean} (${href}) ` : ` ${clean} `
    })
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length > MAX_ISSUE_CHARS) text = `${text.slice(0, MAX_ISSUE_CHARS)}\n[truncated]`
  return text
}

const splitSchema = z.object({
  items: z.array(z.object({
    headline: z.string().min(1),
    summary: z.string().min(1),
    url: z.string().nullable().optional(),
  })).max(MAX_ITEMS),
})
export type NewsletterItem = z.infer<typeof splitSchema>['items'][number]

export async function splitNewsletter(input: { newsletter: string; subject: string; content: string; publishedAt: Date | null }): Promise<NewsletterItem[]> {
  const body = emailToText(input.content)
  if (!body) return []
  const prompt = `Below is one issue of the email newsletter "${input.newsletter}" (subject: "${input.subject}"${input.publishedAt ? `, sent ${input.publishedAt.toISOString().slice(0, 10)}` : ''}).
Split it into the individual news stories it reports, so each can be filed as a separate article.

Rules:
- One item per distinct story or development. Merge paragraphs that belong to the same story; do not split one story into several items.
- Short "in brief" mentions count as stories too, even without a link — and a paragraph that mentions several unrelated things becomes several items.
- Skip everything that is not a news story: greetings, editor's notes, ads and sponsor blocks, subscription/unsubscribe text, job listings, event calendars, footers, social links.
- headline: neutral, direct and factual, at most 14 words, in the language the newsletter uses.
- summary: 2-3 sentences with the key facts as reported, in the newsletter's language. Do not add information that is not in the text.
- url: the link that points to the story itself (the "read more"/article link that appears with it), copied exactly from the text in parentheses. null if there is none.
- At most ${MAX_ITEMS} items, in the order they appear.

Respond with JSON only: {"items":[{"headline":"...","summary":"...","url":"https://..."|null}]}
If the email contains no news stories respond {"items":[]}.

Newsletter text:

${body}`
  const result = await openRouterJson(SPLIT_MODEL, [{ role: 'user', content: prompt }], splitSchema)
  return result.items
}

/** Split every issue of this user's newsletter feeds that has not been processed yet into articles. */
export async function processPendingIssues(userId: string, log: (message: string) => void = () => {}) {
  const pending = await db.select({ issue, feedName: feed.name }).from(issue).innerJoin(feed, eq(feed.id, issue.feedId)).where(and(eq(issue.userId, userId), isNull(issue.processedAt)))
  const errors: string[] = []
  let stories = 0
  if (pending.length) log(`Splitting ${pending.length} newsletter issue${pending.length === 1 ? '' : 's'} into stories with ${SPLIT_MODEL}…`)
  for (const { issue: current, feedName } of pending) {
    try {
      const items = await splitNewsletter({ newsletter: feedName, subject: current.title, content: current.content, publishedAt: current.publishedAt })
      const seen = new Set<string>()
      const rows = items.map((item, index) => {
        const external = item.url && /^https?:/i.test(item.url) ? item.url.trim() : null
        // Stories without their own link point at the issue, with a fragment so the (feedId, url) uniqueness still holds.
        let url = external ?? `${current.url}#story-${index + 1}`
        if (seen.has(url)) url = `${url}#${index + 1}`
        seen.add(url)
        return { id: crypto.randomUUID(), feedId: current.feedId, userId, issueId: current.id, title: item.headline.trim().slice(0, 500), url: url.slice(0, 2000), summary: item.summary.trim().slice(0, 5000), author: feedName.slice(0, 300), publishedAt: current.publishedAt ?? current.createdAt, guid: null }
      })
      const inserted = rows.length ? await db.insert(article).values(rows).onConflictDoNothing({ target: [article.feedId, article.url] }).returning({ id: article.id }) : []
      await db.update(issue).set({ processedAt: new Date(), itemCount: rows.length, lastError: null }).where(eq(issue.id, current.id))
      stories += inserted.length
      log(`${feedName} — "${current.title.slice(0, 60)}": ${rows.length} stor${rows.length === 1 ? 'y' : 'ies'}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Splitting failed'
      errors.push(`${feedName} — ${current.title.slice(0, 60)}: ${message}`)
      // Leave processedAt empty so the next run retries; remember the error for the settings panel.
      await db.update(issue).set({ lastError: message.slice(0, 500) }).where(eq(issue.id, current.id))
      log(`Splitting failed for "${current.title.slice(0, 60)}": ${message}`)
      if (/quota|credits|401|403/i.test(message)) break
    }
  }
  return { issues: pending.length, stories, errors }
}
