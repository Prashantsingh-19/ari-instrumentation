// Ari analytics API. Runs as the Cloudflare Pages _worker.js (dashboard + API on one
// pages.dev origin) and, for backward compatibility, as the standalone workers.dev worker.
//
// KV records written by the ari-chatbot worker (shared SESSIONS namespace):
//   log:<ts>:<sessionId>  {ts, sessionId, visitorId, message, reply, latencyMs, found, model,
//                          rewrites?, scoreBefore?}  TTL 30d; rewrites = CRAG queries tried on a weak first match
//   fb:<postId>           {ts, sessionId, visitorId, postId, message, rating, review}          TTL 30d
//   vid:<visitorId>       '1', re-put on every widget open with TTL 90d (expiration - 90d = last open)
// Written by this worker (/api/track, beacons from the portfolio page):
//   ev:<ts>:<visitorId>:<rand>  '' with the event in key metadata (so list() returns it, no gets)  TTL 90d
//   owner:<visitorId>           browsers marked as the site owner via ?me=1; excluded from analytics
//   lead:<ts>:<visitorId>       {ts, v, sessionId, name, email, feedback, location} left in Ari's contact form  TTL 365d

const DAY = 86400000;
const IST_OFFSET = 5.5 * 3600000;
const RETENTION_DAYS = 30;
const VID_TTL_DAYS = 90;
const MAX_LOGS = 800; // KV ops per invocation are capped; keep the most recent logs

const TOPICS = [
  ['smalltalk', 'Greetings & small talk', /^(hi+|hey+|hello+|yo|sup|thanks?|thank you|ok(ay)?|cool|nice|bye|good (morning|evening|afternoon))\b[\s!.?]*$/i],
  ['probing', 'Prompt probing / jailbreak attempts', /system prompt|your (instructions|prompt|rules)|ignore (all |your |previous )|pretend|jailbreak|act as|roleplay|developer mode|confirm it|reveal|\bdan\b|no rules/i],
  ['hiring', 'Hiring, availability & contact', /hire|hiring|recruit|open to|available|availability|notice period|relocat|salary|ctc|contact|email|phone|linkedin|resume|cv\b|reach (him|out)|interview|join/i],
  ['projects', 'Projects & case studies', /project|built|build|case study|ari\b.*(work|built|rag)|rag\b|voice agent|collectiq|earnings|copilot|servzone|featurepilot|ai os|onco|topic model|credit|default|finspark|fraud|garch|nifty|portfolio risk|quickreach|segmentation|survival|sla\b|delay risk|dashboard|pipeline|model/i],
  ['experience', 'Work experience', /experience|intern|i3digital|arisinfra|worked|work at|company|job|role at|responsibilit/i],
  ['skills', 'Skills & toolkit', /skill|stack|tool|tech|python|sql|excel|power ?bi|tableau|react|cloudflare|llm|machine learning|\bml\b|statistic|product management|\bpm\b/i],
  ['background', 'Background & education', /background|physics|mba|bits|pilani|education|stud(y|ied)|college|degree|career|pivot|story|about (him|prashant)|who is|tell me about/i],
  ['meta', 'About Ari / testing', /\bari\b|are (you|u) (a |an )?(bot|ai|human|real)|(you|u) are an? (ai|bot)|prompt|vector|embedding|knowledge base|external source|chatbot|who (are|r) (you|u)|what (are|r) (you|u)/i],
];
const TOPIC_LABELS = Object.fromEntries(TOPICS.map(([k, l]) => [k, l]).concat([['other', 'Other']]));

function classifyTopic(text) {
  const t = (text || '').trim();
  for (const [key, , re] of TOPICS) if (re.test(t)) return key;
  return 'other';
}

