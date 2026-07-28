# Ari Instrumentation

Analytics dashboard for Ari — the crab chatbot on [Prashant's portfolio](https://prashantsingh-19.github.io/portfolio/). Tracks visitors, conversations, topics, latency, and common questions.

## Architecture

```
ari-chatbot Worker (portfolio)            ari-instrumentation Worker
┌──────────────────────┐   KV (ANALYTICS)  ┌──────────────────────┐
│  /chat handler       │  ──────────────>  │  GET / → dashboard   │
│  writes log:{ts}:…   │  log events       │  GET /api/analytics  │
└──────────────────────┘                   │  → aggregates + JSON │
                                           └──────────────────────┘
```

## Setup

### 1. Deploy the worker

```bash
wrangler kv:namespace create analytics-logs
# → copy the returned ID
```

Paste the ID into `wrangler.toml`:

```toml
id = "your-namespace-id-here"
```

```bash
wrangler deploy
```

### 2. Instrument the portfolio chatbot

Add the same `ANALYTICS` KV binding to the portfolio's `wrangler.toml`. Then in `ari-worker.js`, add a fire-and-forget log after each chat reply:

```js
const startTime = Date.now();
const reply = await callLLM(env, messages, { maxTokens: 150 });
const latencyMs = Date.now() - startTime;

ctx.waitUntil((async () => {
  try {
    await env.ANALYTICS.put(
      `log:${Date.now()}:${sessionId}`,
      JSON.stringify({ ts: Date.now(), sessionId, message, reply, latencyMs }),
      { expirationTtl: 86400 * 30 }
    );
  } catch {}
})());
```

### 3. Open the dashboard

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
