// ============================================================================
// execution-worker.js — CoinDex Pro Phase 5C (Autonomous Execution Layer)
// Converts Signals + Conviction into deterministic, executable trade plans.
// Targets/invalidation derive strictly from REAL recent volatility + momentum
// (from analytics) and a reference price (from analytics movers). No fabricated
// numbers: if price/volatility is unavailable for a token, that token is skipped.
//
// Bindings (shared): env.DB (D1), env.CACHE (KV).
// Sibling URLs via env: SIGNALS_URL, CONVICTION_URL, ANALYTICS_URL.
//
// Routes:
//   GET  /api/execution           -> stored plans (optional ?token=, ?action=)
//   POST /api/execution/generate  -> regenerate + persist
// Cron: regenerate on schedule.
// ============================================================================

const DAY = 86400000;

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round(n, dp) { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
async function fetchJSON(url) { if (!url) return null; try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } }
function key(x) { return String(x == null ? '' : x).toLowerCase(); }

// price decimal precision based on magnitude (so sub-cent tokens keep precision).
function dp(price) { return price >= 100 ? 2 : price >= 1 ? 4 : price >= 0.01 ? 6 : 8; }

// Build a plan's numeric levels from a reference price, daily volatility (σ%),
// and momentum persistence (0..1). All multipliers are fixed + deterministic.
function buildLevels(price, volPct, action) {
  if (price == null || price <= 0 || volPct == null) return null;
  const sigma = volPct / 100;                       // daily stdev as fraction
  const d = dp(price);
  // entry zone: ±0.5σ around price; invalidation: 1.5σ below entry low.
  const entryLow = price * (1 - 0.5 * sigma);
  const entryHigh = price * (1 + 0.5 * sigma);
  const invalidation = entryLow * (1 - 1.5 * sigma);
  // targets scale with volatility (2σ, 3.5σ above entry high).
  const t1 = entryHigh * (1 + 2.0 * sigma);
  const t2 = entryHigh * (1 + 3.5 * sigma);
  const entryMid = (entryLow + entryHigh) / 2;
  const risk = entryMid - invalidation;
  const reward = t1 - entryMid;
  const rr = risk > 0 ? round(reward / risk, 2) : null;
  return {
    entry_zone: [round(entryLow, d), round(entryHigh, d)],
    invalidation_zone: round(invalidation, d),
    target_1: round(t1, d),
    target_2: round(t2, d),
    risk_reward: rr,
    ref_price: round(price, d),
  };
}

// Decide action from conviction + signals + threat, per spec.
function decideAction(ctx) {
  const { conviction, convDelta, sigTypes, threatCritical } = ctx;
  const has = t => sigTypes.has(t);
  // EXIT: security degradation OR conviction <35 OR threat critical
  if (has('security_degradation') || (conviction != null && conviction < 35) || threatCritical) return 'EXIT';
  // BUY: conviction >75 + strong momentum + no security degradation
  if (conviction != null && conviction > 75 && has('momentum_breakout')) return 'BUY';
  // REDUCE: conviction falling >15 + (provider instability OR weakening momentum)
  if (convDelta != null && convDelta < -15 && (has('provider_instability') || !has('momentum_breakout'))) return 'REDUCE';
  // WATCH: conviction 55–75 + (search breakout OR flow surge)
  if (conviction != null && conviction >= 55 && conviction <= 75 && (has('search_breakout') || has('flow_surge'))) return 'WATCH';
  return null;   // no actionable plan
}

function planId(action, tokenId, ts) { return `${action}:${tokenId}:${Math.floor(ts / DAY)}`; }

