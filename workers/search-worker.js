// ============================================================================
// search-worker.js — CoinDex Pro Phase 3B
// Token search over a KV-cached index rebuilt from the screener snapshot every
// 10 minutes. Cache-first; D1 fallback only when the KV index is missing/empty.
//
// Ranking priority: exact symbol > address > exact name > prefix > fuzzy(typo).
// Liquidity is the tie-breaker within a rank tier.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV). Env: ADMIN_KEY (for rebuild).
//
// Routes:
//   GET  /api/search?q=...        -> ranked results
//   POST /api/search/rebuild      -> rebuild KV index (ADMIN_KEY protected)
// ============================================================================

const INDEX_KEY = 'search:index';
const INDEX_TTL = 600;            // 10 minutes
const SCREENER_SNAPSHOT_KEY = 'screener:snapshot';   // produced by the app/ingest
const MAX_RESULTS = 25;
const TRENDING_KEY = 'search:trending';   // { term: count }
const TRENDING_PREV_KEY = 'search:trending:prev';   // snapshot before last decay
const TRENDING_DEAD_KEY = 'search:trending:dead';   // terms decayed below threshold
const TRENDING_DECAY = 0.8;               // multiply all counts each rebuild
const TRENDING_MAX = 20;
const TRENDING_DEAD_FLOOR = 0.5;          // below this → considered dead

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function _kvOk(env) { return !!(env && env.CACHE && typeof env.CACHE.get === 'function'); }

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  };
}
function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ---- index build/load ------------------------------------------------------
// An index entry: { id, symbol, name, address, liquidity }.
function normalizeEntry(t) {
  return {
    id: t.id || t.cg_id || t.symbol || null,
    symbol: String(t.symbol || '').toLowerCase(),
    name: String(t.name || '').toLowerCase(),
    address: String(t.address || t.contract_address || '').toLowerCase(),
    liquidity: num(t.liquidity ?? t.total_volume ?? t.market_cap) || 0,
    // keep display-cased fields
    _symbol: t.symbol || '', _name: t.name || '', _address: t.address || t.contract_address || '',
  };
}

async function buildIndexFromSnapshot(env) {
  // Source 1: screener snapshot in KV (preferred, freshest).
  let list = null;
  if (_kvOk(env)) {
    try {
      const raw = await env.CACHE.get(SCREENER_SNAPSHOT_KEY);
      if (raw) { const parsed = JSON.parse(raw); list = Array.isArray(parsed) ? parsed : (parsed.data || null); }
    } catch (e) { list = null; }
  }
  // Source 2 (fallback): D1 token_security gives us at least addresses/chains.
  if ((!list || !list.length) && _dbOk(env)) {
    try {
      const r = await env.DB.prepare('SELECT address, chain_id FROM token_security LIMIT 5000').all();
      list = (r && r.results) ? r.results.map(row => ({ address: row.address, symbol: '', name: '' })) : [];
    } catch (e) { list = []; }
  }
  if (!list) list = [];
  const index = list.map(normalizeEntry).filter(e => e.symbol || e.name || e.address);
  return index;
}

async function saveIndex(env, index) {
  if (!_kvOk(env)) return false;
  try { await env.CACHE.put(INDEX_KEY, JSON.stringify({ ts: Date.now(), index }), { expirationTtl: INDEX_TTL }); return true; }
  catch (e) { return false; }
}
async function loadIndex(env) {
  if (_kvOk(env)) {
    try { const raw = await env.CACHE.get(INDEX_KEY); if (raw) { const o = JSON.parse(raw); if (o && Array.isArray(o.index) && o.index.length) return o.index; } }
    catch (e) { /* fall through to rebuild */ }
  }
  // KV empty/missing → rebuild from snapshot/D1 (the D1 fallback path).
  const fresh = await buildIndexFromSnapshot(env);
  if (fresh.length) await saveIndex(env, fresh);
  return fresh;
}

// ---- ranking ---------------------------------------------------------------
// Lower rank number = better tier. Ties broken by higher liquidity.
function rankEntry(e, q) {
  if (e.symbol && e.symbol === q) return 0;                 // exact symbol
  if (e.address && e.address === q) return 1;               // exact address
  if (e.name && e.name === q) return 2;                     // exact name
  if ((e.symbol && e.symbol.startsWith(q)) || (e.name && e.name.startsWith(q))) return 3;  // prefix
  // fuzzy: small edit distance on symbol or name
  const ds = e.symbol ? levenshtein(e.symbol, q) : 99;
  const dn = e.name ? levenshteinCapped(e.name, q) : 99;
  const d = Math.min(ds, dn);
  if (d <= fuzzyThreshold(q)) return 4 + d * 0.01;          // fuzzy tier, closer = better
  // substring (weak) — still better than nothing
  if ((e.symbol && e.symbol.includes(q)) || (e.name && e.name.includes(q))) return 6;
  return Infinity;                                          // no match
}
function fuzzyThreshold(q) { return q.length <= 4 ? 1 : 2; }  // typo tolerance scales with length

function search(index, qRaw) {
  const q = String(qRaw || '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const e of index) {
    const r = rankEntry(e, q);
    if (r !== Infinity) scored.push({ e, r });
  }
  scored.sort((a, b) => (a.r - b.r) || (b.e.liquidity - a.e.liquidity));  // liquidity tie-breaker
  return scored.slice(0, MAX_RESULTS).map(({ e, r }) => ({
    id: e.id, symbol: e._symbol, name: e._name, address: e._address,
    liquidity: e.liquidity, matchTier: tierName(r),
  }));
}
function tierName(r) {
  if (r === 0) return 'exact-symbol'; if (r === 1) return 'exact-address';
  if (r === 2) return 'exact-name'; if (r === 3) return 'prefix';
  if (r >= 4 && r < 6) return 'fuzzy'; return 'substring';
}

