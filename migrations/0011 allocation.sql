-- ============================================================================
-- 0011_allocation.sql — CoinDex Pro Phase 6
-- Capital allocation decisions derived from execution plans + conviction.
-- Apply with:  wrangler d1 execute coindex-db --file=0011_allocation.sql
-- Idempotent. UNIQUE(id) so generation UPSERTs one allocation per token per day.
-- ============================================================================

CREATE TABLE IF NOT EXISTS allocations (
  id          TEXT PRIMARY KEY,
  token_id    TEXT,
  action      TEXT,
  alloc_json  TEXT,
  created_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_alloc_created ON allocations (created_at);
CREATE INDEX IF NOT EXISTS idx_alloc_token   ON allocations (token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alloc_action  ON allocations (action, created_at);