async function generate(env) {
  if (!_dbOk(env)) return { ok: false, reason: 'db-unbound' };
  const [signals, conviction, top, vol] = await Promise.all([
    fetchJSON(env.SIGNALS_URL ? env.SIGNALS_URL + '/api/signals?limit=300' : ''),
    fetchJSON(env.CONVICTION_URL ? env.CONVICTION_URL + '/api/conviction?limit=500' : ''),
    fetchJSON(env.ANALYTICS_URL ? env.ANALYTICS_URL + '/api/analytics/top' : ''),
    fetchJSON(env.ANALYTICS_URL ? env.ANALYTICS_URL + '/api/analytics/volatility' : ''),
  ]);

  // index signals by token
  const sigByToken = new Map();
  for (const s of ((signals && signals.signals) || [])) {
    const k = key(s.token_id); if (!k) continue;
    if (!sigByToken.has(k)) sigByToken.set(k, []);
    sigByToken.get(k).push(s);
  }
  // conviction (current) + previous snapshot for delta from KV
  const convMap = new Map(((conviction && conviction.scores) || []).map(s => [key(s.token_id), s.score]));
  // volatility + reference price (use 7d gainer price proxy if present; else skip)
  const volMap = new Map(((vol && vol.leaderboard) || []).map(v => [key(v.token_id), v.volatility]));
  const priceMap = new Map();
  for (const g of ((top && top.gainers7d) || [])) if (g.ref_price != null || g.price != null) priceMap.set(key(g.token_id), num(g.ref_price ?? g.price));

  // conviction delta vs KV snapshot
  let prevConv = {};
  if (env.CACHE && typeof env.CACHE.get === 'function') { try { const raw = await env.CACHE.get('exec:convsnap'); if (raw) prevConv = JSON.parse(raw); } catch (e) {} }

  const now = Date.now();
  const tokens = new Set([...sigByToken.keys(), ...convMap.keys()]);
  const plans = [];
  for (const t of tokens) {
    const sigs = sigByToken.get(t) || [];
    const sigTypes = new Set(sigs.map(s => s.type));
    const conv = convMap.has(t) ? convMap.get(t) : null;
    const convDelta = (prevConv[t] != null && conv != null) ? conv - prevConv[t] : null;
    const action = decideAction({ conviction: conv, convDelta, sigTypes, threatCritical: false });
    if (!action) continue;
    // levels require real price + volatility; skip if unavailable (no fabrication).
    const price = priceMap.get(t);
    const volPct = volMap.get(t);
    const levels = buildLevels(price, volPct, action);
    if (!levels) continue;
    const confidence = clamp(Math.round(
      (conv != null ? conv * 0.6 : 30) + (sigs.length ? Math.min(sigs.length * 8, 40) : 0)
    ), 1, 100);
    const plan = {
      token_id: t, action,
      entry_zone: levels.entry_zone, invalidation_zone: levels.invalidation_zone,
      target_1: levels.target_1, target_2: levels.target_2, risk_reward: levels.risk_reward,
      confidence, conviction_score: conv, ref_price: levels.ref_price,
      signal_ids: sigs.map(s => s.id), created_at: now,
    };
    plans.push(plan);
  }

  // persist
  let written = 0;
  for (const p of plans.slice(0, 200)) {
    const id = planId(p.action, p.token_id, now);
    try {
      await env.DB.prepare(
        `INSERT INTO execution_plans (id, token_id, action, plan_json, created_at)
         VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           action=excluded.action, plan_json=excluded.plan_json, created_at=excluded.created_at`
      ).bind(id, p.token_id, p.action, JSON.stringify(p), now).run();
      written++;
    } catch (e) {}
  }
  // refresh conviction snapshot for next delta
  if (env.CACHE && typeof env.CACHE.put === 'function') { const m = {}; convMap.forEach((v, k) => m[k] = v); try { await env.CACHE.put('exec:convsnap', JSON.stringify(m)); } catch (e) {} }
  return { ok: true, generated: plans.length, written };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/execution' && request.method === 'GET') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', plans: [] }, origin);
      const token = url.searchParams.get('token'), action = url.searchParams.get('action');
      const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
      let rows = [];
      try {
        let q = 'SELECT * FROM execution_plans', cond = [], binds = [];
        if (token) { cond.push('token_id=?'); binds.push(key(token)); }
        if (action) { cond.push('action=?'); binds.push(action); }
        if (cond.length) q += ' WHERE ' + cond.join(' AND ');
        q += ' ORDER BY created_at DESC LIMIT ?'; binds.push(limit);
        const r = await env.DB.prepare(q).bind(...binds).all();
        rows = (r && r.results) || [];
      } catch (e) { rows = []; }
      return json(200, { plans: rows.map(r => { try { r.plan = JSON.parse(r.plan_json); } catch (e) { r.plan = {}; } return r; }) }, origin);
    }

    if (url.pathname === '/api/execution/generate' && request.method === 'POST') {
      return json(200, await generate(env), origin);
    }

    return json(404, { error: 'not found', routes: ['/api/execution', '/api/execution/generate'] }, origin);
  },

  async scheduled(event, env, ctx) { if (_dbOk(env)) ctx.waitUntil(generate(env).catch(() => {})); },
};
