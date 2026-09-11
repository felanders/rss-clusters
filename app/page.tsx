'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'isomorphic-dompurify'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Circle, ExternalLink, LogOut, Pencil, Plus, RefreshCw, Settings2, Trash2, X } from 'lucide-react'
import { addFeed, deleteFeed, listArticles, listClusters, listFeeds, listReadArticleIds, markArticleRead, reclusterArticles, refreshAndClusterAll, refreshAllFeeds, updateFeed } from '@/app/actions/feeds'
import { signOut, useSession } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Article, Cluster, Feed } from '@/lib/db/schema'

export default function Page() {
  const router = useRouter()
  const { data: session, isPending } = useSession()
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [viewed, setViewed] = useState<string[]>([])
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [reclustering, setReclustering] = useState(false)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const load = async () => {
      const [nextFeeds, nextArticles, nextClusters, readIds] = await Promise.all([listFeeds(), listArticles(), listClusters(), listReadArticleIds()])
      if (!cancelled) { setFeeds(nextFeeds); setArticles(nextArticles); setClusters(nextClusters); setViewed(readIds) }
    }
    load().catch(() => {}).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [session])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const sync = async () => {
      setRefreshing(true)
      try {
        await refreshAndClusterAll()
        const [nextFeeds, nextArticles, nextClusters, readIds] = await Promise.all([listFeeds(), listArticles(), listClusters(), listReadArticleIds()])
        if (!cancelled) { setFeeds(nextFeeds); setArticles(nextArticles); setClusters(nextClusters); setViewed(readIds) }
      } catch (error) {
        console.error('[v0] Automatic refresh and clustering failed:', error)
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    }
    sync()
    return () => { cancelled = true }
  }, [session])

  function markViewed(id: string) {
    setViewed((current) => current.includes(id) ? current : [...current, id])
    void markArticleRead(id).catch((error) => console.error('[v0] Failed to persist read state:', error))
  }

  async function refresh() {
    setRefreshing(true)
    await refreshAllFeeds().catch(() => null)
    const [nextFeeds, nextArticles, nextClusters] = await Promise.all([listFeeds(), listArticles(), listClusters()]).catch(() => [feeds, articles, clusters] as const)
    setFeeds(nextFeeds)
    setArticles(nextArticles)
    setClusters(nextClusters)
    setRefreshing(false)
  }

  if (isPending) return <main className="flex min-h-screen items-center justify-center text-sm text-neutral-500">Loading…</main>
  if (!session) return <main className="flex min-h-screen items-center justify-center bg-white px-6"><div className="w-full max-w-sm text-center"><div className="mb-8 text-2xl font-semibold tracking-tight">Clustered RSS Feeds</div><h1 className="text-4xl font-semibold tracking-[-0.05em] text-neutral-950">A clearer way to read.</h1><p className="mt-4 text-sm leading-6 text-neutral-500">Your personal, focused inbox for the stories that matter.</p><Button className="mt-8 rounded-full bg-black px-6 text-white hover:bg-neutral-800" onClick={() => router.push('/sign-in')}>Sign in</Button></div></main>

  return <div className="min-h-screen bg-white text-neutral-950"><header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-white/95 backdrop-blur"><div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-5 lg:px-8"><button className="text-lg font-semibold tracking-[-0.03em]" onClick={() => setSettingsOpen(false)}>Clustered RSS Feeds</button><span className="hidden text-xs text-neutral-400 sm:inline">{refreshing ? 'Syncing and clustering…' : articles.length > 0 ? `${articles.length} stories` : 'Ready'}</span><div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((current) => !current)}>{unreadOnly ? 'All' : 'Unread'}</Button><Button variant="ghost" size="sm" onClick={async () => { setReclustering(true); await reclusterArticles(); const [nextArticles, nextClusters] = await Promise.all([listArticles(), listClusters()]); setArticles(nextArticles); setClusters(nextClusters); setReclustering(false) }} disabled={reclustering}>{reclustering ? 'Clustering…' : 'Cluster'}</Button><Button variant="ghost" size="icon" aria-label="Refresh stories" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? 'animate-spin' : ''} /></Button><Button variant="ghost" size="icon" aria-label="Open feed settings" onClick={() => setSettingsOpen((open) => !open)}><Settings2 /></Button><Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => signOut().then(() => router.push('/sign-in'))}><LogOut /></Button></div></div></header><main className="mx-auto max-w-[1200px] px-5 py-10 lg:px-8 lg:py-14"><ReaderTable articles={articles} feeds={feeds} clusters={clusters} viewed={viewed} onViewed={markViewed} loading={loading} unreadOnly={unreadOnly} /> </main>{settingsOpen && <FeedSettings feeds={feeds} onAdded={(feed) => setFeeds((current) => [feed, ...current])} onClose={() => setSettingsOpen(false)} />}</div>
}

