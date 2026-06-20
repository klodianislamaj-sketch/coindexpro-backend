-- ============================================================================
-- CoinDex Pro — Phase 3 Foundation Schema (Cloudflare D1 / SQLite)
-- Apply with:  wrangler d1 execute coindex-db --file=schema.sql
-- Idempotent: safe to re-run (CREATE TABLE IF NOT EXISTS).
-- No feature logic here — tables + indexes only.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- token_security : latest GoPlus-style security result per token, one row each.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_security (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id    TEXT    NOT NULL,
  address     TEXT    NOT NULL,
  score       REAL,
  flags_json  TEXT,                       -- JSON array/object of flags
  raw_json    TEXT,                        -- raw provider payload (audit trail)
  updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE (chain_id, address)
);
CREATE INDEX IF NOT EXISTS idx_token_security_addr    ON token_security (address);
CREATE INDEX IF NOT EXISTS idx_token_security_updated ON token_security (updated_at);

-- ---------------------------------------------------------------------------
-- token_security_audit : append-only log of score changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_security_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id    INTEGER NOT NULL,
  old_score   REAL,
  new_score   REAL,
  changed_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  FOREIGN KEY (token_id) REFERENCES token_security (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tsa_token ON token_security_audit (token_id, changed_at);

-- ---------------------------------------------------------------------------
-- token_metrics_daily : daily OHLCV candles (backfill target). One row per
-- token per day; (token_id, ts) is unique so upserts are clean.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_metrics_daily (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id  TEXT    NOT NULL,             -- cg_id or internal token key
  ts        INTEGER NOT NULL,             -- day timestamp (ms, UTC midnight)
  open      REAL,
  high      REAL,
  low       REAL,
  close     REAL,
  volume    REAL,
  UNIQUE (token_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_tmd_token ON token_metrics_daily (token_id, ts);

-- ---------------------------------------------------------------------------
-- provider_health : runtime reliability metrics per upstream provider.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_health (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT    NOT NULL UNIQUE,
  success_rate    REAL    DEFAULT 0,       -- 0..1
  avg_latency     REAL    DEFAULT 0,       -- ms
  rate_limit_hits INTEGER DEFAULT 0,
  integrity_score REAL    DEFAULT 0,       -- 0..1
  freshness_score REAL    DEFAULT 0,       -- 0..1
  reliability     REAL    DEFAULT 0,       -- 0..1 composite (computed)
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_provider_health_rel ON provider_health (reliability);

-- ---------------------------------------------------------------------------
-- anomalies : detected data-integrity anomalies from the ingest pipeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anomalies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id     TEXT,
  type         TEXT    NOT NULL,           -- e.g. 'liquidity_jump','price_jump'
  severity     TEXT    NOT NULL DEFAULT 'info',  -- info|warn|critical
  details_json TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_anomalies_created ON anomalies (created_at);
CREATE INDEX IF NOT EXISTS idx_anomalies_token   ON anomalies (token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_anomalies_type    ON anomalies (type, created_at);

-- ---------------------------------------------------------------------------
-- watchlists : per-user watchlist with version for conflict protection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watchlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL UNIQUE,
  items_json TEXT    NOT NULL DEFAULT '[]',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists (user_id);
