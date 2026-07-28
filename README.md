# Ari Instrumentation

Analytics dashboard for Ari. **GitHub Pages** serves the HTML. **Cloudflare Worker** serves the API.

## Architecture

```
GitHub Pages                           Cloudflare Worker
┌─────────────────┐                    ┌──────────────────────┐
│  index.html      │  ── fetch ──────>  │  /api/analytics      │
│  (static)        │  <── JSON ───────  │  reads KV log:* keys │
└─────────────────┘                    └──────────────────────┘
                                                │
                                       shared KV namespace
                                        (same as portfolio)
```

## Setup

### 1. Worker: deploy the API

Set the KV namespace ID in `wrangler.toml` (same ID as the portfolio's `SESSIONS` binding), then:

```bash
wrangler deploy
```

### 2. Dashboard: enable GitHub Pages

In repo Settings → Pages → Source: **Deploy from branch**, branch: `main`, folder: `/ (root)`.

Dashboard goes live at `https://prashantsingh-19.github.io/ari-instrumentation/`

### 3. Confirm CORS

The worker already returns `Access-Control-Allow-Origin: *` on all responses, so GitHub Pages can fetch from it freely.

## API

`GET /api/analytics?range=14d` — range: `7d`, `14d`, `30d`, `all`

Returns KPIs, daily traffic, topic breakdown, top questions, latency distribution.
