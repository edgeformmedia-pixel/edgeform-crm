-- Operations get named numbers, formulas written with those names, creators + videos (marketing),
-- and recruited people (sales / systems). Replaces the goal-only metrics from 0006, which held no data.

DROP TABLE IF EXISTS operation_metric_logs;
DROP TABLE IF EXISTS operation_metrics;

-- Numbers typed in per operation, used by name in formulas (e.g. cpmToCreators, myPercent).
CREATE TABLE IF NOT EXISTS operation_vars (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  format TEXT NOT NULL DEFAULT 'number', -- number | money | percent
  tracked INTEGER NOT NULL DEFAULT 0,    -- 1 = a number that changes over time; every change is logged
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_vars_key ON operation_vars(operation_id, key);

CREATE TABLE IF NOT EXISTS operation_var_logs (
  id TEXT PRIMARY KEY,
  var_id TEXT NOT NULL,
  value REAL NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (var_id) REFERENCES operation_vars(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_var_logs_var ON operation_var_logs(var_id, created_at);

-- Calculations. The first one (sort 0) is the operation's headline number.
CREATE TABLE IF NOT EXISTS operation_formulas (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  label TEXT NOT NULL,
  expr TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'money',  -- number | money | percent | multiple | months
  sort INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_formulas_op ON operation_formulas(operation_id, sort);

-- Marketing: creators posting for the client, and each video's views.
CREATE TABLE IF NOT EXISTS operation_creators (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_creators_op ON operation_creators(operation_id, sort);

CREATE TABLE IF NOT EXISTS operation_videos (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  url TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  views_confirmed INTEGER NOT NULL DEFAULT 0, -- 0 = placeholder, 1 = someone entered the real count
  views_updated_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES operation_creators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_videos_creator ON operation_videos(creator_id, sort);

-- Sales / systems: people we recruit for the client.
CREATE TABLE IF NOT EXISTS operation_people (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'prospect', -- prospect | hired
  started TEXT,
  revenue REAL NOT NULL DEFAULT 0,        -- brings in per month (expected, for prospects)
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_people_op ON operation_people(operation_id, sort);
