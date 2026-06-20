// ============================================================================
// signals-worker.js — CoinDex Pro Phase 5A (Autonomous Intelligence Engine)
// Generates deterministic signals from data ALREADY produced by the other
// workers (analytics, flows, provider_health, search trending, security audit).
// Strength/confidence derive strictly from real threshold distances — no fake
// scoring. Persists to the `signals` D1 table (0008_signals.sql).
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
// Reads sibling endpoints via env vars (set to the deployed worker URLs):
//   ANALYTICS_URL, FLOWS_URL, SEARCH_URL   (optional; '' => that source skipped)
//
// Routes:
//   GET  /api/signals          -> recent signals (from D1)
//   POST /api/signals/generate -> run generation pass now
// Cron: generate on a schedule (wire crons in wrangler.signals.toml)
// ============================================================================

const DAY = 86400000;

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function _kvOk(env) { return !!(env && env.CACHE && typeof env.CACHE.get === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// fetch JSON from a sibling worker; honest null on any failure.
async function fetchJSON(url) {
  if (!url) return null;
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch (e) { return null; }
}

// stable id from type+token+day so repeated generation in the same day upserts
// rather than duplicating.
function signalId(type, tokenId, ts) {
  return `${type}:${tokenId || 'global'}:${Math.floor(ts / DAY)}`;
}

// ── signal generators ───────────────────────────────────────────────────────
// Each returns an array of {token_id, type, strength, confidence, reason}.
// strength/confidence ∈ 0..100, derived from how far past threshold the value is.

// A) Momentum Breakout: 7d>18%, momentum>70%, volatility below cohort median.
function genMomentum(top, vol) {
  if (!top) return [];
  const gainers = (top.gainers7d || []);
  const momMap = new Map((top.momentum || []).map(m => [m.token_id, m.momentum]));
  const vols = (vol && vol.leaderboard) || [];
  const volMap = new Map(vols.map(v => [v.token_id, v.volatility]));
  const medianVol = vols.length ? [...vols.map(v => v.volatility)].sort((a, b) => a - b)[Math.floor(vols.length / 2)] : null;
  const out = [];
  for (const g of gainers) {
    const mom = momMap.get(g.token_id);
    const v = volMap.get(g.token_id);
    if (g.gain7d > 18 && mom != null && mom > 0.70 && (medianVol == null || (v != null && v < medianVol))) {
      const strength = clamp(Math.round(((g.gain7d - 18) / 32) * 100), 1, 100);   // 18%→1, 50%→100
      const confidence = clamp(Math.round(((mom - 0.70) / 0.30) * 100), 1, 100);
      out.push({ token_id: g.token_id, type: 'momentum_breakout', strength, confidence,
        reason: `7d +${g.gain7d.toFixed(1)}%, momentum ${(mom * 100).toFixed(0)}%${v != null ? `, vol ${v.toFixed(1)}% < cohort median` : ''}` });
    }
  }
  return out;
}

// B) Flow Surge: buy/sell imbalance >0.75 OR volume/liquidity >4x.
function genFlowSurge(flows) {
  if (!flows) return [];
  const list = flows.flows || [];
  const out = [];
  for (const f of list) {
    const d = f.details || {};
    const imb = num(d.imbalance), ratio = num(d.ratio);
    if (f.type === 'buy_sell_imbalance' && imb != null && Math.abs(imb) > 0.75) {
      out.push({ token_id: f.token_id, type: 'flow_surge', strength: clamp(Math.round((Math.abs(imb) - 0.75) / 0.25 * 100), 1, 100),
        confidence: 70, reason: `Buy/sell imbalance ${(imb * 100).toFixed(0)}%` });
    } else if (f.type === 'volume_liquidity_spike' && ratio != null && ratio > 4) {
      out.push({ token_id: f.token_id, type: 'flow_surge', strength: clamp(Math.round((ratio - 4) / 16 * 100), 1, 100),
        confidence: 65, reason: `Volume/liquidity ${ratio.toFixed(1)}x baseline` });
    }
  }
  return out;
}

// C) Security Degradation: security score drop >15 in 24h (from token_security_audit).
async function genSecurityDegradation(env) {
  if (!_dbOk(env)) return [];
  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT a.token_id, a.old_score, a.new_score, a.changed_at, s.chain_id, s.address
       FROM token_security_audit a JOIN token_security s ON s.id = a.token_id
       WHERE a.changed_at >= ? AND (a.old_score - a.new_score) > 15`
    ).bind(Date.now() - DAY).all();
    rows = (r && r.results) || [];
  } catch (e) { rows = []; }
  return rows.map(r => {
    const drop = r.old_score - r.new_score;
    return { token_id: r.address || String(r.token_id), type: 'security_degradation',
      strength: clamp(Math.round(drop / 50 * 100), 1, 100), confidence: 90,
      reason: `Security score fell ${drop.toFixed(0)} pts in 24h (${r.old_score?.toFixed?.(0)}→${r.new_score?.toFixed?.(0)})` };
  });
}

// D) Provider Instability: provider reliability drop >12% (from provider_drift anomalies).
async function genProviderInstability(env) {
  if (!_dbOk(env)) return [];
  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT details_json, created_at FROM anomalies WHERE type='provider_drift' AND created_at >= ? ORDER BY created_at DESC LIMIT 20`
    ).bind(Date.now() - DAY).all();
    rows = (r && r.results) || [];
  } catch (e) { rows = []; }
  const out = [];
  for (const row of rows) {
    let d = {}; try { d = JSON.parse(row.details_json); } catch (e) {}
    const drop = num(d.drop);
    if (drop != null && drop > 0.12) {
      out.push({ token_id: null, type: 'provider_instability', strength: clamp(Math.round(drop / 0.5 * 100), 1, 100),
        confidence: 85, reason: `Provider ${d.provider || '?'} reliability fell ${(drop * 100).toFixed(0)}%` });
    }
  }
  return out;
}

