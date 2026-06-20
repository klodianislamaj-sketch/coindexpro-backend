// ============================================================================
// strategy-worker.js — CoinDex Pro Phase 8 (Strategy Orchestration Layer)
// Combines predictive/signals/conviction/execution/allocation/learning into
// deployable strategy templates with deterministic selection + scoring. Never
// executes trades, never mutates weights. If a required layer is missing for a
// template, that template returns null (no fabricated scores).
//
// Bindings (shared): env.DB (D1).
// Sibling URLs via env: SIGNALS_URL, CONVICTION_URL, EXECUTION_URL,
//                       ALLOCATION_URL, LEARNING_URL.
//
// Routes:
//   GET  /api/strategy           -> active + ranked strategies + performance
//   POST /api/strategy/generate  -> generate from posted layers (or sibling fetch)
// ============================================================================

const DAY = 86400000;

// Strategy templates. Each declares the conditions that must hold. `signal`
// matches signal types; thresholds are explicit + deterministic.
const TEMPLATES = [
  { name: 'Momentum Breakout', signal: 'momentum_breakout', convMin: 80, exec: ['BUY'], alloc: ['ALLOCATE'], edgeMin: 65, action: 'READY' },
  { name: 'Trend Continuation', signal: 'trend_hold', convMin: 70, exec: ['WATCH', 'BUY'], alloc: ['HOLD', 'ALLOCATE'], edgeMin: 55, action: 'READY' },
  { name: 'Reversal Catch', signal: 'reversal', convMin: 75, exec: ['BUY'], alloc: ['ALLOCATE'], edgeMin: 60, action: 'READY' },
  { name: 'Exit Defense', signal: null, convMin: null, exec: ['EXIT'], alloc: ['CLOSE'], edgeMin: null, action: 'DEFEND', heatMin: 70 },
];

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function round(n, dp) { if (n == null) return null; const f = Math.pow(10, dp); return Math.round(n * f) / f; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function key(x) { return String(x == null ? '' : x).toLowerCase(); }
async function fetchJSON(url) { if (!url) return null; try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } }

// regime fit score 0..100 from regime match between execution context + learning.
function regimeFitScore(tokenRegime, templateRegime) {
  if (!tokenRegime) return 50;                  // neutral when unknown (not fabricated, explicit default)
  if (!templateRegime) return 60;
  return tokenRegime === templateRegime ? 100 : 40;
}

// Deterministic strategy score. Returns null if a required input is missing.
//   conviction*0.30 + execConfidence*0.25 + allocScore*0.20 + historicalEdge*0.20 + regimeFit*0.05
function scoreStrategy({ conviction, execConfidence, allocScore, historicalEdge, regimeFit }) {
  if (conviction == null || execConfidence == null || allocScore == null || historicalEdge == null) return null;
  const s = conviction * 0.30 + execConfidence * 0.25 + allocScore * 0.20 + historicalEdge * 0.20 + (regimeFit != null ? regimeFit : 50) * 0.05;
  return clamp(Math.round(s), 1, 100);
}

// Match one token's layer data against a template. Returns plan obj or null.
function matchTemplate(tpl, ctx) {
  const { sigTypes, conviction, execAction, allocAction, historicalEdge, portfolioHeat, execConfidence, allocScore, capital, risk, regime } = ctx;
  // Exit Defense is special: needs execution EXIT + allocation CLOSE + heat>70
  if (tpl.name === 'Exit Defense') {
    if (execAction !== 'EXIT' || allocAction !== 'CLOSE') return null;
    if (portfolioHeat == null || portfolioHeat <= tpl.heatMin) return null;
    return { matched: true, score: clamp(Math.round((portfolioHeat || 0)), 1, 100), regimeFit: 'DEFENSIVE' };
  }
  // others need their signal + conviction + execution + allocation + edge
  if (tpl.signal && !sigTypes.has(tpl.signal)) return null;
  if (tpl.convMin != null && (conviction == null || conviction <= tpl.convMin)) return null;
  if (tpl.exec && !tpl.exec.includes(execAction)) return null;
  if (tpl.alloc && !tpl.alloc.includes(allocAction)) return null;
  if (tpl.edgeMin != null && (historicalEdge == null || historicalEdge <= tpl.edgeMin)) return null;
  const regimeFit = regimeFitScore(regime, tpl.regime);
  const score = scoreStrategy({ conviction, execConfidence, allocScore, historicalEdge, regimeFit });
  if (score == null) return null;     // missing required layer → null (no fabrication)
  return { matched: true, score, regimeFit: regime || 'UNKNOWN' };
}

