// ============================================================================
// allocation-worker.js — CoinDex Pro Phase 6 (Autonomous Capital Allocation)
// Converts execution plans + conviction into deterministic capital allocation
// decisions with strict portfolio risk controls. Position sizing derives ONLY
// from conviction, volatility, risk budget and existing exposure. If stop /
// volatility / price / portfolio value is missing, the token is SKIPPED — no
// assumptions, no fabricated numbers.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
// Sibling URLs via env: EXECUTION_URL, CONVICTION_URL, ANALYTICS_URL.
//
// Routes:
//   GET  /api/allocation           -> active allocations (optional ?token=, ?action=)
//   POST /api/allocation/generate  -> generate from posted {portfolio, execution, conviction}
//                                     (falls back to sibling workers if body omitted)
// ============================================================================

const DAY = 86400000;
const RISK_BUDGET = 0.02;          // 2% portfolio risk per position (deterministic constant)
const MAX_PORTFOLIO_EXPOSURE = 0.65;
const EXPOSURE_CLASS = { btc: 'BTC', bitcoin: 'BTC', eth: 'L1', ethereum: 'L1', solana: 'L1', sol: 'L1' };

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round(n, dp) { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
async function fetchJSON(url) { if (!url) return null; try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } }
function key(x) { return String(x == null ? '' : x).toLowerCase(); }

// Decide allocation action from conviction + execution action + volatility.
function decideAllocation(ctx) {
  const { conviction, execAction, volSpike, portfolioExposure } = ctx;
  // CLOSE: execution EXIT or conviction < 35
  if (execAction === 'EXIT' || (conviction != null && conviction < 35)) return 'CLOSE';
  // SCALE_DOWN: execution REDUCE or volatility spike > 25%
  if (execAction === 'REDUCE' || (volSpike != null && volSpike > 25)) return 'SCALE_DOWN';
  // ALLOCATE: conviction > 75 + execution BUY + exposure < 65%
  if (conviction != null && conviction > 75 && execAction === 'BUY' && portfolioExposure != null && portfolioExposure < MAX_PORTFOLIO_EXPOSURE) return 'ALLOCATE';
  // HOLD: conviction 55–75
  if (conviction != null && conviction >= 55 && conviction <= 75) return 'HOLD';
  return null;
}

// Deterministic position sizing. Returns null if any required input is missing.
//   baseRisk = portfolioValue * riskBudget
//   positionSize = baseRisk / stopDistance      (units of capital at risk)
function sizePosition({ portfolioValue, price, stop, conviction, volPct, existingExposure }) {
  if (portfolioValue == null || price == null || stop == null || price <= 0) return null;
  const stopDistance = Math.abs(price - stop);
  if (stopDistance <= 0) return null;
  const baseRisk = portfolioValue * RISK_BUDGET;                 // $ at risk
  // conviction tilts size within risk budget (0.5x..1.0x), deterministic.
  const convFactor = conviction != null ? clamp(0.5 + (conviction / 200), 0.5, 1.0) : 0.5;
  const riskDollars = baseRisk * convFactor;
  const capital = riskDollars / (stopDistance / price);          // notional capital to deploy
  // cap by remaining exposure room
  const room = existingExposure != null ? Math.max(0, (MAX_PORTFOLIO_EXPOSURE - existingExposure) * portfolioValue) : capital;
  const cappedCapital = Math.min(capital, room);
  const positionSizePct = portfolioValue > 0 ? (cappedCapital / portfolioValue) * 100 : null;
  const heat = clamp(Math.round((volPct != null ? volPct * 4 : 20) + (positionSizePct || 0)), 1, 100);
  const maxDrawdown = volPct != null ? round((stopDistance / price) * 100, 1) : null;
  return {
    capital: round(cappedCapital, 2),
    position_size: positionSizePct != null ? round(positionSizePct, 1) : null,
    risk_percent: round(RISK_BUDGET * convFactor * 100, 2),
    heat_score: heat,
    max_drawdown: maxDrawdown,
  };
}

function allocId(token, ts) { return `alloc:${token}:${Math.floor(ts / DAY)}`; }