function normalizeQuestion(text) {
  return (text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

const istDate = ts => new Date(ts + IST_OFFSET).toISOString().slice(0, 10);
const istHour = ts => new Date(ts + IST_OFFSET).getUTCHours();
// Logs from 2026-10-24 carry the retrieval score; a question counts as answered only on a strong
// match (>= 0.62, calibrated for bge-base). Older logs used a 0.35 cut-off that passed everything.
const answered = l => (l.topScore != null ? l.topScore >= 0.62 : l.found !== false);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// Headline numbers for one slice of logs; used for the current and the previous period.
function summarize(logs, fb) {
  const sessions = {};
  logs.forEach(l => { (sessions[l.sessionId] = sessions[l.sessionId] || []).push(l); });
  const turns = Object.values(sessions).map(s => s.length);
  const lat = logs.filter(l => l.latencyMs != null).map(l => l.latencyMs).sort((a, b) => a - b);
  const answeredCount = logs.filter(answered).length;
  const up = fb.filter(f => f.rating === 'up').length, down = fb.filter(f => f.rating === 'down').length;
  return {
    visitors: new Set(logs.map(l => l.visitorId || l.sessionId)).size,
    conversations: turns.length,
    questions: logs.length,
    answerRate: pct(answeredCount, logs.length),
    medianLatencyMs: quantile(lat, 0.5),
    p90LatencyMs: quantile(lat, 0.9),
    avgTurns: turns.length ? Math.round((logs.length / turns.length) * 10) / 10 : null,
    bounceRate: pct(turns.filter(t => t === 1).length, turns.length),
    helpfulRate: pct(up, up + down),
    ratings: up + down,
  };
}

function sourceOf(ref, utm) {
  const r = ((utm || '') + ' ' + (ref || '')).toLowerCase();
  if (!r.trim()) return 'Direct / unknown';
  if (/linkedin|lnkd/.test(r)) return 'LinkedIn';
  if (/naukri|instahyre|wellfound|angel|cutshort|hirist|iimjobs|indeed|glassdoor/.test(r)) return 'Job boards';
  if (/mail|gmail|outlook/.test(r)) return 'Email';
  if (/google|bing|duckduckgo|yahoo|ecosia/.test(r)) return 'Search';
  if (/github/.test(r)) return 'GitHub';
  if (/whatsapp|wa\.me|t\.co|twitter|x\.com|instagram|facebook|telegram/.test(r)) return 'Social / messaging';
  return 'Other: ' + r.trim().split(/[\s/]/)[0].slice(0, 40);
}

// Portfolio page analytics from beacon events, joined with Ari chat logs per visitor.
function siteAnalytics(ev, chats) {
  const views = ev.filter(e => e.t === 'view');
  const people = {};
  const person = v => (people[v] = people[v] || { id: v, visitor: String(v).slice(0, 6), firstTs: Infinity, lastTs: 0, views: 0, pages: new Set(), clicks: [], dur: {}, scroll: 0, questions: [], ariOpened: false });
  ev.forEach(e => {
    const p = person(e.v);
    p.firstTs = Math.min(p.firstTs, e.ts); p.lastTs = Math.max(p.lastTs, e.ts);
    if (e.t === 'view') {
      p.views++; p.pages.add(e.s);
      if (!p.loc) { p.loc = [e.ci, e.rg, e.c].filter(Boolean).join(', '); p.org = e.o; p.device = [e.dv, e.b, e.os].filter(Boolean).join(' · '); p.source = sourceOf(e.r, e.u); p.ref = e.r || ''; p.utm = e.u || ''; }
    }
    if (e.t === 'click' && e.l && p.clicks.length < 30) p.clicks.push(e.l);
    if (e.t === 'leave') { p.dur[e.s] = Math.max(p.dur[e.s] || 0, e.d || 0); p.scroll = Math.max(p.scroll, e.sc || 0); }
    if (e.t === 'ari_open') p.ariOpened = true;
  });
  chats.forEach(l => {
    if (!l.visitorId) return;
    const p = person(l.visitorId);
    p.firstTs = Math.min(p.firstTs, l.ts); p.lastTs = Math.max(p.lastTs, l.ts);
    p.questions.push(l.message); p.ariOpened = true;
  });
  const list = Object.values(people).map(p => {
    const secs = Object.values(p.dur).reduce((a, b) => a + b, 0);
    const uniqClicks = [...new Set(p.clicks)];
    return {
      id: p.id, visitor: p.visitor, firstTs: p.firstTs, lastTs: p.lastTs, visits: p.pages.size, views: p.views,
      location: p.loc || '—', org: p.org || '', device: p.device || '', source: p.source || (p.questions.length ? 'Unknown (chat only)' : 'Direct / unknown'),
      ref: p.ref || '', utm: p.utm || '', timeOnSiteS: secs, maxScroll: p.scroll, clicks: uniqClicks.slice(0, 12),
      ariOpened: p.ariOpened, questions: p.questions.length, firstQuestion: p.questions[0] || '',
      engaged: secs >= 30 || uniqClicks.length > 0 || p.questions.length > 0,
    };
  }).sort((a, b) => b.lastTs - a.lastTs);

  const srcAgg = {}, clickAgg = {}, orgAgg = {}, locAgg = {};
  list.forEach(p => {
    if (p.views) srcAgg[p.source] = (srcAgg[p.source] || 0) + 1;
    p.clicks.forEach(c => { clickAgg[c] = (clickAgg[c] || 0) + 1; });
    if (p.org) orgAgg[p.org] = (orgAgg[p.org] || 0) + 1;
    if (p.location !== '—') locAgg[p.location] = (locAgg[p.location] || 0) + 1;
  });
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, count]) => ({ label, count }));
  const durs = list.filter(p => p.views && p.timeOnSiteS).map(p => p.timeOnSiteS).sort((a, b) => a - b);
  const visitorsWithViews = list.filter(p => p.views);
  return {
    visitors: visitorsWithViews.length,
    pageViews: views.length,
    engaged: visitorsWithViews.filter(p => p.engaged).length,
    medianTimeOnPageS: quantile(durs, 0.5),
    people: list.slice(0, 60),
    sources: top(srcAgg, 8), clicks: top(clickAgg, 12), orgs: top(orgAgg, 8), locations: top(locAgg, 8),
  };
}

