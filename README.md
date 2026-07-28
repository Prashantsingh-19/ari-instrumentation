# Ari Instrumentation

Analytics dashboard for Ari — the crab chatbot on [Prashant's portfolio](https://prashantsingh-19.github.io/portfolio/). Tracks visitors, conversations, topics, latency, and common questions.

## Architecture

```
ari-chatbot Worker (portfolio)                  ari-instrumentation Worker
┌────────────────────────────┐   shared KV      ┌────────────────────────────┐
│  /chat handler             │  ──────────────>  │  GET /       → dashboard  │
│  writes log:{ts}:{session} │  SESSIONS ns     │  GET /api/analytics       │
│  to env.SESSIONS           │  (log:* prefix)  │  → aggregates + JSON      │
└────────────────────────────┘                  └────────────────────────────┘
```

Both workers share the same KV namespace. The portfolio worker uses `env.SESSIONS` (already configured). The instrumentation worker uses `env.ANALYTICS` — both point to the same namespace ID.

## Setup

### 1. Deploy

Copy the SESSIONS namespace ID from the portfolio's `wrangler.toml` into this repo's `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "ANALYTICS"
id = ""  # same ID as the portfolio's SESSIONS binding
```

```bash
wrangler deploy
```

### 2. Open the dashboard

Visit `https://ari-instrumentation.your-subdomain.workers.dev/`

## API

`GET /api/analytics?range=14d` — range: `7d`, `14d`, `30d`, `all`

Returns JSON with KPIs, daily traffic, topic breakdown, top questions, and latency distribution.

## File structure

```
ari-instrumentation/
├── src/worker.js       # Cloudflare Worker (dashboard HTML + API endpoint)
├── wrangler.toml       # Worker config
├── .gitignore
└── README.md
```

## Costs

$0 — Cloudflare free tier. 100k requests/day, 1M KV reads/day.
