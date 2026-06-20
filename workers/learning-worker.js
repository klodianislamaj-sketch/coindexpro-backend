// ============================================================================
// learning-worker.js — CoinDex Pro Phase 7 (Adaptive Learning Layer)
// Turns completed trade outcomes into deterministic feedback. Ingest computes
// WIN/LOSS/BREAKEVEN + R:R + MAE/MFE + slippage + regime from REAL numbers only;
// if price history is missing it returns null. GET aggregates win rates and emits
// adaptive weight SUGGESTIONS (recommendations only — never mutates live logic).
//
// Bindings (shared): env.DB (D1).
//
// Routes:
//   GET  /api/learning         -> aggregated performance + suggestions
//   POST /api/learning/ingest  -> record one completed trade outcome
// ============================================================================

function _dbOk(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
function corsHeaders(o) { return { 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(s, o, origin) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function round(n, dp) { if (n == null) return null; const f = Math.pow(10, dp); return Math.round(n * f) / f; }
function key(x) { return String(x == null ? '' : x).toLowerCase(); }

// ── deterministic outcome from a completed trade ────────────────────────────
// Required: entry, exit, stop. Optional price history (low/high) for MAE/MFE.
function computeOutcome(t) {
  const entry = num(t.entry), exit = num(t.exit), stop = num(t.stop);
  if (entry == null || exit == null || stop == null || entry <= 0) return null;   // missing → null
  let result;
  if (exit < stop) result = 'LOSS';
  else if (exit > entry) result = 'WIN';
  else if (exit === entry) result = 'BREAKEVEN';
  else result = 'LOSS';                          // below entry but above stop = small loss
  // realized R:R from planned stop distance
  const stopDist = Math.abs(entry - stop);
  const rr = stopDist > 0 ? round((exit - entry) / stopDist, 2) : null;
  // MAE/MFE from price history if provided (else from stop/exit as bounds, honest null otherwise)
  const lowest = num(t.lowest_price), highest = num(t.highest_price);
  const mae = lowest != null ? round((lowest - entry) / entry * 100, 1) : null;
  const mfe = highest != null ? round((highest - entry) / entry * 100, 1) : null;
  // slippage = actual entry - planned entry (if both present)
  const actualEntry = num(t.actual_entry), plannedEntry = num(t.planned_entry != null ? t.planned_entry : t.entry);
  const slippage = (actualEntry != null && plannedEntry != null) ? round(actualEntry - plannedEntry, 2) : null;
  // regime from supplied volatility (deterministic banding)
  const vol = num(t.volatility);
  let regime = t.regime || null;
  if (!regime && vol != null) regime = vol >= 8 ? 'HIGH_VOL' : vol >= 4 ? 'MID_VOL' : 'LOW_VOL';
  return { result, rr_realized: rr, mae, mfe, slippage, regime };
}

function convictionBand(c) {
  if (c == null) return null;
  if (c < 35) return '0-35'; if (c < 55) return '35-55'; if (c < 75) return '55-75'; if (c < 90) return '75-90'; return '90+';
}

// win rate helper over a grouping
function winRates(rows, field) {
  const g = {};
  for (const r of rows) {
    const k = r[field]; if (k == null || k === '') continue;
    (g[k] = g[k] || { wins: 0, total: 0 }).total++;
    if (r.result === 'WIN') g[k].wins++;
  }
  const out = {};
  for (const [k, v] of Object.entries(g)) out[k] = { win_rate: v.total ? round(v.wins / v.total * 100, 1) : null, sample: v.total };
  return out;
}

// adaptive weight SUGGESTIONS (recommend only).
function buildSuggestions(bySignal, byBand, byExec, byClass, rows) {
  const conviction = [], execution = [], allocation = [];
  for (const [sig, v] of Object.entries(bySignal)) {
    if (v.sample >= 5 && v.win_rate > 65) conviction.push({ target: sig, suggestion: 'increase_weight', reason: `signal win rate ${v.win_rate}% (${v.sample})` });
  }
  for (const [band, v] of Object.entries(byBand)) {
    if (v.sample >= 5 && v.win_rate < 45) conviction.push({ target: 'band ' + band, suggestion: 'reduce_weight', reason: `band win rate ${v.win_rate}% (${v.sample})` });
  }
  // MAE consistently exceeds stop → tighten execution
  const maeBreaches = rows.filter(r => r.mae != null && r.mae < -10).length;
  if (rows.length >= 5 && maeBreaches / rows.length > 0.4) execution.push({ target: 'stop_distance', suggestion: 'tighten', reason: `${maeBreaches}/${rows.length} trades MAE < -10%` });
  for (const [cls, v] of Object.entries(byClass)) {
    if (v.sample >= 5 && v.win_rate < 45) allocation.push({ target: cls, suggestion: 'reduce_risk', reason: `class win rate ${v.win_rate}% (${v.sample})` });
  }
  return {
    suggested_conviction_weight_adjustments: conviction,
    suggested_execution_rr_adjustments: execution,
    suggested_allocation_risk_adjustments: allocation,
  };
}

async function aggregate(env) {
  if (!_dbOk(env)) return { available: false, reason: 'db-unbound' };
  let rows = [];
  try { const r = await env.DB.prepare('SELECT * FROM trade_outcomes ORDER BY created_at DESC LIMIT 5000').all(); rows = (r && r.results) || []; }
  catch (e) { rows = []; }
  if (!rows.length) return { available: true, empty: true, sample: 0 };

  rows.forEach(r => { r._band = convictionBand(r.conviction); });
  const bySignal = winRates(rows, 'signal_type');
  const byBand = winRates(rows, '_band');
  const byExec = winRates(rows, 'execution_type');
  const byClass = winRates(rows, 'allocation_class');
  const byRegime = winRates(rows, 'regime');

  const avg = (arr, f) => { const xs = arr.map(f).filter(x => x != null); return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null; };
  // drawdown clusters: group MAE into buckets
  const ddClusters = { '0..-5': 0, '-5..-10': 0, '-10..-20': 0, '<-20': 0 };
  for (const r of rows) { const m = num(r.mae); if (m == null) continue; if (m > -5) ddClusters['0..-5']++; else if (m > -10) ddClusters['-5..-10']++; else if (m > -20) ddClusters['-10..-20']++; else ddClusters['<-20']++; }

  return {
    available: true, sample: rows.length,
    signal_win_rates: bySignal,
    conviction_win_rates: byBand,
    execution_win_rates: byExec,
    allocation_win_rates: byClass,
    regime_performance: byRegime,
    drawdown_clusters: ddClusters,
    mae_avg: avg(rows, r => num(r.mae)), mfe_avg: avg(rows, r => num(r.mfe)),
    rr_avg: avg(rows, r => num(r.rr_realized)),
    overall_win_rate: round(rows.filter(r => r.result === 'WIN').length / rows.length * 100, 1),
    ...buildSuggestions(bySignal, byBand, byExec, byClass, rows),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/api/learning' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (token) {
        if (!_dbOk(env)) return json(200, { available: false, reason: 'db-unbound' }, origin);
        let rows = [];
        try { const r = await env.DB.prepare('SELECT * FROM trade_outcomes WHERE token_id=? ORDER BY created_at DESC LIMIT 500').bind(key(token)).all(); rows = (r && r.results) || []; }
        catch (e) { rows = []; }
        if (!rows.length) return json(200, { available: true, empty: true, token, sample: 0 }, origin);
        const wins = rows.filter(r => r.result === 'WIN').length;
        const avg = f => { const xs = rows.map(f).filter(x => x != null); return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null; };
        const bySetup = winRates(rows, 'signal_type');
        const best = Object.entries(bySetup).filter(([, v]) => v.sample >= 2).sort((a, b) => (b[1].win_rate || 0) - (a[1].win_rate || 0))[0];
        return json(200, {
          available: true, token, sample: rows.length,
          win_rate: round(wins / rows.length * 100, 1), failure_rate: round((rows.length - wins) / rows.length * 100, 1),
          rr_avg: avg(r => num(r.rr_realized)), mae_avg: avg(r => num(r.mae)), mfe_avg: avg(r => num(r.mfe)),
          best_setup: best ? { setup: best[0], win_rate: best[1].win_rate } : null,
        }, origin);
      }
      return json(200, await aggregate(env), origin);
    }

    if (url.pathname === '/api/learning/ingest' && request.method === 'POST') {
      if (!_dbOk(env)) return json(200, { ok: false, reason: 'db-unbound' }, origin);
      let body = null; try { body = await request.json(); } catch (e) { body = null; }
      if (!body) return json(200, { ok: false, reason: 'no-body' }, origin);
      const outcome = computeOutcome(body);
      if (!outcome) return json(200, { ok: false, reason: 'insufficient-data', result: null }, origin);
      const now = Date.now();
      try {
        await env.DB.prepare(
          `INSERT INTO trade_outcomes (token_id, action, signal_type, execution_type, allocation_class, conviction,
             result, rr_realized, mae, mfe, slippage, regime, entry, exit_price, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(key(body.token), body.action || null, body.signal_type || null, body.execution_type || null,
          body.allocation_class || null, num(body.conviction), outcome.result, outcome.rr_realized,
          outcome.mae, outcome.mfe, outcome.slippage, outcome.regime, num(body.entry), num(body.exit), now).run();
      } catch (e) { return json(200, { ok: false, reason: 'write-failed' }, origin); }
      return json(200, { ok: true, ...outcome }, origin);
    }

    return json(404, { error: 'not found', routes: ['/api/learning', '/api/learning/ingest'] }, origin);
  },
};