function ReaderTable({ articles, feeds, clusters, viewed, onViewed, loading, unreadOnly }: { articles: Article[]; feeds: Feed[]; clusters: Cluster[]; viewed: string[]; onViewed: (id: string) => void; loading: boolean; unreadOnly: boolean }) {
  const [expanded, setExpanded] = useState<string[]>([])
  const rowRefs = useRef<HTMLButtonElement[]>([])
  const [columnWidths, setColumnWidths] = useState({ date: 170, source: 190 })
  const resizeColumn = (column: 'date' | 'source', event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = columnWidths[column]
    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(110, startWidth + moveEvent.clientX - startX)
      setColumnWidths((current) => ({ ...current, [column]: nextWidth }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const gridTemplate = `32px ${columnWidths.source}px minmax(0, 1fr) ${columnWidths.date}px 36px`
  const groups = useMemo(() => {
    const grouped = new Map<string, Article[]>()
    for (const item of articles.filter((article) => !unreadOnly || !viewed.includes(article.id))) {
      const key = item.clusterId ?? item.id
      grouped.set(key, [...(grouped.get(key) ?? []), item])
    }
    return [...grouped.entries()]
  }, [articles, unreadOnly, viewed])
  const feedName = (id: string) => feeds.find((feed) => feed.id === id)?.name ?? 'Unknown source'
  const formatDate = (value: Date | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'

  if (loading) return <div className="border-y border-neutral-200 py-8 text-sm text-neutral-500">Loading your inbox…</div>
  if (!articles.length) return <div className="border-y border-neutral-200 py-16 text-center text-sm text-neutral-500">Your inbox is empty. Add a feed from settings, then refresh.</div>

  return <div className="border-y border-neutral-200"><div className="grid items-center gap-2 border-b border-neutral-200 px-2 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-400 sm:px-3" style={{ gridTemplateColumns: gridTemplate }}><span /><span className="relative">Source<span role="separator" aria-label="Resize source column" onPointerDown={(event) => resizeColumn('source', event)} className="absolute -right-2 inset-y-0 w-3 cursor-col-resize" /></span><span>Headline</span><span className="relative">Date<span role="separator" aria-label="Resize date column" onPointerDown={(event) => resizeColumn('date', event)} className="absolute -right-2 inset-y-0 w-3 cursor-col-resize" /></span><span>Read</span></div>{groups.map(([key, group]) => { const isOpen = expanded.includes(key); const unread = group.some((item) => !viewed.includes(item.id)); const sources = [...new Set(group.map((item) => feedName(item.feedId)))]; const clusterRecord = group[0].clusterId ? clusters.find((item) => item.id === group[0].clusterId) : undefined; const heading = group.length > 1 ? (clusterRecord?.canonicalTitle ?? `${group.length} stories`) : decodeEntities(group[0].title); return <div key={key} className={`border-b border-neutral-100 last:border-0 ${group.length > 1 ? 'bg-neutral-50/40' : ''}`}><button ref={(element) => { if (element) rowRefs.current[groups.findIndex(([groupKey]) => groupKey === key)] = element }} onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest' })} className="grid w-full items-center gap-2 px-2 py-2.5 text-left transition-colors hover:bg-neutral-50 focus:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black sm:px-3" style={{ gridTemplateColumns: gridTemplate }} onKeyDown={(event) => { const index = groups.findIndex(([groupKey]) => groupKey === key); if (event.key === ' ') { event.preventDefault(); setExpanded((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]) } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const nextIndex = Math.max(0, Math.min(groups.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); rowRefs.current[nextIndex]?.focus(); onViewed(groups[nextIndex][1][0].id) } else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); group.forEach((item) => onViewed(item.id)) } }} onClick={(event) => { event.currentTarget.focus(); group.forEach((item) => onViewed(item.id)); setExpanded((current) => isOpen ? current.filter((id) => id !== key) : [...current, key])}} aria-expanded={isOpen}><span className="text-neutral-400">{isOpen ? <ChevronDown /> : <ChevronRight />}</span><span className="truncate text-xs text-neutral-500">{sources.length > 1 ? `${sources[0]} +${sources.length - 1}` : sources[0]}</span><span className={`truncate text-sm ${unread ? 'font-semibold text-neutral-950' : 'text-neutral-500'}`}>{heading}</span><span className="truncate text-xs text-neutral-500">{formatDate(group[0].publishedAt)}</span><span className="flex justify-center" role="button" tabIndex={0} aria-label={unread ? 'Mark stories as read' : 'Stories are read'} onClick={(event) => { event.stopPropagation(); group.forEach((item) => onViewed(item.id)) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); group.forEach((item) => onViewed(item.id)) } }}>{unread ? <Circle className="size-2.5 fill-black text-black" /> : <Circle className="size-2.5 text-neutral-300" />}</span></button>{isOpen && <div className="ml-[34px] border-l border-neutral-200 pb-3 pl-4 sm:ml-[232px] sm:pl-5">{group.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" onClick={() => onViewed(item.id)} className="group/item block border-b border-neutral-100 py-3 last:border-0"><div className="flex items-start justify-between gap-4"><div className="min-w-0 flex-1">{group.length > 1 && <p className="text-sm font-medium text-neutral-900">{decodeEntities(item.title)}</p>}<div className="mt-1 text-sm leading-6 text-neutral-600" dangerouslySetInnerHTML={{ __html: sanitizeSummary(item.summary ?? '') }} /></div><ExternalLink className="mt-1 shrink-0 text-neutral-400 opacity-0 transition-opacity group-hover/item:opacity-100" /></div></a>)}</div>}</div>})}</div>
}

function FeedSettings({ feeds, onAdded, onClose }: { feeds: Feed[]; onAdded: (feed: Feed) => void; onClose: () => void }) {
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

  return <div className="fixed inset-y-0 right-0 z-20 w-full max-w-md border-l border-neutral-200 bg-white p-6 shadow-2xl sm:p-8"><div className="flex items-center justify-between"><div><p className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">Settings</p><h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Feeds</h2></div><Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}><X /></Button></div><form onSubmit={submit} className="mt-8 flex gap-2"><Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" aria-label="RSS feed URL" /><Button type="submit" disabled={saving} className="bg-black text-white hover:bg-neutral-800"><Plus />Add</Button></form>{error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}<div className="mt-8 divide-y divide-neutral-100 border-y border-neutral-200">{feeds.map((item) => <div key={item.id} className="py-4">{editing === item.id ? <div className="flex flex-col gap-2"><Input value={draftName} onChange={(event) => setDraftName(event.target.value)} aria-label="Feed name" /><Input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} aria-label="Feed category" /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button><Button type="button" size="sm" disabled={saving} onClick={() => saveEdit(item)} className="bg-black text-white hover:bg-neutral-800">Save</Button></div></div> : <div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm">{item.name}</div><div className="mt-1 text-xs text-neutral-400">{item.category} · {item.status}</div></div><div className="flex shrink-0 items-center gap-1"><Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => startEditing(item)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} onClick={() => remove(item)} disabled={saving}><Trash2 /></Button></div></div>}</div>)}</div></div>
}

function decodeEntities(value: string) {
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
  return DOMPurify.sanitize(decodeEntities(value), { ALLOWED_TAGS: ['a', 'b', 'br', 'em', 'i', 'strong', 'u', 'p'], ALLOWED_ATTR: ['href', 'target', 'rel'] })
}