export { classifyTopic };

export function aggregate({ logs, fb, visitorOpens, events = [], leads = [], owners = new Set(), includeMe = false, rangeDays, now = Date.now(), truncated = false }) {
  const mine = v => !includeMe && owners.has(v);
  const excluded = { chats: 0, events: 0 };
  logs = logs.filter(l => l && l.ts && l.sessionId).filter(l => !(mine(l.visitorId) && ++excluded.chats)).sort((a, b) => a.ts - b.ts);
  fb = fb.filter(f => !mine(f.visitorId));
  visitorOpens = visitorOpens.filter(o => !mine(o.id)).map(o => o.ts);
  events = events.filter(e => !(mine(e.v) && ++excluded.events)).sort((a, b) => a.ts - b.ts);
  leads = leads.filter(c => c && c.ts && !mine(c.v)).sort((a, b) => b.ts - a.ts);
  const effectiveDays = rangeDays || RETENTION_DAYS;
  const start = now - effectiveDays * DAY;
  const prevStart = start - effectiveDays * DAY;
  const cur = logs.filter(l => l.ts >= start);
  const curFb = fb.filter(f => f.ts >= start);
  const kpis = summarize(cur, curFb);
  // Logs expire after 30 days, so a previous period only exists for ranges up to 15 days.
  const prevAvailable = rangeDays && rangeDays * 2 <= RETENTION_DAYS;
  const prev = prevAvailable
    ? summarize(logs.filter(l => l.ts >= prevStart && l.ts < start), fb.filter(f => f.ts >= prevStart && f.ts < start))
    : null;

  const curEv = events.filter(e => e.ts >= start);
  const site = siteAnalytics(curEv, cur);
  const prevEv = prevAvailable ? events.filter(e => e.ts >= prevStart && e.ts < start) : null;
  if (prevEv) prev.siteVisitors = new Set(prevEv.filter(e => e.t === 'view').map(e => e.v)).size;
  kpis.siteVisitors = site.visitors;
  kpis.pageViews = site.pageViews;
  kpis.medianTimeOnPageS = site.medianTimeOnPageS;
  const opened = visitorOpens.filter(ts => ts >= start).length;
  const askedVisitors = new Set(cur.map(l => l.visitorId).filter(Boolean));

  // Returning = visitor whose first question was before this window started.
  const firstSeen = {};
  logs.forEach(l => { const v = l.visitorId || l.sessionId; if (!(v in firstSeen)) firstSeen[v] = l.ts; });
  const curVisitors = new Set(cur.map(l => l.visitorId || l.sessionId));
  const returning = [...curVisitors].filter(v => firstSeen[v] < start).length;

  // Daily series, zero-filled so gaps read as quiet days rather than disappearing.
  const daily = [];
  const firstDay = rangeDays ? start : cur.length ? cur[0].ts : now;
  for (let t = firstDay; istDate(t) <= istDate(now); t += DAY) {
    const d = istDate(t);
    if (!daily.length || daily[daily.length - 1].date !== d) daily.push({ date: d, views: 0, siteVisitors: 0, _sv: new Set(), questions: 0, unanswered: 0, conversations: 0, visitors: 0, _s: new Set(), _v: new Set() });
  }
  const dayIdx = Object.fromEntries(daily.map((d, i) => [d.date, i]));
  cur.forEach(l => {
    const d = daily[dayIdx[istDate(l.ts)]];
    if (!d) return;
    d.questions++;
    if (l.found === false) d.unanswered++;
    d._s.add(l.sessionId); d._v.add(l.visitorId || l.sessionId);
  });
  curEv.filter(e => e.t === 'view').forEach(e => {
    const d = daily[dayIdx[istDate(e.ts)]];
    if (d) { d.views++; d._sv.add(e.v); }
  });
  daily.forEach(d => { d.siteVisitors = d._sv.size; delete d._sv; });
  daily.forEach(d => { d.conversations = d._s.size; d.visitors = d._v.size; delete d._s; delete d._v; });

  const hourly = Array(24).fill(0);
  cur.forEach(l => hourly[istHour(l.ts)]++);

  // Topics: all questions, plus what people open a conversation with.
  const topicAgg = {};
  const sessionsFirst = {};
  cur.forEach(l => {
    const k = classifyTopic(l.message);
    const a = (topicAgg[k] = topicAgg[k] || { questions: 0, answered: 0, openers: 0 });
    a.questions++;
    if (answered(l)) a.answered++;
    if (!sessionsFirst[l.sessionId]) { sessionsFirst[l.sessionId] = true; a.openers++; }
  });
  const topics = Object.entries(topicAgg).sort((a, b) => b[1].questions - a[1].questions).map(([k, a]) => ({
    key: k, name: TOPIC_LABELS[k], questions: a.questions, pct: pct(a.questions, cur.length),
    openers: a.openers, answerRate: pct(a.answered, a.questions),
  }));

  // Question clusters on normalized text.
  const qAgg = {};
  cur.forEach(l => {
    const n = normalizeQuestion(l.message);
    if (!n) return;
    const q = (qAgg[n] = qAgg[n] || { text: l.message.trim(), count: 0, answered: 0, lastTs: 0, sessions: new Set() });
    q.count++; if (answered(l)) q.answered++;
    q.sessions.add(l.sessionId);
    if (l.ts > q.lastTs) { q.lastTs = l.ts; q.text = l.message.trim(); }
  });
  const qList = Object.values(qAgg).map(q => ({
    text: q.text, topic: classifyTopic(q.text), count: q.count, sessions: q.sessions.size,
    answerRate: pct(q.answered, q.count), lastTs: q.lastTs,
  }));
  const topQuestions = qList.slice().sort((a, b) => b.count - a.count || b.lastTs - a.lastTs).slice(0, 10);
  const unanswered = qList.filter(q => q.answerRate !== 100).map(q => ({ ...q, misses: Math.round(q.count * (100 - q.answerRate) / 100) }))
    .sort((a, b) => b.misses - a.misses || b.lastTs - a.lastTs).slice(0, 10);

  // Conversation depth.
  const sessTurns = {};
  cur.forEach(l => { sessTurns[l.sessionId] = (sessTurns[l.sessionId] || 0) + 1; });
  const depth = [['1', t => t === 1], ['2', t => t === 2], ['3–5', t => t >= 3 && t <= 5], ['6+', t => t >= 6]]
    .map(([label, f]) => ({ label, count: Object.values(sessTurns).filter(f).length }));

  // Latency (end-to-end reply time) and model mix.
  const lat = cur.filter(l => l.latencyMs != null).map(l => l.latencyMs).sort((a, b) => a - b);
  const edges = [1, 2, 3, 5, 8, 12];
  const latencyBuckets = edges.concat([Infinity]).map((e, i) => ({
    label: i === 0 ? '<1s' : e === Infinity ? '>' + edges[edges.length - 1] + 's' : edges[i - 1] + '–' + e + 's',
    count: lat.filter(ms => ms / 1000 < e && (i === 0 || ms / 1000 >= edges[i - 1])).length,
  }));
  const modelLabels = {
    'gpt-oss-120b': 'Cloudflare gpt-oss-120b',
    'glm-4.7-flash': 'Cloudflare GLM-4.7-Flash',
    'deepseek-v4-pro': 'NVIDIA DeepSeek V4 Pro',
    'nemotron-ultra': 'OpenRouter Nemotron Ultra',
    'gemma-4-26b': 'OpenRouter Gemma 4 26B',
  };
  const mAgg = {};
  cur.forEach(l => {
    const k = l.model || 'untagged';
    const m = (mAgg[k] = mAgg[k] || { count: 0, answered: 0, lat: [] });
    m.count++; if (answered(l)) m.answered++;
    if (l.latencyMs != null) m.lat.push(l.latencyMs);
  });
  const models = Object.entries(mAgg).sort((a, b) => b[1].count - a[1].count).map(([k, m]) => {
    const s = m.lat.sort((a, b) => a - b);
    return { model: modelLabels[k] || k, count: m.count, pct: pct(m.count, cur.length), medianLatencyMs: quantile(s, 0.5), p90LatencyMs: quantile(s, 0.9), answerRate: pct(m.answered, m.count) };
  });

  const recent = cur.slice(-30).reverse().map(l => ({
    ts: l.ts, session: String(l.sessionId).slice(0, 6), visitor: String(l.visitorId || '').slice(0, 6),
    message: l.message, reply: (l.reply || '').slice(0, 4000), found: answered(l), match: l.match || null, topScore: l.topScore ?? null, sources: (l.sources || []).slice(0, 3),
    model: modelLabels[l.model] || l.model || '—', latencyMs: l.latencyMs,
    rewrites: l.rewrites || null, scoreBefore: l.scoreBefore ?? null,
  }));

  // Corrective RAG: questions whose first retrieval was weak, and how many the rewrite lifted to a strong match.
  const tried = cur.filter(l => l.scoreBefore != null);
  const crag = { tried: tried.length, rescued: tried.filter(l => l.scoreBefore < 0.62 && l.topScore >= 0.62).length, improved: tried.filter(l => l.topScore > l.scoreBefore).length };

  const reviews = curFb.slice().sort((a, b) => b.ts - a.ts).filter(f => f.review || f.rating === 'down').slice(0, 8)
    .map(f => ({ ts: f.ts, rating: f.rating, review: f.review || '', question: f.message || '' }));

  return {
    meta: {
      generatedAt: now, rangeDays: rangeDays || null, retentionDays: RETENTION_DAYS,
      windowStart: istDate(start), windowEnd: istDate(now),
      lastEventTs: logs.length ? logs[logs.length - 1].ts : null,
      storedLogs: logs.length, truncated, prevAvailable: !!prevAvailable,
      lastVisitTs: events.length ? events[events.length - 1].ts : null,
      trackingSince: events.length ? events[0].ts : null,
      owners: owners.size, includeMe, excluded,
    },
    site,
    kpis, prev,
    funnel: { siteVisitors: site.visitors, opened, asked: askedVisitors.size, returning, newVisitors: curVisitors.size - returning },
    daily, hourly, topics, topQuestions, unanswered, depth,
    latency: { buckets: latencyBuckets, p50: quantile(lat, 0.5), p90: quantile(lat, 0.9), p95: quantile(lat, 0.95), max: lat.length ? lat[lat.length - 1] : null },
    models, recent, crag,
    feedback: { up: curFb.filter(f => f.rating === 'up').length, down: curFb.filter(f => f.rating === 'down').length, reviews },
    // Contacts are kept for a year and listed in full, whatever the selected range.
    contacts: {
      total: leads.length, inWindow: leads.filter(c => c.ts >= start).length,
      withEmail: leads.filter(c => c.email).length,
      list: leads.slice(0, 50).map(c => ({ ts: c.ts, visitor: String(c.v).slice(0, 6), name: c.name || '', email: c.email || '', feedback: c.feedback || '', location: c.location || '' })),
    },
  };
}

