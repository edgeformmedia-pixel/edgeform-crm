-- Client work we take on: marketing campaigns, sales operations (run through a CRM we build them),
-- and pipeline / CRM systems development.

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                   -- marketing | sales | systems
  name TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- planning | active | paused | completed
  -- Subdomain of the client's CRM: <slug>.edgeform-media.com. Required for sales, optional for systems.
  slug TEXT,
  start_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  owner_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(type, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_slug ON operations(slug) WHERE slug IS NOT NULL;

-- Numbers an operation is moving: views, followers, leads, booked calls, close rate…
CREATE TABLE IF NOT EXISTS operation_metrics (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',        -- shown after the value, e.g. % or /mo
  baseline REAL,                        -- where the client started
  current REAL,
  goal REAL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_metrics_op ON operation_metrics(operation_id, sort);

-- Every change to a metric's current value, for history and charts.
CREATE TABLE IF NOT EXISTS operation_metric_logs (
  id TEXT PRIMARY KEY,
  metric_id TEXT NOT NULL,
  value REAL NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (metric_id) REFERENCES operation_metrics(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_metric_logs_metric ON operation_metric_logs(metric_id, created_at);
