'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'isomorphic-dompurify'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Circle, ExternalLink, Layers, LogOut, Pencil, Plus, RefreshCw, Settings2, Trash2, X } from 'lucide-react'
import { addFeed, deleteFeed, listArticles, listClusters, listFeeds, listReadArticleIds, markArticleRead, reclusterArticles, refreshAllFeeds, updateFeed } from '@/app/actions/feeds'
import { signOut, useSession } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ArticleView, ClusterView, Feed } from '@/lib/db/schema'

type Group = { key: string; cluster: ClusterView | null; articles: ArticleView[]; latest: number }

export default function Page() {
  const router = useRouter()
  const { data: session, isPending } = useSession()
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [articles, setArticles] = useState<ArticleView[]>([])
  const [clusters, setClusters] = useState<ClusterView[]>([])
  const [viewed, setViewed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'refresh' | 'recluster' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // When the unread filter is on, only articles read *before* it was switched on are hidden — otherwise rows would vanish
  // under the reader's finger as scrolling marks them read.
  const [hiddenRead, setHiddenRead] = useState<Set<string> | null>(null)
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [log, setLog] = useState<string[]>([])

  const reload = useCallback(async () => {
    const [nextFeeds, nextArticles, nextClusters, readIds] = await Promise.all([listFeeds(), listArticles(), listClusters(), listReadArticleIds()])
    setFeeds(nextFeeds); setArticles(nextArticles); setClusters(nextClusters); setViewed(new Set(readIds))
    setHiddenRead((current) => current ? new Set(readIds) : null)
  }, [])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    reload().catch((error) => console.error('[reader] load failed', error)).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [session, reload])

  const viewedRef = useRef(viewed)
  viewedRef.current = viewed
  const markViewed = useCallback((ids: string[]) => {
    const fresh = ids.filter((id) => !viewedRef.current.has(id))
    if (fresh.length === 0) return
    setViewed((current) => new Set([...current, ...fresh]))
    Promise.all(fresh.map((id) => markArticleRead(id))).catch((error) => console.error('[reader] failed to persist read state', error))
  }, [])

  async function refresh() {
    setBusy('refresh'); setLog(['Fetching feeds…'])
    try {
      const result = await refreshAllFeeds()
      setLog([...result.log, ...result.errors.map((message) => `Error — ${message}`)])
      await reload()
    } catch (error) {
      setLog((current) => [...current, error instanceof Error ? error.message : 'Refresh failed.'])
    } finally { setBusy(null) }
  }

  async function recluster() {
    if (!window.confirm('Rebuild all clusters from scratch? This re-runs the neighbour search and LLM verification over every article.')) return
    setSettingsOpen(false)
    setBusy('recluster'); setLog(['Starting full recluster…'])
    try {
      const result = await reclusterArticles()
      setLog([...result.log, ...result.errors.map((message) => `Error — ${message}`)])
      await reload()
    } catch (error) {
      setLog((current) => [...current, error instanceof Error ? error.message : 'Clustering failed.'])
    } finally { setBusy(null) }
  }

  const toggleUnreadOnly = () => setHiddenRead((current) => current ? null : new Set(viewedRef.current))
  const unreadOnly = hiddenRead !== null

  const categories = useMemo(() => ['All', ...Array.from(new Set(feeds.map((feed) => feed.category).filter(Boolean))).sort()], [feeds])
  const feedById = useMemo(() => new Map(feeds.map((feed) => [feed.id, feed])), [feeds])

  const groups = useMemo<Group[]>(() => {
    const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]))
    const visible = articles.filter((item) => (selectedCategory === 'All' || feedById.get(item.feedId)?.category === selectedCategory) && !hiddenRead?.has(item.id))
    const byCluster = new Map<string, ArticleView[]>()
    const singles: ArticleView[] = []
    for (const item of visible) {
      if (item.clusterId && clusterById.has(item.clusterId)) byCluster.set(item.clusterId, [...(byCluster.get(item.clusterId) ?? []), item])
      else singles.push(item)
    }
    const time = (item: ArticleView) => new Date(item.publishedAt ?? item.createdAt).getTime()
    const result: Group[] = []
    for (const [clusterId, members] of byCluster) {
      // A cluster whose other members are filtered out reads better as a plain article.
      if (members.length < 2) { singles.push(...members); continue }
      members.sort((left, right) => time(right) - time(left))
      result.push({ key: clusterId, cluster: clusterById.get(clusterId)!, articles: members, latest: time(members[0]) })
    }
    for (const item of singles) result.push({ key: item.id, cluster: null, articles: [item], latest: time(item) })
    return result.sort((left, right) => right.latest - left.latest)
  }, [articles, clusters, feedById, selectedCategory, hiddenRead])

  if (isPending) return <main className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-500">Loading…</main>
  if (!session) {
    return <main className="flex min-h-screen items-center justify-center bg-white px-6"><div className="w-full max-w-sm text-center"><div className="mb-8 text-2xl font-semibold tracking-tight">Clustered RSS Feeds</div><h1 className="text-4xl font-semibold tracking-[-0.05em] text-neutral-950">A clearer way to read.</h1><p className="mt-4 text-sm leading-6 text-neutral-500">Your feeds, grouped into the stories they are actually about.</p><Button className="mt-8 rounded-full bg-black px-6 text-white hover:bg-neutral-800" onClick={() => router.push('/sign-in')}>Sign in</Button></div></main>
  }

  const clusterCount = groups.filter((group) => group.cluster).length
  const storyCount = groups.length
  const pills = categories.length > 1 && (
    <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]" aria-label="Filter by feed category">
      {categories.map((category) => (
        <button key={category} type="button" aria-pressed={selectedCategory === category} onClick={() => setSelectedCategory(category)} className={`shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${selectedCategory === category ? 'border-black bg-black text-white' : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-400 hover:text-neutral-950'}`}>{category}</button>
      ))}
    </div>
  )

  return (
    <div className="min-h-screen overflow-x-clip bg-white text-neutral-950">
      <header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-5 lg:px-8">
          <div className="flex h-14 items-center justify-between gap-3 sm:h-16">
            <button className="shrink-0 text-base font-semibold tracking-[-0.03em] sm:text-lg" onClick={() => setSettingsOpen(false)}>Clustered RSS Feeds</button>
            <div className="hidden min-w-0 flex-1 sm:block">{pills}</div>
            <span className="hidden shrink-0 text-xs text-neutral-400 md:inline">{busy === 'refresh' ? 'Syncing and clustering…' : busy === 'recluster' ? 'Reclustering…' : storyCount > 0 ? `${storyCount} stories · ${clusterCount} clusters` : 'No stories'}</span>
            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <Button variant="ghost" size="sm" aria-pressed={unreadOnly} onClick={toggleUnreadOnly}>{unreadOnly ? 'All' : 'Unread'}</Button>
              <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={recluster} disabled={busy !== null} title="Rebuild all clusters from scratch"><Layers />Recluster</Button>
              <Button variant="ghost" size="icon" aria-label="Fetch feeds and cluster new articles" title="Fetch feeds and cluster new articles" onClick={refresh} disabled={busy !== null}><RefreshCw className={busy === 'refresh' ? 'animate-spin' : ''} /></Button>
              <Button variant="ghost" size="icon" aria-label="Open feed settings" onClick={() => setSettingsOpen((open) => !open)}><Settings2 /></Button>
              <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label="Sign out" onClick={() => signOut().then(() => router.push('/sign-in'))}><LogOut /></Button>
            </div>
          </div>
          {pills && <div className="pb-2.5 sm:hidden">{pills}</div>}
        </div>
      </header>

      {(busy || log.length > 0) && (
        <aside className="fixed inset-x-4 top-[4.25rem] z-20 rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl sm:inset-x-auto sm:right-4 sm:top-20 sm:w-[400px]" aria-live="polite">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">Clustering log</p>
            {busy ? <span className="size-2 animate-pulse rounded-full bg-black" /> : <button type="button" aria-label="Close log" className="text-neutral-400 hover:text-neutral-950" onClick={() => setLog([])}><X className="size-4" /></button>}
          </div>
          <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto font-mono text-[11px] leading-5 text-neutral-600">
            {log.map((line, index) => <p key={`${index}-${line}`} className={line.startsWith('Error') || line.includes('failed') ? 'text-red-600' : ''}>{line}</p>)}
          </div>
        </aside>
      )}

      <main className="mx-auto max-w-[1200px] px-4 py-4 sm:px-5 sm:py-8 lg:px-8 lg:py-10">
        {loading ? <div className="border-y border-neutral-200 py-8 text-sm text-neutral-500">Loading your inbox…</div>
          : articles.length === 0 ? <div className="border-y border-neutral-200 py-16 text-center text-sm text-neutral-500">Your inbox is empty. Add a feed from settings, then refresh.</div>
          : groups.length === 0 ? <div className="border-y border-neutral-200 py-16 text-center text-sm text-neutral-500">Nothing matches the current filters.</div>
          : <ReaderTable groups={groups} feedById={feedById} viewed={viewed} onViewed={markViewed} />}
      </main>

      {settingsOpen && (
        <FeedSettings
          feeds={feeds}
          busy={busy !== null}
          onAdded={(feed) => { setFeeds((current) => [feed, ...current]); reload().catch(() => {}) }}
          onClose={() => setSettingsOpen(false)}
          onRecluster={recluster}
          onSignOut={() => signOut().then(() => router.push('/sign-in'))}
        />
      )}
    </div>
  )
}