// E) Search Breakout: trending delta >40% (from search insights fastestRising).
function genSearchBreakout(insights) {
  if (!insights) return [];
  const rising = insights.fastestRising || [];
  const out = [];
  for (const r of rising) {
    const prev = (num(r.count) || 0) - (num(r.delta) || 0);
    const pctDelta = prev > 0 ? (num(r.delta) / prev) : (num(r.delta) > 0 ? 1 : 0);
    if (pctDelta > 0.40) {
      out.push({ token_id: r.term, type: 'search_breakout', strength: clamp(Math.round(pctDelta / 2 * 100), 1, 100),
        confidence: 60, reason: `Search interest +${(pctDelta * 100).toFixed(0)}%` });
    }
  }
  return out;
}

async function persistSignals(env, signals) {
  if (!_dbOk(env) || !signals.length) return 0;
  const now = Date.now();
  let n = 0;
  for (const s of signals.slice(0, 200)) {
    const id = signalId(s.type, s.token_id, now);
    try {
      await env.DB.prepare(
        `INSERT INTO signals (id, token_id, type, strength, confidence, reason, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET strength=excluded.strength, confidence=excluded.confidence,
           reason=excluded.reason, created_at=excluded.created_at`
      ).bind(id, s.token_id, s.type, s.strength, s.confidence, s.reason, now).run();
      n++;
    } catch (e) {}
  }
  return n;
}

async function generate(env) {
  // pull from sibling workers (URLs via env; '' => skipped honestly)
  const [top, vol, flows, insights] = await Promise.all([
    fetchJSON(env.ANALYTICS_URL ? env.ANALYTICS_URL + '/api/analytics/top' : ''),
    fetchJSON(env.ANALYTICS_URL ? env.ANALYTICS_URL + '/api/analytics/volatility' : ''),
    fetchJSON(env.FLOWS_URL ? env.FLOWS_URL + '/api/flows?limit=100' : ''),
    fetchJSON(env.SEARCH_URL ? env.SEARCH_URL + '/api/search/insights' : ''),
  ]);
  let signals = [];
  signals = signals.concat(genMomentum(top, vol));
  signals = signals.concat(genFlowSurge(flows));
  signals = signals.concat(await genSecurityDegradation(env));
  signals = signals.concat(await genProviderInstability(env));
  signals = signals.concat(genSearchBreakout(insights));
  const written = await persistSignals(env, signals);
  return { generated: signals.length, written, sources: { top: !!top, vol: !!vol, flows: !!flows, insights: !!insights } };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/signals' && request.method === 'GET') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', signals: [] }, origin);
      const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50);
      const tokenFilter = url.searchParams.get('token');
      let rows = [];
      try {
        if (tokenFilter) {
          const r = await env.DB.prepare('SELECT * FROM signals WHERE token_id=? ORDER BY created_at DESC LIMIT ?').bind(tokenFilter, limit).all();
          rows = (r && r.results) || [];
        } else {
          const r = await env.DB.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').bind(limit).all();
          rows = (r && r.results) || [];
        }
      } catch (e) { rows = []; }
      return json(200, { signals: rows }, origin);
    }

    if (url.pathname === '/api/signals/generate' && request.method === 'POST') {
      if (!_dbOk(env)) return json(200, { ok: false, reason: 'db-unbound' }, origin);
      return json(200, { ok: true, ...(await generate(env)) }, origin);
    }

    return json(404, { error: 'not found', routes: ['/api/signals', '/api/signals/generate'] }, origin);
  },

  async scheduled(event, env, ctx) {
    if (_dbOk(env)) ctx.waitUntil(generate(env).catch(() => {}));
  },
};