async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

async function getJson(kv, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 50) {
    const vals = await Promise.all(keys.slice(i, i + 50).map(k => kv.get(k.name)));
    vals.forEach(v => { if (v) try { out.push(JSON.parse(v)); } catch {} });
  }
  return out;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});

function device(ua) {
  const dv = /ipad|tablet/i.test(ua) ? 'tablet' : /mobi|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
  const b = /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : '';
  const os = /windows/i.test(ua) ? 'Windows' : /iphone|ipad|ios/i.test(ua) ? 'iOS' : /mac os/i.test(ua) ? 'macOS' : /android/i.test(ua) ? 'Android' : /linux/i.test(ua) ? 'Linux' : '';
  return { dv, b, os };
}
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|monitor|pingdom/i;
const clip = (v, n) => (v == null ? '' : String(v)).slice(0, n);

async function track(request, env) {
  const ua = request.headers.get('User-Agent') || '';
  if (BOT_UA.test(ua)) return new Response(null, { status: 204, headers: CORS });
  let b;
  try { b = JSON.parse(await request.text()); } catch { return new Response(null, { status: 400, headers: CORS }); }
  const v = clip(b.v, 36);
  if (!v || !['view', 'click', 'leave', 'ari_open'].includes(b.t)) return new Response(null, { status: 400, headers: CORS });
  if (b.owner) await env.ANALYTICS.put('owner:' + v, String(Date.now()));
  const cf = request.cf || {};
  const ts = Date.now();
  const m = { t: b.t, v, s: clip(b.s, 12), p: clip(b.p, 60) };
  if (b.t === 'view') Object.assign(m, { r: clip(b.r, 120), u: clip(b.u, 80), c: clip(cf.country, 2), ci: clip(cf.city, 40), rg: clip(cf.region, 40), o: clip(cf.asOrganization, 60) }, device(ua));
  if (b.t === 'click') Object.assign(m, { l: clip(b.l, 80), h: clip(b.h, 150) });
  if (b.t === 'leave') Object.assign(m, { d: Math.min(Math.round(+b.d || 0), 7200), sc: Math.min(Math.round(+b.sc || 0), 100) });
  await env.ANALYTICS.put(`ev:${ts}:${v}:${Math.random().toString(36).slice(2, 6)}`, '', { metadata: m, expirationTtl: 86400 * 90 });
  return new Response(null, { status: 204, headers: CORS });
}

