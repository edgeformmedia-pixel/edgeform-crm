-- Per-operation switches for the recruiting and overrides sections, override rows,
-- and a commission headline for sales operations created before it existed.

ALTER TABLE operations ADD COLUMN recruiting INTEGER NOT NULL DEFAULT 1;
ALTER TABLE operations ADD COLUMN overrides INTEGER NOT NULL DEFAULT 0;
UPDATE operations SET recruiting = 0 WHERE type = 'marketing';

-- People whose sales I earn an override percentage on.
CREATE TABLE IF NOT EXISTS operation_overrides (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  revenue REAL NOT NULL DEFAULT 0,   -- what they sell per month
  percent REAL NOT NULL DEFAULT 0,   -- my override on their sales
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_overrides_op ON operation_overrides(operation_id, sort);

INSERT INTO operation_formulas (id, operation_id, label, expr, format, sort)
SELECT lower(hex(randomblob(16))), o.id, 'My commission /mo', 'closed * avgJob * myPercent / 100', 'money', -1
FROM operations o
WHERE o.type = 'sales'
  AND NOT EXISTS (SELECT 1 FROM operation_formulas f WHERE f.operation_id = o.id AND f.expr = 'closed * avgJob * myPercent / 100');
