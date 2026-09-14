-- Audit discovery requests, limits, token usage, and estimated spend.

CREATE TABLE IF NOT EXISTS influencer_discovery_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  query TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '{}',
  requested_count INTEGER NOT NULL,
  budget_usd REAL NOT NULL,
  found_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_calls INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete',
  error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_influencer_discovery_runs_created
  ON influencer_discovery_runs(created_at DESC);
