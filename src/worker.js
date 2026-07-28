function classifyTopic(text) {
  const t = text.toLowerCase();
  if (/oncoassist|ocie|onco-dir|onco|soma|etl|pipeline|project|build|architect/i.test(t)) return 'projects';
  if (/background|physics|mba|career|path|story|pivot|bio|about/i.test(t)) return 'background';
  if (/hire|recruit|open.?to|role|internship|fit|availability|pm.?role|product.?manager/i.test(t)) return 'hiring';
  if (/skill|stack|tool|tech|react|next|python|database|sql|cloudflare/i.test(t)) return 'skills';
  if (/crab|ari|real|chatbot|ai|bot/i.test(t)) return 'off-topic';
  return 'background';
}

function aggregateAnalytics(logs, rangeDays) {
  const now = Date.now();
  const cutoff = rangeDays ? now - rangeDays * 86400000 : 0;
  const filtered = cutoff ? logs.filter(l => l.ts >= cutoff) : logs;

  if (!filtered.length) {
    return {
      window: { start: '—', end: '—' },
      kpis: { uniqueVisitors: 0, conversations: 0, avgLatencyMs: 0, avgTurnsPerConvo: 0 },
      daily: [], topics: [], topQuestions: [], latencyBuckets: [0, 0, 0, 0, 0, 0],
    };
  }

  const visitorSet = new Set(filtered.map(l => l.sessionId));
  const convosSet = new Set(filtered.map(l => l.sessionId));
  const latencies = filtered.filter(l => l.latencyMs != null).map(l => l.latencyMs);
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const turnsPerSession = {};
  filtered.forEach(l => { turnsPerSession[l.sessionId] = (turnsPerSession[l.sessionId] || 0) + 1; });
  const turnValues = Object.values(turnsPerSession);
  const avgTurnsPerConvo = turnValues.length ? Math.round((turnValues.reduce((a, b) => a + b, 0) / turnValues.length) * 10) / 10 : 0;

  const dayMap = {}, dayVisitors = {};
  filtered.forEach(l => {
    const d = new Date(l.ts).toISOString().slice(5, 10);
    if (!dayMap[d]) { dayMap[d] = new Set(); dayVisitors[d] = new Set(); }
    dayMap[d].add(l.sessionId); dayVisitors[d].add(l.sessionId);
  });
  const daily = Object.keys(dayMap).sort().map(d => ({
    date: d, visitors: dayVisitors[d].size, conversations: dayMap[d].size,
  }));

  const topicCounts = {};
  filtered.forEach(l => {
    const topic = l.topic || classifyTopic(l.message);
    topicCounts[topic] = (topicCounts[topic] || 0) + 1;
  });
  const totalTagged = Object.values(topicCounts).reduce((a, b) => a + b, 0);
  const topicLabels = { projects: 'Projects & technical work', background: 'Background & career path', hiring: 'Hiring / availability fit', skills: 'Skills & toolkit', 'off-topic': 'Off-topic / testing Ari' };
  const topics = ['projects', 'background', 'hiring', 'skills', 'off-topic'].filter(t => topicCounts[t]).map(t => ({
    name: topicLabels[t] || t, pct: totalTagged ? Math.round((topicCounts[t] / totalTagged) * 100) : 0,
  }));

  const qCounts = {};
  filtered.forEach(l => { const n = l.message.trim().toLowerCase(); qCounts[n] = (qCounts[n] || 0) + 1; });
  const topQuestions = Object.entries(qCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([text]) => {
    const sample = filtered.find(l => l.message.toLowerCase() === text);
    return { text, topic: sample ? sample.topic || classifyTopic(text) : classifyTopic(text), count: qCounts[text] };
  });

  const buckets = [0, 0, 0, 0, 0, 0];
  latencies.forEach(ms => { const s = ms / 1000; if (s < 1) buckets[0]++; else if (s < 2) buckets[1]++; else if (s < 3) buckets[2]++; else if (s < 4) buckets[3]++; else if (s < 5) buckets[4]++; else buckets[5]++; });
  const latencyMax = Math.max(...buckets, 1);
  const latencyBuckets = buckets.map(v => Math.round((v / latencyMax) * 100));

  const ts = filtered.map(l => l.ts).sort((a, b) => a - b);
  return {
    window: { start: ts.length ? new Date(ts[0]).toISOString().slice(0, 10) : '—', end: ts.length ? new Date(ts[ts.length - 1]).toISOString().slice(0, 10) : '—' },
    kpis: { uniqueVisitors: visitorSet.size, conversations: convosSet.size, avgLatencyMs, avgTurnsPerConvo },
    daily, topics, topQuestions, latencyBuckets,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/analytics') {
      const rangeParam = url.searchParams.get('range') || '14d';
      const rangeDays = rangeParam === 'all' ? null : rangeParam === '7d' ? 7 : rangeParam === '30d' ? 30 : 14;
      try {
        const keys = await env.ANALYTICS.list({ prefix: 'log:' });
        const values = await Promise.all(keys.keys.map(k => env.ANALYTICS.get(k.name)));
        const data = aggregateAnalytics(values.filter(Boolean).map(JSON.parse), rangeDays);
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