function strategyId(name, token, ts) { return `${name}:${token}:${Math.floor(ts / DAY)}`.replace(/\s+/g, '_'); }

function generateFrom(layers) {
  const { signals, conviction, execution, allocation, learning } = layers;
  const sigByToken = new Map();
  for (const s of (signals || [])) { const k = key(s.token_id); if (!k) continue; if (!sigByToken.has(k)) sigByToken.set(k, new Set()); sigByToken.get(k).add(s.type); }
  const convMap = new Map((conviction || []).map(c => [key(c.token_id), c.score]));
  const execMap = new Map((execution || []).map(p => [key(p.token_id), p.plan || p]));
  const allocMap = new Map((allocation || []).map(a => [key(a.token_id), a.allocation || a]));
  // historical edge: avg signal win rate from learning (global proxy, real data)
  let historicalEdge = null, regimeOverall = null;
  if (learning && learning.signal_win_rates) {
    const edges = Object.values(learning.signal_win_rates).map(v => v.win_rate || 0);
    if (edges.length) historicalEdge = round(edges.reduce((a, b) => a + b, 0) / edges.length, 1);
    const regimes = learning.regime_performance ? Object.entries(learning.regime_performance).sort((a, b) => (b[1].win_rate || 0) - (a[1].win_rate || 0)) : [];
    if (regimes.length) regimeOverall = regimes[0][0];
  }

  const tokens = new Set([...sigByToken.keys(), ...convMap.keys(), ...execMap.keys(), ...allocMap.keys()]);
  const strategies = [];
  for (const t of tokens) {
    const sigTypes = sigByToken.get(t) || new Set();
    const conv = convMap.has(t) ? convMap.get(t) : null;
    const plan = execMap.get(t) || null;
    const al = allocMap.get(t) || null;
    const ctx = {
      sigTypes, conviction: conv,
      execAction: plan ? plan.action : null, execConfidence: plan ? num(plan.confidence) : null,
      allocAction: al ? al.action : null, allocScore: al ? (num(al.position_size) != null ? num(al.position_size) + (num(al.heat_score) || 0) / 10 : null) : null,
      capital: al ? num(al.capital) : null, risk: al ? num(al.risk_percent) : null,
      historicalEdge, portfolioHeat: al ? num(al.heat_score) : null, regime: regimeOverall,
    };
    for (const tpl of TEMPLATES) {
      const m = matchTemplate(tpl, ctx);
      if (!m) continue;
      strategies.push({
        strategy: tpl.name, token: t, score: m.score, action: tpl.action,
        capital: ctx.capital, risk: ctx.risk, historical_edge: historicalEdge,
        regime_fit: m.regimeFit, conviction: conv,
      });
    }
  }
  strategies.sort((a, b) => b.score - a.score);
  return strategies;
}