// ---- Levenshtein (with a cheap cap for long names) -------------------------
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1); for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
// For long names, compare against the best-aligned window so "bitcon" still
// fuzzy-matches "bitcoin" without paying full O(len) on a long name string.
function levenshteinCapped(name, q) {
  if (name.length <= q.length + 3) return levenshtein(name, q);
  let best = 99;
  for (let i = 0; i + q.length <= name.length; i++) {
    best = Math.min(best, levenshtein(name.slice(i, i + q.length + 1), q));
    if (best === 0) break;
  }
  return best;
}

function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }

// ---- trending searches (KV counter, decayed on rebuild) --------------------
async function bumpTrending(env, term) {
  if (!_kvOk(env) || !term) return;
  try {
    const raw = await env.CACHE.get(TRENDING_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[term] = (map[term] || 0) + 1;
    await env.CACHE.put(TRENDING_KEY, JSON.stringify(map));
  } catch (e) { /* best-effort */ }
}
async function decayTrending(env) {
  if (!_kvOk(env)) return;
  try {
    const raw = await env.CACHE.get(TRENDING_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    // snapshot current counts as "previous" before decaying (for rising detection)
    await env.CACHE.put(TRENDING_PREV_KEY, JSON.stringify(map));
    const out = {};
    const dead = await getDead(env);
    for (const [term, count] of Object.entries(map)) {
      const v = count * TRENDING_DECAY;
      if (v >= TRENDING_DEAD_FLOOR) out[term] = +v.toFixed(2);
      else if (!dead.includes(term)) dead.push(term);   // term decayed out → dead
    }
    await env.CACHE.put(TRENDING_KEY, JSON.stringify(out));
    await env.CACHE.put(TRENDING_DEAD_KEY, JSON.stringify(dead.slice(-50)));
  } catch (e) {}
}
async function getDead(env) {
  if (!_kvOk(env)) return [];
  try { const raw = await env.CACHE.get(TRENDING_DEAD_KEY); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}
async function getTrending(env) {
  if (!_kvOk(env)) return [];
  try {
    const raw = await env.CACHE.get(TRENDING_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw);
    return Object.entries(map).map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count).slice(0, TRENDING_MAX);
  } catch (e) { return []; }
}

// Search insights: top (7d), fastest-rising (current vs prev snapshot delta), dead.
async function getInsights(env) {
  if (!_kvOk(env)) return { available: false, reason: 'kv-unbound' };
  let cur = {}, prev = {}, dead = [];
  try { const r = await env.CACHE.get(TRENDING_KEY); cur = r ? JSON.parse(r) : {}; } catch (e) {}
  try { const r = await env.CACHE.get(TRENDING_PREV_KEY); prev = r ? JSON.parse(r) : {}; } catch (e) {}
  dead = await getDead(env);

  const top = Object.entries(cur).map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count).slice(0, TRENDING_MAX);

  // rising = largest positive (current - previous). New terms count their full value.
  const rising = Object.entries(cur).map(([term, count]) => ({ term, delta: +(count - (prev[term] || 0)).toFixed(2), count }))
    .filter(r => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, TRENDING_MAX);

  return { available: true, topSearches: top, fastestRising: rising, deadSearches: dead.slice(-TRENDING_MAX) };
}

// ---- handlers --------------------------------------------------------------
async function handleSearch(env, q, origin, ctx) {
  const index = await loadIndex(env);
  if (!index.length) return json(200, { q, results: [], available: false, reason: 'empty-index' }, origin);
  const results = search(index, q);
  // increment trending only on a successful hit (non-blocking).
  if (results.length && q && ctx && ctx.waitUntil) ctx.waitUntil(bumpTrending(env, String(q).trim().toLowerCase()));
  return json(200, { q, results, indexSize: index.length, kvBacked: _kvOk(env) }, origin);
}

async function handleRebuild(env, request, origin) {
  const key = request.headers.get('x-admin-key') || '';
  if (!env || !env.ADMIN_KEY || key !== env.ADMIN_KEY)
    return json(401, { error: 'unauthorized' }, origin);
  const index = await buildIndexFromSnapshot(env);
  const saved = await saveIndex(env, index);
  await decayTrending(env);   // decay trending counts on every rebuild
  return json(200, { ok: true, indexSize: index.length, saved }, origin);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/search' && request.method === 'GET')
      return await handleSearch(env, url.searchParams.get('q'), origin, ctx);

    if (url.pathname === '/api/search/trending' && request.method === 'GET')
      return json(200, { trending: await getTrending(env) }, origin);

    if (url.pathname === '/api/search/insights' && request.method === 'GET')
      return json(200, await getInsights(env), origin);

    if (url.pathname === '/api/search/rebuild' && request.method === 'POST')
      return await handleRebuild(env, request, origin);

    return json(404, { error: 'not found', routes: ['/api/search?q=', '/api/search/trending', '/api/search/insights', '/api/search/rebuild'] }, origin);
  },

  // Cron: rebuild the index every 10 minutes (wire the trigger in wrangler.search.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const index = await buildIndexFromSnapshot(env);
      if (index.length) await saveIndex(env, index);
      await decayTrending(env);
    })().catch(() => {}));
  },
};
