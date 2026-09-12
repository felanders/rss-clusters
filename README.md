# Clustered RSS Feeds

A personal RSS reader that groups articles from all your feeds into the stories they are actually about. Each cluster gets a new, neutral headline and a short summary written by an LLM; expand a cluster to see the source articles, expand an article to read its summary.

## How clustering works

1. **Retrieve** — every feed is fetched (`lib/feeds.ts`), new articles are stored.
2. **Embed** — right after retrieval, `headline + short summary` of each new article is embedded (`lib/embeddings.ts`). Default: `baai/bge-m3` via OpenRouter (multilingual, ~$0.01 / 1M tokens). Alternatively run a local model with `EMBEDDING_PROVIDER=local`.
3. **Nearest neighbours** — each new article is compared (cosine) against recent articles; pairs above `CLUSTER_NEIGHBOR_THRESHOLD` published within `CLUSTER_MAX_TIME_GAP_HOURS` of each other are joined into candidate groups (`lib/clustering.ts`).
4. **LLM verification** — each candidate group is sent to `OPENROUTER_CLUSTER_MODEL`, which keeps only articles that report the *same* event, and writes a neutral, direct headline plus 2–3 summary bullets per cluster. Anything it does not confirm stays a single article.

Only LLM-confirmed groups of two or more articles become clusters. Later arrivals can still join an existing cluster (its headline/summary is refreshed).

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in DATABASE_URL, BETTER_AUTH_SECRET, OPENROUTER_API_KEY
pnpm db:migrate              # creates / updates the app tables (idempotent)
pnpm dev
```

Sign up, add feeds in ⚙ settings, then press ↻ (fetch feeds → embed → cluster new articles). **Recluster** rebuilds every cluster from scratch.

### Command line

```bash
pnpm cluster you@example.com             # embed + cluster whatever is pending for that user
pnpm cluster you@example.com --refresh   # fetch feeds first
pnpm cluster you@example.com --recluster # full rebuild
```

### Scheduled refresh

`vercel.json` calls `/api/cron/refresh` daily (cron expressions are UTC; `0 5 * * *` = 07:00 CEST / 06:00 CET). The route needs `CRON_SECRET`; it runs step 1–4 for every user.

### Local embeddings

```bash
pnpm add @huggingface/transformers
EMBEDDING_PROVIDER=local pnpm dev
```

The package is loaded lazily and only when the provider is `local`, so deployments that use OpenRouter don't ship it. Changing the embedding provider/model marks all stored vectors stale; run **Recluster** afterwards.