async function generate(env, body) {
  if (!_dbOk(env)) return { ok: false, reason: 'db-unbound' };
  let signals = body && body.signals, conviction = body && body.conviction, execution = body && body.execution, allocation = body && body.allocation, learning = body && body.learning;
  if (!signals) { const s = await fetchJSON(env.SIGNALS_URL ? env.SIGNALS_URL + '/api/signals?limit=300' : ''); signals = s ? s.signals : null; }
  if (!conviction) { const c = await fetchJSON(env.CONVICTION_URL ? env.CONVICTION_URL + '/api/conviction?limit=500' : ''); conviction = c ? c.scores : null; }
  if (!execution) { const e = await fetchJSON(env.EXECUTION_URL ? env.EXECUTION_URL + '/api/execution?limit=300' : ''); execution = e ? e.plans : null; }
  if (!allocation) { const a = await fetchJSON(env.ALLOCATION_URL ? env.ALLOCATION_URL + '/api/allocation?limit=300' : ''); allocation = a ? a.allocations : null; }
  if (!learning) { learning = await fetchJSON(env.LEARNING_URL ? env.LEARNING_URL + '/api/learning' : ''); }
  if ((!signals || !signals.length) && (!execution || !execution.length)) return { ok: false, reason: 'no-input-data', generated: 0 };

  const strategies = generateFrom({ signals, conviction, execution, allocation, learning });
  const now = Date.now();
  let written = 0;
  for (const s of strategies.slice(0, 200)) {
    const id = strategyId(s.strategy, s.token, now);
    try {
      await env.DB.prepare(
        `INSERT INTO strategies (id, token_id, strategy, action, strategy_json, created_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           strategy=excluded.strategy, action=excluded.action, strategy_json=excluded.strategy_json, created_at=excluded.created_at`
      ).bind(id, s.token, s.strategy, s.action, JSON.stringify(s), now).run();
      written++;
    } catch (e) {}
  }
  return { ok: true, generated: strategies.length, written };
}

// strategy performance: join stored strategies' tokens to learning outcomes.
async function performance(env) {
  // analytics-only — aggregates trade_outcomes by nothing strategy-specific here
  // unless outcomes carry signal/execution type; we expose per-strategy via learning.
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/strategy' && request.method === 'GET') {
      if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound', strategies: [] }, origin);
      const token = url.searchParams.get('token'), name = url.searchParams.get('name');
      const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
      let rows = [];
      try {
        let q = 'SELECT * FROM strategies', cond = [], binds = [];
        if (token) { cond.push('token_id=?'); binds.push(key(token)); }
        if (name) { cond.push('strategy=?'); binds.push(name); }
        if (cond.length) q += ' WHERE ' + cond.join(' AND ');
        q += ' ORDER BY created_at DESC LIMIT ?'; binds.push(limit);
        const r = await env.DB.prepare(q).bind(...binds).all();
        rows = (r && r.results) || [];
      } catch (e) { rows = []; }
      const strategies = rows.map(r => { try { r.detail = JSON.parse(r.strategy_json); } catch (e) { r.detail = {}; } return r; });
      // ranked + performance aggregation (deterministic, analytics-only)
      const ranked = [...strategies].sort((a, b) => ((b.detail && b.detail.score) || 0) - ((a.detail && a.detail.score) || 0));
      const perfByStrategy = {};
      for (const s of strategies) {
        const nm = s.strategy; if (!nm) continue;
        const p = perfByStrategy[nm] = perfByStrategy[nm] || { count: 0, capital: 0, scoreSum: 0 };
        p.count++; p.capital += (s.detail && num(s.detail.capital)) || 0; p.scoreSum += (s.detail && s.detail.score) || 0;
      }
      for (const k of Object.keys(perfByStrategy)) { const p = perfByStrategy[k]; p.avg_score = p.count ? Math.round(p.scoreSum / p.count) : null; delete p.scoreSum; }
      return json(200, { strategies, ranked, performance: perfByStrategy }, origin);
    }

    if (url.pathname === '/api/strategy/generate' && request.method === 'POST') {
      let body = null; try { body = await request.json(); } catch (e) { body = null; }
      return json(200, await generate(env, body), origin);
    }

    return json(404, { error: 'not found', routes: ['/api/strategy', '/api/strategy/generate'] }, origin);
  },

  async scheduled(event, env, ctx) { if (_dbOk(env)) ctx.waitUntil(generate(env, null).catch(() => {})); },
};
