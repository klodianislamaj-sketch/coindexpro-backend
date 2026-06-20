-- ============================================================================
-- 0012_learning.sql — CoinDex Pro Phase 7 (Adaptive Learning Layer)
-- Records completed trade outcomes for deterministic feedback aggregation.
-- Apply with:  wrangler d1 execute coindex-db --file=0012_learning.sql
-- Idempotent. No existing tables altered.
-- ============================================================================

CREATE TABLE IF NOT EXISTS trade_outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id        TEXT,
  action          TEXT,
  signal_type     TEXT,
  execution_type  TEXT,
  allocation_class TEXT,
  conviction      INTEGER,
  result          TEXT,            -- WIN | LOSS | BREAKEVEN
  rr_realized     REAL,
  mae             REAL,            -- max adverse excursion (% from entry)
  mfe             REAL,            -- max favourable excursion (% from entry)
  slippage        REAL,
  regime          TEXT,            -- LOW_VOL | MID_VOL | HIGH_VOL
  entry           REAL,
  exit_price      REAL,
  created_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outcome_created ON trade_outcomes (created_at);
CREATE INDEX IF NOT EXISTS idx_outcome_token   ON trade_outcomes (token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outcome_signal  ON trade_outcomes (signal_type);
CREATE INDEX IF NOT EXISTS idx_outcome_result  ON trade_outcomes (result);
