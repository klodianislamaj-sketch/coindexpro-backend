-- ============================================================================
-- 0010_execution.sql — CoinDex Pro Phase 5C
-- Executable trade plans derived from signals + conviction. Apply with:
--   wrangler d1 execute coindex-db --file=0010_execution.sql
-- Idempotent. UNIQUE(id) so generation UPSERTs one plan per token per day.
-- ============================================================================

CREATE TABLE IF NOT EXISTS execution_plans (
  id         TEXT PRIMARY KEY,
  token_id   TEXT,
  action     TEXT,
  plan_json  TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_exec_created ON execution_plans (created_at);
CREATE INDEX IF NOT EXISTS idx_exec_token   ON execution_plans (token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_action  ON execution_plans (action, created_at);
