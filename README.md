# Ari Instrumentation

Analytics for the portfolio and its Ari chatbot. It answers two questions: **did anyone visit or chat?** and **how well is Ari doing?**

Live: **https://ari-instrumentation.pages.dev** (you'll be asked for the dashboard key once per device; `?key=…` in the URL also works).

## Architecture

```
portfolio (GitHub Pages)                    Cloudflare Pages: ari-instrumentation.pages.dev
┌───────────────────────┐  beacon   ┌──────────────────────────────────────────────┐
│ visit tracker         │ ───────>  │ /api/track      → KV ev:* (metadata only)    │
│ Ari widget            │ ───────>  │ /ari/*          → service binding → ari-chatbot
└───────────────────────┘           │ /api/analytics  → reads log:, fb:, vid:, ev: │
                                    │ /               → index.html (dashboard)     │
                                    └──────────────────────────────────────────────┘
                                                  shared KV namespace (SESSIONS)
```

Everything sits on `pages.dev` because some Indian ISPs block `*.workers.dev`. Under that block the dashboard loaded empty, and chats from those networks never reached Ari.

## What it measures

- **Visitors:** one row per browser, showing last seen, approximate city and network org (from Cloudflare's IP lookup; no IP is stored), device, referrer/UTM, time on site, scroll depth, links and project cards clicked, and questions asked to Ari.
- **Funnel:** portfolio visitors → opened Ari → asked → 3+ questions deep.
- **Ari quality:** answer rate (knowledge-base match), knowledge gaps, latency p50/p90/p95, model fallback mix, conversation depth, ratings.
- **Topics:** keyword rules in `src/worker.js`. These include a *prompt probing / jailbreak* bucket.
- Deltas compare against the previous window of equal length. Chat logs expire after 30 days and page events after 90 days.

## Excluding your own traffic

Open the portfolio once with `?me=1` on each device you use (and `?me=0` to undo). Or click **this is me** on a visitor row. Those browsers are removed from every metric, including past chats. The **include my visits** toggle brings them back.

## Deploy

```bash
./scripts/deploy.sh   # Pages (dashboard + API + Ari proxy) and the legacy workers.dev API
```

The dashboard key is the `DASH_KEY` secret: `wrangler pages secret put DASH_KEY --project-name ari-instrumentation`.

## API

- `GET /api/analytics?range=1d|7d|14d|30d&key=…[&me=1]`
- `POST /api/track` (text/plain JSON beacon: `view` | `click` | `leave` | `ari_open`)
- `POST /api/owner?v=<visitorId>&key=…[&remove=1]`
