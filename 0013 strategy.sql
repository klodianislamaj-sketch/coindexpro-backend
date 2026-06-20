-- ============================================================================
-- 0013_strategy.sql — CoinDex Pro Phase 8 (Strategy Orchestration Layer)
-- Deployable strategy selections combining all intelligence layers.
-- Apply with:  wrangler d1 execute coindex-db --file=0013_strategy.sql
-- Idempotent. UNIQUE(id) so generation UPSERTs one strategy per token per day.
-- ============================================================================

CREATE TABLE IF NOT EXISTS strategies (
  id            TEXT PRIMARY KEY,
  token_id      TEXT,
  strategy      TEXT,
  action        TEXT,
  strategy_json TEXT,
  created_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_strategy_created  ON strategies (created_at);
CREATE INDEX IF NOT EXISTS idx_strategy_token    ON strategies (token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_strategy_name     ON strategies (strategy, created_at);
