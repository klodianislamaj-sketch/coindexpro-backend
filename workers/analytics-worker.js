// ============================================================================
// analytics-worker.js — CoinDex Pro Phase 3C
// Computes analytics from token_metrics_daily (populated by the backfill worker).
// All numbers are derived from real stored candles — nothing fabricated. Results
// cached in KV for 300s.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
//
// Routes:
//   GET /api/analytics/top         -> 7d / 30d gainers + momentum persistence
//   GET /api/analytics/volatility  -> volatility leaderboard
//   GET /api/analytics/breadth     -> sector breadth (if sector in snapshot)
// ============================================================================

const DAY = 86400000;
const CACHE_TTL = 300;
const SNAP_KEY = 'screener:snapshot';

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function _kvOk(env) { return !!(env && env.CACHE && typeof env.CACHE.get === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }

async function cacheGet(env, key) { if (!_kvOk(env)) return null; try { const r = await env.CACHE.get(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
async function cachePut(env, key, val) { if (!_kvOk(env)) return; try { await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: CACHE_TTL }); } catch (e) {} }

// Pull all candles for all tokens, grouped by token_id, ascending by ts.
async function loadSeries(env) {
  if (!_dbOk(env)) return {};
  let rows = [];
  try {
    const r = await env.DB.prepare(
      'SELECT token_id, ts, open, high, low, close, volume FROM token_metrics_daily ORDER BY token_id, ts'
    ).all();
    rows = (r && r.results) || [];
  } catch (e) { return {}; }
  const series = {};
  for (const row of rows) { (series[row.token_id] = series[row.token_id] || []).push(row); }
  return series;
}

// return close N days back from the latest candle (or null if insufficient history)
function closeNDaysAgo(candles, n) {
  if (!candles.length) return null;
  const last = candles[candles.length - 1];
  const targetTs = last.ts - n * DAY;
  // nearest candle at or before targetTs
  let pick = null;
  for (const c of candles) { if (c.ts <= targetTs) pick = c; else break; }
  return pick ? pick.close : null;
}
function pctChange(from, to) { return (from && from > 0 && to != null) ? (to / from - 1) * 100 : null; }

// daily log-return stdev → annualized-ish volatility (kept as raw % stdev, honest).
function volatility(candles) {
  if (candles.length < 3) return null;
  const rets = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1].close, b = candles[i].close;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const varr = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * 100; // daily % stdev
}

// momentum persistence: fraction of last 14 days where close > prior close (0..1).
function momentumPersistence(candles) {
  const tail = candles.slice(-15);
  if (tail.length < 5) return null;
  let up = 0, n = 0;
  for (let i = 1; i < tail.length; i++) { n++; if (tail[i].close > tail[i - 1].close) up++; }
  return n ? up / n : null;
}

async function computeTop(env) {
  const cached = await cacheGet(env, 'analytics:top'); if (cached) return cached;
  const series = await loadSeries(env);
  const ids = Object.keys(series);
  const rows = ids.map(id => {
    const c = series[id];
    const last = c[c.length - 1];
    return {
      token_id: id,
      gain7d: pctChange(closeNDaysAgo(c, 7), last ? last.close : null),
      gain30d: pctChange(closeNDaysAgo(c, 30), last ? last.close : null),
      momentum: momentumPersistence(c),
      samples: c.length,
    };
  });
  const g7 = rows.filter(r => r.gain7d != null).sort((a, b) => b.gain7d - a.gain7d).slice(0, 20);
  const g30 = rows.filter(r => r.gain30d != null).sort((a, b) => b.gain30d - a.gain30d).slice(0, 20);
  const mom = rows.filter(r => r.momentum != null).sort((a, b) => b.momentum - a.momentum).slice(0, 20);
  const out = { gainers7d: g7, gainers30d: g30, momentum: mom, tokenCount: ids.length, available: ids.length > 0 };
  await cachePut(env, 'analytics:top', out);
  return out;
}

async function computeVolatility(env) {
  const cached = await cacheGet(env, 'analytics:volatility'); if (cached) return cached;
  const series = await loadSeries(env);
  const rows = Object.keys(series).map(id => ({ token_id: id, volatility: volatility(series[id]), samples: series[id].length }))
    .filter(r => r.volatility != null).sort((a, b) => b.volatility - a.volatility).slice(0, 25);
  const out = { leaderboard: rows, available: rows.length > 0 };
  await cachePut(env, 'analytics:volatility', out);
  return out;
}

// sector breadth: requires a sector field in the screener snapshot. If absent →
// honest "unavailable", never invented.
async function computeBreadth(env) {
  const cached = await cacheGet(env, 'analytics:breadth'); if (cached) return cached;
  let snap = null;
  if (_kvOk(env)) { try { const r = await env.CACHE.get(SNAP_KEY); if (r) snap = JSON.parse(r); } catch (e) {} }
  const list = Array.isArray(snap) ? snap : (snap && snap.data) || null;
  if (!list || !list.length || !list.some(t => t.sector)) {
    const out = { available: false, reason: 'no sector data in snapshot', sectors: [] };
    return out; // not cached — cheap, and snapshot may gain sectors later
  }
  // breadth = within each sector, share of tokens up over 24h (real snapshot field).
  const bySector = {};
  for (const t of list) {
    const sec = t.sector || 'unknown';
    const chg = typeof t.price_change_percentage_24h === 'number' ? t.price_change_percentage_24h
      : parseFloat(t.change24h);
    if (!isFinite(chg)) continue;
    (bySector[sec] = bySector[sec] || { up: 0, total: 0 }).total++;
    if (chg > 0) bySector[sec].up++;
  }
  const sectors = Object.entries(bySector).map(([sector, v]) => ({
    sector, breadth: v.total ? v.up / v.total : null, advancers: v.up, total: v.total
  })).sort((a, b) => (b.breadth || 0) - (a.breadth || 0));
  const out = { available: true, sectors };
  await cachePut(env, 'analytics:breadth', out);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (!_dbOk(env) && url.pathname.startsWith('/api/analytics')) {
      return json(200, { available: false, reason: 'db-unbound' }, origin);
    }
    if (url.pathname === '/api/analytics/top') return json(200, await computeTop(env), origin);
    if (url.pathname === '/api/analytics/volatility') return json(200, await computeVolatility(env), origin);
    if (url.pathname === '/api/analytics/breadth') return json(200, await computeBreadth(env), origin);
    return json(404, { error: 'not found', routes: ['/api/analytics/top', '/api/analytics/volatility', '/api/analytics/breadth'] }, origin);
  },
};