const formatDate = (value: Date | string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'
const formatShortDate = (value: Date | string | null) => value ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'

/** Fallback sticky-header height; the real one is measured so rows hidden beneath it count as scrolled past. */
const HEADER_OFFSET = 56

function ReaderTable({ groups, feedById, viewed, onViewed }: { groups: Group[]; feedById: Map<string, Feed>; viewed: Set<string>; onViewed: (ids: string[]) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const idsByRow = useRef(new WeakMap<Element, string[]>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const onViewedRef = useRef(onViewed)
  onViewedRef.current = onViewed
  const gridTemplate = '28px minmax(0, 1fr) 170px 140px 36px'
  const feedName = (id: string) => feedById.get(id)?.name ?? 'Unknown source'

  // A headline that has scrolled up past the header counts as read.
  useEffect(() => {
    const headerHeight = document.querySelector('header')?.offsetHeight ?? HEADER_OFFSET
    const observer = new IntersectionObserver((entries) => {
      const passed = entries.filter((entry) => !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? headerHeight)).flatMap((entry) => idsByRow.current.get(entry.target) ?? [])
      if (passed.length) onViewedRef.current(passed)
    }, { rootMargin: `-${headerHeight}px 0px 0px 0px`, threshold: 0 })
    observerRef.current = observer
    rowRefs.current.forEach((element) => { if (element) observer.observe(element) })
    return () => { observer.disconnect(); observerRef.current = null }
  }, [])

  const attachRow = (index: number, group: Group) => (element: HTMLButtonElement | null) => {
    const previous = rowRefs.current[index]
    if (previous && previous !== element) observerRef.current?.unobserve(previous)
    rowRefs.current[index] = element
    if (element) {
      idsByRow.current.set(element, group.articles.map((item) => item.id))
      observerRef.current?.observe(element)
    }
  }

  const toggle = (key: string) => setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })

  const moveFocus = (index: number, delta: number) => {
    const next = Math.max(0, Math.min(groups.length - 1, index + delta))
    rowRefs.current[next]?.focus()
    rowRefs.current[next]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <div className="border-y border-neutral-200">
      <div className="hidden items-center gap-2 border-b border-neutral-200 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-400 sm:grid" style={{ gridTemplateColumns: gridTemplate }}>
        <span /><span>Story</span><span>Sources</span><span>Latest</span><span>Read</span>
      </div>
      {groups.map((group, index) => {
        const isOpen = expanded.has(group.key)
        const ids = group.articles.map((item) => item.id)
        const unread = ids.some((id) => !viewed.has(id))
        const sources = [...new Set(group.articles.map((item) => feedName(item.feedId)))]
        const heading = group.cluster ? group.cluster.canonicalTitle : decodeEntities(group.articles[0].title)
        return (
          <div key={group.key} className={`border-b border-neutral-100 last:border-0 ${group.cluster ? 'sm:bg-neutral-50/50' : ''}`}>
            <button
              ref={attachRow(index, group)}
              type="button"
              aria-expanded={isOpen}
              className="flex w-full items-start gap-2 px-1 py-3 text-left transition-colors hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black sm:grid sm:items-center sm:px-3 sm:py-2.5"
              style={{ gridTemplateColumns: gridTemplate }}
              onClick={() => { toggle(group.key); if (!isOpen) onViewed(ids) }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveFocus(index, event.key === 'ArrowDown' ? 1 : -1) }
              }}
            >
              <span className="hidden text-neutral-400 sm:block">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
              <span className="flex min-w-0 flex-1 items-start gap-2 sm:flex-none sm:items-center">
                <span className={`min-w-0 text-[15px] leading-snug sm:truncate sm:text-sm ${unread ? 'font-semibold text-neutral-950' : 'font-normal text-neutral-500'}`}>{heading}</span>
                {group.cluster && <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold sm:mt-0 ${unread ? 'bg-black text-white' : 'bg-neutral-200 text-neutral-600'}`}>{group.articles.length}</span>}
              </span>
              <span className="hidden truncate text-xs text-neutral-500 sm:block">{sources.length > 2 ? `${sources.slice(0, 2).join(', ')} +${sources.length - 2}` : sources.join(', ')}</span>
              <span className="hidden truncate text-xs text-neutral-500 sm:block" suppressHydrationWarning>{formatDate(group.articles[0].publishedAt ?? group.articles[0].createdAt)}</span>
              <span className="hidden justify-center sm:flex" role="button" tabIndex={-1} aria-label={unread ? 'Mark as read' : 'Read'} onClick={(event) => { event.stopPropagation(); onViewed(ids) }}>
                <Circle className={`size-2.5 ${unread ? 'fill-black text-black' : 'text-neutral-300'}`} />
              </span>
            </button>
            {isOpen && (
              <div className="ml-1 border-l border-neutral-200 pb-3 pl-3 sm:ml-[40px] sm:pl-5">
                {group.cluster ? <ClusterBody group={group} feedName={feedName} viewed={viewed} onViewed={onViewed} /> : <ArticleBody article={group.articles[0]} feedName={feedName} onViewed={onViewed} />}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Expanded cluster: the neutral summary, then one expandable row per source article. */
function ClusterBody({ group, feedName, viewed, onViewed }: { group: Group; feedName: (id: string) => string; viewed: Set<string>; onViewed: (ids: string[]) => void }) {
  const [openArticles, setOpenArticles] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setOpenArticles((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const summary = group.cluster?.summary ?? []
  return (
    <div>
      {summary.length > 0 && (
        <ul className="mb-2 mt-2 space-y-1 text-sm leading-6 text-neutral-700">
          {summary.map((line, index) => <li key={index} className="flex gap-2"><span className="mt-2.5 size-1 shrink-0 rounded-full bg-neutral-400" />{line}</li>)}
        </ul>
      )}
      <p className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-400">{group.articles.length} articles</p>
      <div className="divide-y divide-neutral-100 border-t border-neutral-100">
        {group.articles.map((item) => {
          const isOpen = openArticles.has(item.id)
          const unread = !viewed.has(item.id)
          return (
            <div key={item.id}>
              <button type="button" aria-expanded={isOpen} onClick={() => { toggle(item.id); if (!isOpen) onViewed([item.id]) }} className="flex w-full items-start gap-2 py-2 text-left hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black sm:grid sm:items-center" style={{ gridTemplateColumns: '20px minmax(0, 1fr) 160px 150px' }}>
                <span className="mt-0.5 text-neutral-400 sm:mt-0">{isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
                <span className="min-w-0 flex-1 sm:flex-none">
                  <span className={`block text-sm leading-snug sm:truncate ${unread ? 'font-medium text-neutral-900' : 'text-neutral-500'}`}>{decodeEntities(item.title)}</span>
                  <span className="mt-0.5 block text-[11px] text-neutral-400 sm:hidden" suppressHydrationWarning>{feedName(item.feedId)} · {formatShortDate(item.publishedAt ?? item.createdAt)}</span>
                </span>
                <span className="hidden truncate text-xs text-neutral-500 sm:block">{feedName(item.feedId)}</span>
                <span className="hidden truncate text-xs text-neutral-500 sm:block" suppressHydrationWarning>{formatDate(item.publishedAt ?? item.createdAt)}</span>
              </button>
              {isOpen && <div className="ml-2 border-l border-neutral-200 pb-2 pl-3 sm:ml-5 sm:pl-4"><ArticleBody article={item} feedName={feedName} onViewed={onViewed} /></div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Expanded article: its own summary plus a link to the source. */
function ArticleBody({ article, feedName, onViewed }: { article: ArticleView; feedName: (id: string) => string; onViewed: (ids: string[]) => void }) {
  const summary = sanitizeSummary(article.summary ?? '')
  return (
    <div className="py-2">
      {summary ? <div className="break-words text-sm leading-6 text-neutral-600 [&_a]:underline [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: summary }} /> : <p className="text-sm italic text-neutral-400">No summary in the feed.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span>{feedName(article.feedId)}</span>
        {article.author && <span>· {decodeEntities(article.author)}</span>}
        <a href={article.url} target="_blank" rel="noreferrer" onClick={() => onViewed([article.id])} className="inline-flex items-center gap-1 font-medium text-neutral-950 hover:underline">Open article<ExternalLink className="size-3" /></a>
      </div>
    </div>
  )
}

function FeedSettings({ feeds, busy, onAdded, onClose, onRecluster, onSignOut }: { feeds: Feed[]; busy: boolean; onAdded: (feed: Feed) => void; onClose: () => void; onRecluster: () => void; onSignOut: () => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftCategory, setDraftCategory] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try { const nextFeed = await addFeed(url); onAdded(nextFeed); setUrl('') }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to add feed.') }
    finally { setSaving(false) }
  }

  function startEditing(item: Feed) { setEditing(item.id); setDraftName(item.name); setDraftCategory(item.category); setError('') }
  async function saveEdit(item: Feed) {
    setSaving(true); setError('')
    try { await updateFeed(item.id, { name: draftName, category: draftCategory }); item.name = draftName.trim() || item.name; item.category = draftCategory.trim() || item.category; setEditing(null) }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to update feed.') }
    finally { setSaving(false) }
  }
  async function remove(item: Feed) {
    if (!window.confirm(`Delete ${item.name}? Articles from this feed will also be removed.`)) return
    setSaving(true); setError('')
    try { await deleteFeed(item.id); window.location.reload() }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to delete feed.'); setSaving(false) }
  }

  return (
    <>
      <div className="fixed inset-0 z-20 bg-black/20 sm:bg-transparent" onClick={onClose} aria-hidden />
      <div className="fixed inset-y-0 right-0 z-30 flex w-full flex-col bg-white shadow-2xl sm:max-w-md sm:border-l sm:border-neutral-200" role="dialog" aria-label="Feed settings">
        <div className="flex items-center justify-between px-5 pt-5 sm:px-8 sm:pt-8">
          <div><p className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">Settings</p><h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Feeds</h2></div>
          <Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}><X /></Button>
        </div>
        <form onSubmit={submit} className="flex gap-2 px-5 pt-6 sm:px-8 sm:pt-8">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" aria-label="RSS feed URL" inputMode="url" autoCapitalize="none" />
          <Button type="submit" disabled={saving} className="shrink-0 bg-black text-white hover:bg-neutral-800"><Plus />{saving ? 'Adding…' : 'Add'}</Button>
        </form>
        {error && <p role="alert" className="px-5 pt-3 text-xs text-red-600 sm:px-8">{error}</p>}
        <div className="mx-5 mt-6 min-h-0 flex-1 divide-y divide-neutral-100 overflow-y-auto overscroll-contain border-y border-neutral-200 sm:mx-8">
          {feeds.length === 0 && <p className="py-8 text-center text-sm text-neutral-400">No feeds yet — paste an RSS or Atom URL above.</p>}
          {feeds.map((item) => (
            <div key={item.id} className="py-3.5">
              {editing === item.id ? (
                <div className="flex flex-col gap-2">
                  <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} aria-label="Feed name" />
                  <Input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} aria-label="Feed category" placeholder="Category" />
                  <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button><Button type="button" size="sm" disabled={saving} onClick={() => saveEdit(item)} className="bg-black text-white hover:bg-neutral-800">Save</Button></div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{item.name}</div>
                    <div className="mt-0.5 truncate text-xs text-neutral-400">{item.category} · <span className={item.status === 'Error' ? 'text-red-600' : ''}>{item.status}</span>{item.lastError ? ` · ${item.lastError}` : ''}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5"><Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => startEditing(item)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} onClick={() => remove(item)} disabled={saving}><Trash2 /></Button></div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-4 sm:px-8 sm:py-6">
          <Button variant="outline" size="sm" onClick={onRecluster} disabled={busy}><Layers />Rebuild clusters</Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}><LogOut />Sign out</Button>
        </div>
      </div>
    </>
  )
}

function decodeEntities(value: string) {
  if (typeof document === 'undefined') return value
  const textarea = document.createElement('textarea')
  let decoded = value.replace(/(^|[^&])#(\d{2,5});/g, '$1&#$2;')
  for (let index = 0; index < 3; index += 1) {
    textarea.innerHTML = decoded
    const next = textarea.value
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

function sanitizeSummary(value: string) {
  return DOMPurify.sanitize(decodeEntities(value), { ALLOWED_TAGS: ['a', 'b', 'br', 'em', 'i', 'strong', 'u', 'p', 'ul', 'ol', 'li'], ALLOWED_ATTR: ['href', 'target', 'rel'] }).trim()
}
