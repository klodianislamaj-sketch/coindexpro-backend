// ============================================================================
// metrics-worker.js — CoinDex Pro Phase 3D
// Aggregates cross-system summary metrics from D1 + KV. All counts are real
// queries; missing systems report honestly (null / unavailable). Cached 120s.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
//
// Route:  GET /api/metrics
// ============================================================================

const CACHE_TTL = 120;
const METRICS_KEY = 'metrics:summary';
const TRENDING_KEY = 'search:trending';
const DAY = 86400000;

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function _kvOk(env) { return !!(env && env.CACHE && typeof env.CACHE.get === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }

async function d1count(env, sql, params = []) {
  if (!_dbOk(env)) return null;
  try { const r = await env.DB.prepare(sql).bind(...params).first(); return r ? (r.n ?? null) : null; }
  catch (e) { return null; }
}

async function computeMetrics(env) {
  // cache-first
  if (_kvOk(env)) {
    try { const c = await env.CACHE.get(METRICS_KEY); if (c) return JSON.parse(c); } catch (e) {}
  }
  const now = Date.now();
  const dayAgo = now - DAY;

  // total distinct tokens tracked (from candle store)
  const totalTokens = await d1count(env, 'SELECT COUNT(DISTINCT token_id) AS n FROM token_metrics_daily');
  // active anomalies in last 24h
  const activeAnomalies = await d1count(env, 'SELECT COUNT(*) AS n FROM anomalies WHERE created_at >= ?', [dayAgo]);
  // total historical candles
  const totalCandles = await d1count(env, 'SELECT COUNT(*) AS n FROM token_metrics_daily');
  // avg provider reliability
  let avgReliability = null;
  if (_dbOk(env)) {
    try { const r = await env.DB.prepare('SELECT AVG(reliability) AS a FROM provider_health').first(); avgReliability = r && r.a != null ? r.a : null; }
    catch (e) { avgReliability = null; }
  }
  // total indexed search terms (trending counters)
  let indexedSearchTerms = null;
  if (_kvOk(env)) {
    try { const raw = await env.CACHE.get(TRENDING_KEY); indexedSearchTerms = raw ? Object.keys(JSON.parse(raw)).length : 0; }
    catch (e) { indexedSearchTerms = null; }
  }

  const out = {
    generatedAt: now,
    dbBound: _dbOk(env), kvBound: _kvOk(env),
    totalTokensTracked: totalTokens,
    activeAnomalies24h: activeAnomalies,
    avgProviderReliability: avgReliability,
    indexedSearchTerms,
    totalHistoricalCandles: totalCandles,
  };
  if (_kvOk(env)) { try { await env.CACHE.put(METRICS_KEY, JSON.stringify(out), { expirationTtl: CACHE_TTL }); } catch (e) {} }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname === '/api/metrics' && request.method === 'GET')
      return json(200, await computeMetrics(env), origin);
    return json(404, { error: 'not found', routes: ['/api/metrics'] }, origin);
  },
};
