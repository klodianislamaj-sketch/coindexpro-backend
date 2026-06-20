// ============================================================================
// conviction-worker.js — CoinDex Pro Phase 5B
// Computes a 1–100 conviction score per token from real backend data only.
//
// Conviction = 0.30*momentum + 0.20*searchAccel + 0.20*flowStrength
//            + 0.20*security + 0.10*providerReliability
// If a component is unavailable it is EXCLUDED and the remaining weights are
// renormalized (so present components always sum to 1.0). No synthetic values.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
// Sibling URLs via env: ANALYTICS_URL, SEARCH_URL, FLOWS_URL, CORE_URL.
//
// Routes:
//   GET  /api/conviction            -> stored scores (optional ?token=)
//   POST /api/conviction/compute    -> recompute + persist
// Cron: recompute on schedule.
// ============================================================================

const DAY = 86400000;
const WEIGHTS = { momentum: 0.30, searchAccel: 0.20, flowStrength: 0.20, security: 0.20, provider: 0.10 };

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
async function fetchJSON(url) { if (!url) return null; try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } }

// Normalize component map {name: value0..100 | null} into a final 1..100 score.
// Missing (null) components are dropped and remaining weights renormalized.
function computeConviction(components) {
  let wsum = 0, acc = 0;
  const used = {};
  for (const [name, w] of Object.entries(WEIGHTS)) {
    const v = components[name];
    if (v == null) continue;                       // exclude unavailable
    wsum += w; acc += w * clamp(v, 0, 100); used[name] = Math.round(v);
  }
  if (wsum === 0) return { score: null, used: {}, coverage: 0 };
  const score = clamp(Math.round(acc / wsum), 1, 100);   // renormalized
  return { score, used, coverage: wsum };
}

// Build component values (0..100) per token from sibling endpoints.
async function buildComponents(env) {
  const [top, search, flows, providers] = await Promise.all([
    fetchJSON(env.ANALYTICS_URL ? env.ANALYTICS_URL + '/api/analytics/top' : ''),
    fetchJSON(env.SEARCH_URL ? env.SEARCH_URL + '/api/search/insights' : ''),
    fetchJSON(env.FLOWS_URL ? env.FLOWS_URL + '/api/flows?limit=200' : ''),
    fetchJSON(env.CORE_URL ? env.CORE_URL + '/api/providers/health' : ''),
  ]);

  // momentum: persistence 0..1 → 0..100
  const momMap = new Map();
  for (const m of ((top && top.momentum) || [])) if (m.momentum != null) momMap.set(key(m.token_id), m.momentum * 100);

  // search acceleration: delta relative to prior → 0..100 (capped at +100%)
  const accMap = new Map();
  for (const r of ((search && search.fastestRising) || [])) {
    const prev = (num(r.count) || 0) - (num(r.delta) || 0);
    const pct = prev > 0 ? (num(r.delta) / prev) : (num(r.delta) > 0 ? 1 : 0);
    accMap.set(key(r.term), clamp(pct * 100, 0, 100));
  }

  // flow strength: presence + intensity of flow anomalies → 0..100
  const flowMap = new Map();
  for (const f of ((flows && flows.flows) || [])) {
    const d = f.details || {};
    let s = 40;                                         // base for any flow anomaly
    const imb = num(d.imbalance), ratio = num(d.ratio);
    if (imb != null) s = Math.max(s, clamp(Math.abs(imb) * 100, 0, 100));
    if (ratio != null) s = Math.max(s, clamp(ratio / 16 * 100, 0, 100));
    if (f.severity === 'critical') s = Math.max(s, 85);
    flowMap.set(key(f.token_id), Math.max(flowMap.get(key(f.token_id)) || 0, s));
  }

  // provider reliability: single global value (avg) → applies to all tokens.
  let providerVal = null;
  const provs = (providers && providers.providers) || [];
  if (provs.length) providerVal = clamp(provs.reduce((a, p) => a + (p.reliability || 0), 0) / provs.length * 100, 0, 100);

  // security: per-token, fetched on demand in compute() (needs chain+address).
  return { momMap, accMap, flowMap, providerVal };
}
function key(x) { return String(x == null ? '' : x).toLowerCase(); }

