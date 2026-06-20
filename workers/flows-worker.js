// ============================================================================
// flows-worker.js — CoinDex Pro Phase 3C
// Detects whale/flow anomalies from the screener snapshot in KV and persists
// them into the existing anomalies table with details.subtype = "flow".
// Real signals only (derived from snapshot fields); honest empty when no data.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
//
// Routes:  GET /api/flows  -> recent flow anomalies
// Cron:    every 2 minutes -> scan snapshot, log new flow anomalies
// ============================================================================

const SNAP_KEY = 'screener:snapshot';
const PREV_KEY = 'flows:prev';      // previous snapshot metrics for delta detection

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function _kvOk(env) { return !!(env && env.CACHE && typeof env.CACHE.get === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }

async function getSnapshot(env) {
  if (!_kvOk(env)) return null;
  try { const r = await env.CACHE.get(SNAP_KEY); if (!r) return null; const p = JSON.parse(r); return Array.isArray(p) ? p : (p.data || null); }
  catch (e) { return null; }
}
async function getPrev(env) { if (!_kvOk(env)) return {}; try { const r = await env.CACHE.get(PREV_KEY); return r ? JSON.parse(r) : {}; } catch (e) { return {}; } }
async function setPrev(env, map) { if (!_kvOk(env)) return; try { await env.CACHE.put(PREV_KEY, JSON.stringify(map), { expirationTtl: 1800 }); } catch (e) {} }

// Detect flow anomalies for one snapshot tick vs the previous tick.
function detectFlows(list, prev) {
  const flows = [];
  const nextPrev = {};
  for (const t of (list || [])) {
    if (!t || typeof t !== 'object') continue;
    const id = t.id || t.symbol || t.contract_address; if (!id) continue;
    const vol = num(t.total_volume ?? t.volume);
    const liq = num(t.liquidity);
    const buy = num(t.buy_volume ?? t.buys);
    const sell = num(t.sell_volume ?? t.sells);
    nextPrev[id] = { liq, vol };

    // 1) abnormal buy/sell imbalance (needs both sides present)
    if (buy != null && sell != null && (buy + sell) > 0) {
      const imb = (buy - sell) / (buy + sell);   // -1..1
      if (Math.abs(imb) >= 0.7) flows.push({ id, type: 'buy_sell_imbalance', sev: 'warn', d: { imbalance: +imb.toFixed(3), buy, sell } });
    }
    // 2) volume > liquidity ratio spike
    if (vol != null && liq != null && liq > 0 && vol / liq > 5) {
      flows.push({ id, type: 'volume_liquidity_spike', sev: 'warn', d: { ratio: +(vol / liq).toFixed(2), vol, liq } });
    }
    // 3) sudden liquidity addition/removal vs previous tick
    const p = prev[id];
    if (p && p.liq != null && liq != null && p.liq > 0) {
      const change = (liq - p.liq) / p.liq;
      if (Math.abs(change) >= 0.3) {
        flows.push({ id, type: change > 0 ? 'liquidity_addition' : 'liquidity_removal', sev: Math.abs(change) >= 0.6 ? 'critical' : 'warn', d: { change: +(change * 100).toFixed(1) + '%', from: p.liq, to: liq } });
      }
    }
  }
  return { flows, nextPrev };
}

async function persistFlows(env, flows) {
  if (!_dbOk(env) || !flows.length) return 0;
  const now = Date.now();
  let written = 0;
  for (const f of flows.slice(0, 100)) {
    const details = JSON.stringify(Object.assign({ subtype: 'flow' }, f.d));
    try {
      await env.DB.prepare('INSERT INTO anomalies (token_id, type, severity, details_json, created_at) VALUES (?,?,?,?,?)')
        .bind(String(f.id), f.type, f.sev, details, now).run();
      written++;
    } catch (e) {}
  }
  return written;
}

async function scan(env) {
  const list = await getSnapshot(env);
  if (!list) return { ok: false, reason: 'no-snapshot', detected: 0 };
  const prev = await getPrev(env);
  const { flows, nextPrev } = detectFlows(list, prev);
  const written = await persistFlows(env, flows);
  await setPrev(env, nextPrev);
  return { ok: true, scanned: list.length, detected: flows.length, written };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/flows' && request.method === 'GET') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', flows: [] }, origin);
      const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50);
      let rows = [];
      try {
        const r = await env.DB.prepare(
          "SELECT id, token_id, type, severity, details_json, created_at FROM anomalies WHERE details_json LIKE '%\"subtype\":\"flow\"%' ORDER BY created_at DESC LIMIT ?"
        ).bind(limit).all();
        rows = (r && r.results) || [];
      } catch (e) { rows = []; }
      return json(200, { flows: rows.map(r => { try { r.details = JSON.parse(r.details_json); } catch (e) { r.details = {}; } return r; }) }, origin);
    }

    // Manual trigger (handy for testing): POST /api/flows/scan
    if (url.pathname === '/api/flows/scan' && request.method === 'POST') {
      return json(200, await scan(env), origin);
    }

    return json(404, { error: 'not found', routes: ['/api/flows', '/api/flows/scan'] }, origin);
  },

  // Cron: scan every 2 minutes (wire crons = ["*/2 * * * *"] in wrangler).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scan(env).catch(() => {}));
  },
};
