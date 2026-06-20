-- ============================================================================
-- 0009_conviction.sql — CoinDex Pro Phase 5B
-- Conviction scores per token. Apply with:
--   wrangler d1 execute coindex-db --file=0009_conviction.sql
-- Idempotent. UNIQUE(token_id) so compute UPSERTs one row per token.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conviction_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id        TEXT NOT NULL,
  score           INTEGER,
  components_json TEXT,
  created_at      INTEGER,
  UNIQUE (token_id)
);

CREATE INDEX IF NOT EXISTS idx_conviction_score   ON conviction_scores (score);
CREATE INDEX IF NOT EXISTS idx_conviction_created ON conviction_scores (created_at);