const rangeOf = url => { const r = url.searchParams.get('range'); return ['1d', '7d', '14d', '30d', 'all'].includes(r) ? r : '14d'; };

// Name, email and feedback a visitor chose to leave in Ari's contact form.
async function contact(request, env) {
  if (BOT_UA.test(request.headers.get('User-Agent') || '')) return new Response(null, { status: 204, headers: CORS });
  let b;
  try { b = JSON.parse(await request.text()); } catch { return json({ error: 'bad json' }, 400); }
  const v = clip(b.v, 36), name = clip(b.name, 80).trim(), email = clip(b.email, 120).trim(), feedback = clip(b.feedback, 600).trim();
  if (!v || !(name || email || feedback)) return json({ error: 'nothing to save' }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid email' }, 400);
  const cf = request.cf || {}, ts = Date.now();
  const location = [cf.city, cf.region, cf.country].filter(Boolean).join(', ');
  await env.ANALYTICS.put(`lead:${ts}:${v}`, JSON.stringify({ ts, v, sessionId: clip(b.s, 36), name, email, feedback, location }), { expirationTtl: 86400 * 365 });
  return json({ ok: true });
}

async function analytics(url, env, includeMe = url.searchParams.get('me') === '1') {
  const r = rangeOf(url);
  const rangeDays = r === 'all' ? null : ({ '1d': 1, '7d': 7, '14d': 14, '30d': 30 })[r];
  const [logKeys, fbKeys, vidKeys, evKeys, ownerKeys, leadKeys] = await Promise.all([
    listAll(env.ANALYTICS, 'log:'), listAll(env.ANALYTICS, 'fb:'), listAll(env.ANALYTICS, 'vid:'),
    listAll(env.ANALYTICS, 'ev:'), listAll(env.ANALYTICS, 'owner:'), listAll(env.ANALYTICS, 'lead:'),
  ]);
  // Keys are log:<ts>:<session>, so lexical order is chronological for 13-digit timestamps.
  logKeys.sort((a, b) => (a.name < b.name ? -1 : 1));
  const truncated = logKeys.length > MAX_LOGS;
  leadKeys.sort((a, b) => (a.name < b.name ? -1 : 1));
  const [logs, fb, leads] = await Promise.all([getJson(env.ANALYTICS, logKeys.slice(-MAX_LOGS)), getJson(env.ANALYTICS, fbKeys.slice(-200)), getJson(env.ANALYTICS, leadKeys.slice(-100))]);
  const visitorOpens = vidKeys.filter(k => k.expiration).map(k => ({ id: k.name.slice(4), ts: k.expiration * 1000 - VID_TTL_DAYS * DAY }));
  const events = evKeys.filter(k => k.metadata).map(k => ({ ts: +k.name.split(':')[1], ...k.metadata }));
  const owners = new Set(ownerKeys.map(k => k.name.slice(6)));
  return aggregate({ logs, fb, visitorOpens, events, leads, owners, includeMe, rangeDays, truncated });
}

// Public guest view (no key): counts and charts, plus a glimpse of the top questions with contact
// details masked. Visitor rows, sources, locations, networks, replies and reviews never leave the worker.
const GUEST_QUESTIONS = 3;
const scrub = t => t
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/https?:\/\/\S+|www\.\S+/gi, '[link]')
  .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
  .slice(0, 120);