// Compute + persist conviction for the union of tokens seen across components.
async function compute(env) {
  if (!_dbOk(env)) return { ok: false, reason: 'db-unbound' };
  const { momMap, accMap, flowMap, providerVal } = await buildComponents(env);
  // security per token from D1 token_security (already stored 0..100 scores)
  const secMap = new Map();
  try {
    const r = await env.DB.prepare('SELECT address, score FROM token_security').all();
    for (const row of (r && r.results) || []) if (row.score != null) secMap.set(key(row.address), row.score);
  } catch (e) {}

  const tokens = new Set([...momMap.keys(), ...accMap.keys(), ...flowMap.keys(), ...secMap.keys()]);
  const now = Date.now();
  let written = 0;
  const results = [];
  for (const t of tokens) {
    const components = {
      momentum: momMap.has(t) ? momMap.get(t) : null,
      searchAccel: accMap.has(t) ? accMap.get(t) : null,
      flowStrength: flowMap.has(t) ? flowMap.get(t) : null,
      security: secMap.has(t) ? secMap.get(t) : null,
      provider: providerVal,
    };
    const { score, used, coverage } = computeConviction(components);
    if (score == null) continue;
    const payload = JSON.stringify({ components: used, coverage: +coverage.toFixed(2) });
    try {
      await env.DB.prepare(
        `INSERT INTO conviction_scores (token_id, score, components_json, created_at)
         VALUES (?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET
           score=excluded.score, components_json=excluded.components_json, created_at=excluded.created_at`
      ).bind(t, score, payload, now).run();
      written++;
      results.push({ token_id: t, score, components: used });
      // conviction decay alert: drop >20 vs previous snapshot in KV (24h window).
      await checkDecay(env, t, score, now);
    } catch (e) {}
  }
  return { ok: true, computed: results.length, written };
}

// KV snapshot of (score, ts) per token; logs a conviction_decay anomaly on >20 drop.
async function checkDecay(env, token, score, now) {
  if (!(env.CACHE && typeof env.CACHE.get === 'function')) return;
  const k = 'convsnap:' + token;
  let snap = null;
  try { const raw = await env.CACHE.get(k); if (raw) snap = JSON.parse(raw); } catch (e) {}
  if (snap && snap.ts && (now - snap.ts) >= DAY) {
    const drop = (snap.score || 0) - score;
    if (drop > 20 && _dbOk(env)) {
      try {
        await env.DB.prepare('INSERT INTO anomalies (token_id, type, severity, details_json, created_at) VALUES (?,?,?,?,?)')
          .bind(token, 'conviction_decay', drop > 40 ? 'critical' : 'warn',
            JSON.stringify({ subtype: 'conviction_decay', from: snap.score, to: score, drop }), now).run();
      } catch (e) {}
    }
    try { await env.CACHE.put(k, JSON.stringify({ score, ts: now })); } catch (e) {}
  } else if (!snap) {
    try { await env.CACHE.put(k, JSON.stringify({ score, ts: now })); } catch (e) {}
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/conviction' && request.method === 'GET') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', scores: [] }, origin);
      const token = url.searchParams.get('token');
      const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
      let rows = [];
      try {
        if (token) { const r = await env.DB.prepare('SELECT * FROM conviction_scores WHERE token_id=?').bind(key(token)).all(); rows = (r && r.results) || []; }
        else { const r = await env.DB.prepare('SELECT * FROM conviction_scores ORDER BY score DESC LIMIT ?').bind(limit).all(); rows = (r && r.results) || []; }
      } catch (e) { rows = []; }
      return json(200, { scores: rows.map(r => { try { r.components = JSON.parse(r.components_json); } catch (e) { r.components = {}; } return r; }) }, origin);
    }

    if (url.pathname === '/api/conviction/compute' && request.method === 'POST') {
      return json(200, await compute(env), origin);
    }

    return json(404, { error: 'not found', routes: ['/api/conviction', '/api/conviction/compute'] }, origin);
  },

  async scheduled(event, env, ctx) { if (_dbOk(env)) ctx.waitUntil(compute(env).catch(() => {})); },
};
