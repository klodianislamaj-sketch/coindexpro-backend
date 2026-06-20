-- ============================================================================
-- 0008_signals.sql — CoinDex Pro Phase 5A
-- Signals table for the Autonomous Intelligence Engine. Apply with:
--   wrangler d1 execute coindex-db --file=0008_signals.sql
-- Idempotent (IF NOT EXISTS). No other tables touched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS signals (
  id         TEXT PRIMARY KEY,
  token_id   TEXT,
  type       TEXT,
  strength   INTEGER,
  confidence INTEGER,
  reason     TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_signals_created ON signals (created_at);
CREATE INDEX IF NOT EXISTS idx_signals_token   ON signals (token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_type    ON signals (type, created_at);