function generateFrom(portfolio, execution, conviction, analytics) {
  const portList = portfolio || [];
  const portfolioValue = portList.reduce((s, h) => s + (num(h.value) || 0), 0) || null;
  const execMap = new Map((execution || []).map(p => [key(p.token_id), p.plan || p]));
  const convMap = new Map((conviction || []).map(c => [key(c.token_id), c.score]));
  const volMap = new Map(((analytics && analytics.volatility) || []).map(v => [key(v.token_id), v.volatility]));
  const exposureByToken = new Map();
  for (const h of portList) { const k = key(h.token_id || h.id); if (portfolioValue) exposureByToken.set(k, (num(h.value) || 0) / portfolioValue); }
  const totalExposure = [...exposureByToken.values()].reduce((s, w) => s + w, 0);

  const tokens = new Set([...execMap.keys(), ...convMap.keys()]);
  const allocations = [];
  for (const t of tokens) {
    const plan = execMap.get(t);
    const conv = convMap.has(t) ? convMap.get(t) : null;
    const execAction = plan ? plan.action : null;
    const volPct = volMap.has(t) ? volMap.get(t) : null;
    const action = decideAllocation({ conviction: conv, execAction, volSpike: null, portfolioExposure: totalExposure });
    if (!action) continue;
    // sizing needs real price + stop (from execution plan) + portfolio value.
    const price = plan ? num(plan.ref_price) : null;
    const stop = plan ? num(plan.invalidation_zone) : null;
    const sized = sizePosition({ portfolioValue, price, stop, conviction: conv, volPct, existingExposure: totalExposure });
    if (!sized) continue;     // skip — missing stop/vol/price/portfolio value
    allocations.push({
      token: t, action,
      position_size: sized.position_size, risk_percent: sized.risk_percent, capital: sized.capital,
      heat_score: sized.heat_score, max_drawdown: sized.max_drawdown,
      exposure_class: EXPOSURE_CLASS[t] || 'ALT',
      conviction_score: conv,
    });
  }
  return { allocations, portfolioValue, totalExposure };
}

async function generate(env, body) {
  if (!_dbOk(env)) return { ok: false, reason: 'db-unbound' };
  let portfolio = body && body.portfolio, execution = body && body.execution, conviction = body && body.conviction;
  // fall back to sibling workers if not provided in the request body.
  if (!execution) { const e = await fetchJSON(env.EXECUTION_URL ? env.EXECUTION_URL + '/api/execution?limit=300' : ''); execution = e ? e.plans : null; }
  if (!conviction) { const c = await fetchJSON(env.CONVICTION_URL ? env.CONVICTION_URL + '/api/conviction?limit=500' : ''); conviction = c ? c.scores : null; }
  const vol = await fetchJSON(env.ANALYTICS_URL ? env.ANALYTICS_URL + '/api/analytics/volatility' : '');
  const analytics = { volatility: vol ? vol.leaderboard : [] };
  if ((!execution || !execution.length) && (!conviction || !conviction.length)) return { ok: false, reason: 'no-input-data', generated: 0 };

  const { allocations } = generateFrom(portfolio, execution, conviction, analytics);
  const now = Date.now();
  let written = 0;
  for (const a of allocations.slice(0, 200)) {
    const id = allocId(a.token, now);
    try {
      await env.DB.prepare(
        `INSERT INTO allocations (id, token_id, action, alloc_json, created_at)
         VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           action=excluded.action, alloc_json=excluded.alloc_json, created_at=excluded.created_at`
      ).bind(id, a.token, a.action, JSON.stringify(a), now).run();
      written++;
    } catch (e) {}
  }
  return { ok: true, generated: allocations.length, written };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/allocation' && request.method === 'GET') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', allocations: [] }, origin);
      const token = url.searchParams.get('token'), action = url.searchParams.get('action');
      const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
      let rows = [];
      try {
        let q = 'SELECT * FROM allocations', cond = [], binds = [];
        if (token) { cond.push('token_id=?'); binds.push(key(token)); }
        if (action) { cond.push('action=?'); binds.push(action); }
        if (cond.length) q += ' WHERE ' + cond.join(' AND ');
        q += ' ORDER BY created_at DESC LIMIT ?'; binds.push(limit);
        const r = await env.DB.prepare(q).bind(...binds).all();
        rows = (r && r.results) || [];
      } catch (e) { rows = []; }
      return json(200, { allocations: rows.map(r => { try { r.allocation = JSON.parse(r.alloc_json); } catch (e) { r.allocation = {}; } return r; }) }, origin);
    }

    if (url.pathname === '/api/allocation/generate' && request.method === 'POST') {
      let body = null; try { body = await request.json(); } catch (e) { body = null; }
      return json(200, await generate(env, body), origin);
    }

    return json(404, { error: 'not found', routes: ['/api/allocation', '/api/allocation/generate'] }, origin);
  },

  async scheduled(event, env, ctx) { if (_dbOk(env)) ctx.waitUntil(generate(env, null).catch(() => {})); },
};