export function guestView(d) {
  return {
    ...d,
    meta: { ...d.meta, guest: true, includeMe: false, excluded: { chats: 0, events: 0 }, distinctQuestions: d.topQuestions.length },
    site: { ...d.site, people: [], orgs: [], locations: [], sources: [] },
    topQuestions: d.topQuestions.slice(0, GUEST_QUESTIONS).map(q => ({ text: scrub(q.text), topic: q.topic, count: q.count, sessions: q.sessions, lastTs: q.lastTs })),
    unanswered: [], recent: [],
    feedback: { ...d.feedback, reviews: [] },
    contacts: { ...d.contacts, list: [] },
  };
}

// Guests are unauthenticated, so cache per range to keep KV list operations bounded.
const GUEST_TTL = 5 * 60000;
const guestCache = new Map();
async function guestAnalytics(url, env) {
  const r = rangeOf(url), hit = guestCache.get(r);
  if (hit && Date.now() - hit.at < GUEST_TTL) return hit.body;
  const body = guestView(await analytics(url, env, false));
  guestCache.set(r, { at: Date.now(), body });
  return body;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/api/track' && request.method === 'POST') {
      try { return await track(request, env); } catch { return new Response(null, { status: 204, headers: CORS }); }
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      try { return await contact(request, env); } catch { return json({ error: 'failed' }, 500); }
    }

    // Mark / unmark a visitor as the site owner from the dashboard.
    if (url.pathname === '/api/owner' && request.method === 'POST') {
      if (env.DASH_KEY && url.searchParams.get('key') !== env.DASH_KEY) return json({ error: 'unauthorized' }, 401);
      const v = clip(url.searchParams.get('v'), 36);
      if (!v) return json({ error: 'v required' }, 400);
      if (url.searchParams.get('remove') === '1') await env.ANALYTICS.delete('owner:' + v);
      else await env.ANALYTICS.put('owner:' + v, String(Date.now()));
      return json({ ok: true });
    }

    if (url.pathname === '/api/analytics') {
      const guest = url.searchParams.get('guest') === '1';
      if (!guest && env.DASH_KEY && url.searchParams.get('key') !== env.DASH_KEY) return json({ error: 'unauthorized' }, 401);
      try { return json(guest ? await guestAnalytics(url, env) : await analytics(url, env)); } catch (err) { return json({ error: err.message }, 500); }
    }

    // Reverse proxy for the chatbot, so visitors whose ISP blocks *.workers.dev can still reach Ari.
    if (url.pathname.startsWith('/ari/') && env.ARI) {
      const target = new URL(url.pathname.slice(4) + url.search, 'https://ari-chatbot.internal');
      return env.ARI.fetch(new Request(target, request));
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
