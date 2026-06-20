// ============================================================================
// backfill-worker.js — CoinDex Pro Phase 3B
// Pulls 90d daily OHLC from CoinGecko for all tokens with a cg_id and upserts
// into token_metrics_daily. Resumable via a KV cursor, processes 5 tokens/run,
// retry-safe and dedupe-safe (UNIQUE(token_id, ts) in schema).
//
// Bindings (shared with main worker): env.DB (D1), env.CACHE (KV).
// Env: BACKFILL_ENABLED ("true" to allow runs).
//
// Routes:
//   GET  /api/backfill/status  -> progress snapshot
//   POST /api/backfill/run     -> process the next chunk of 5 tokens
// ============================================================================

// Token universe to backfill: CoinGecko ids. Kept in sync with the app's CG_IDS.
// (Extend freely — the cursor walks this list in order.)
const CG_IDS = [
  'bitcoin', 'ethereum', 'solana', 'ripple', 'dogecoin', 'binancecoin', 'cardano',
  'avalanche-2', 'chainlink', 'polkadot', 'tron', 'polygon-ecosystem-token',
  'litecoin', 'shiba-inu', 'uniswap', 'cosmos', 'stellar', 'monero', 'aptos', 'arbitrum'
];

const CHUNK = 5;                 // tokens per run
const HISTORY_DAYS = 90;
const DAY = 86400000;
const CURSOR_KEY = 'cursor:backfill';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_DEMO_KEY = 'CG-ZVVrjRSx8dSxoymn89vzF6C2';

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

// ---- KV cursor (index into CG_IDS) -----------------------------------------
async function getCursor(env) {
  if (!_kvOk(env)) return { index: 0, processed: 0, lastRun: null, done: false };
  try {
    const raw = await env.CACHE.get(CURSOR_KEY);
    if (!raw) return { index: 0, processed: 0, lastRun: null, done: false };
    return JSON.parse(raw);
  } catch (e) { return { index: 0, processed: 0, lastRun: null, done: false }; }
}
async function setCursor(env, cur) {
  if (!_kvOk(env)) return false;
  try { await env.CACHE.put(CURSOR_KEY, JSON.stringify(cur)); return true; } catch (e) { return false; }
}

// ---- CoinGecko fetch with retry --------------------------------------------
async function fetchOHLC(cgId, retries = 2) {
  const url = `${CG_BASE}/coins/${cgId}/ohlc?vs_currency=usd&days=${HISTORY_DAYS}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'application/json', 'x-cg-demo-api-key': CG_DEMO_KEY } });
      if (resp.status === 429) { await sleep(800 * (attempt + 1)); continue; }   // backoff on rate limit
      if (!resp.ok) { if (attempt < retries) { await sleep(400); continue; } return { ok: false, error: 'http-' + resp.status }; }
      const data = await resp.json();
      if (!Array.isArray(data)) return { ok: false, error: 'bad-shape' };
      return { ok: true, data };
    } catch (e) {
      if (attempt < retries) { await sleep(400); continue; }
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  return { ok: false, error: 'exhausted-retries' };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// CoinGecko /ohlc returns [ts_ms, open, high, low, close] (no volume). We bucket
// to UTC-midnight days and upsert. volume stays null (honest — this endpoint has none).
function toDailyCandles(ohlc) {
  const byDay = new Map();
  for (const row of ohlc) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [ts, o, h, l, c] = row;
    const day = Math.floor(ts / DAY) * DAY;
    // last candle of the day wins for close; track high/low/open across the day
    const cur = byDay.get(day);
    if (!cur) byDay.set(day, { ts: day, open: o, high: h, low: l, close: c });
    else { cur.high = Math.max(cur.high, h); cur.low = Math.min(cur.low, l); cur.close = c; }
  }
  return [...byDay.values()].sort((a, b) => a.ts - b.ts);
}

// Dedupe-safe upsert via INSERT ... ON CONFLICT(token_id, ts) DO UPDATE.
async function upsertCandles(env, tokenId, candles) {
  if (!_dbOk(env) || !candles.length) return 0;
  const stmts = candles.map(c => env.DB.prepare(
    `INSERT INTO token_metrics_daily (token_id, ts, open, high, low, close, volume)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(token_id, ts) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, volume=excluded.volume`
  ).bind(tokenId, c.ts, c.open, c.high, c.low, c.close, c.volume ?? null));
  try { await env.DB.batch(stmts); return candles.length; } catch (e) { return 0; }
}

// ---- handlers --------------------------------------------------------------
async function handleStatus(env, origin) {
  const cur = await getCursor(env);
  const total = CG_IDS.length;
  let rowCount = null;
  if (_dbOk(env)) {
    try { const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM token_metrics_daily').first(); rowCount = r ? r.n : null; }
    catch (e) { rowCount = null; }
  }
  return json(200, {
    enabled: String(env && env.BACKFILL_ENABLED) === 'true',
    dbBound: _dbOk(env), kvBound: _kvOk(env),
    totalTokens: total,
    processedTokens: Math.min(cur.index, total),
    remaining: Math.max(0, total - cur.index),
    done: cur.index >= total,
    candleRows: rowCount,
    lastRun: cur.lastRun || null,
  }, origin);
}

async function handleRun(env, origin) {
  if (String(env && env.BACKFILL_ENABLED) !== 'true')
    return json(200, { ok: false, reason: 'BACKFILL_ENABLED=false' }, origin);
  if (!_dbOk(env)) return json(200, { ok: false, reason: 'db-unbound' }, origin);

  let cur = await getCursor(env);
  if (cur.index >= CG_IDS.length) {
    // wrap-around: allow re-runs to refresh from the top
    cur = { index: 0, processed: cur.processed || 0, lastRun: cur.lastRun, done: false };
  }
  const slice = CG_IDS.slice(cur.index, cur.index + CHUNK);
  const results = [];
  for (const cgId of slice) {
    const res = await fetchOHLC(cgId);
    if (!res.ok) { results.push({ cgId, ok: false, error: res.error }); continue; }
    const candles = toDailyCandles(res.data);
    const n = await upsertCandles(env, cgId, candles);
    results.push({ cgId, ok: true, candles: n });
  }
  const newIndex = cur.index + slice.length;
  const next = { index: newIndex, processed: (cur.processed || 0) + slice.length, lastRun: Date.now(), done: newIndex >= CG_IDS.length };
  await setCursor(env, next);
  return json(200, { ok: true, processed: slice, results, cursor: next }, origin);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/backfill/status' && request.method === 'GET')
      return await handleStatus(env, origin);

    if (url.pathname === '/api/backfill/run' && request.method === 'POST')
      return await handleRun(env, origin);

    return json(404, { error: 'not found', routes: ['/api/backfill/status', '/api/backfill/run'] }, origin);
  },

  // Optional cron entrypoint: wire a Cron Trigger in wrangler.backfill.toml to
  // call this on a schedule. Safe to leave unused.
  async scheduled(event, env, ctx) {
    if (String(env && env.BACKFILL_ENABLED) === 'true' && _dbOk(env)) {
      ctx.waitUntil(handleRun(env, '').catch(() => {}));
    }
  },
};
