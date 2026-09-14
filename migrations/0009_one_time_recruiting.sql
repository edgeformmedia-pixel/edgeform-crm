-- Recruiting can pay a recurring % of what hires bring in, or a one-time fee per hire.
-- Systems work pays per recruit, so existing systems operations switch to one-time fees.

ALTER TABLE operations ADD COLUMN recruit_pay TEXT NOT NULL DEFAULT 'recurring'; -- recurring | one_time
ALTER TABLE operation_people ADD COLUMN fee REAL NOT NULL DEFAULT 0;              -- one-time fee I earn for this person

UPDATE operations SET recruit_pay = 'one_time' WHERE type = 'systems';

DELETE FROM operation_formulas
WHERE operation_id IN (SELECT id FROM operations WHERE type = 'systems')
  AND expr IN ('hireRevenue * myPercent / 100', 'hireRevenue / hires', 'prospectRevenue * myPercent / 100');

DELETE FROM operation_vars
WHERE operation_id IN (SELECT id FROM operations WHERE type = 'systems') AND key = 'myPercent';

INSERT INTO operation_vars (id, operation_id, key, label, value, format, tracked, sort, updated_at)
SELECT lower(hex(randomblob(16))), o.id, 'feePerHire', 'My fee per hire', 0, 'money', 0, 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM operations o
WHERE o.type = 'systems' AND o.recruiting = 1
  AND NOT EXISTS (SELECT 1 FROM operation_vars v WHERE v.operation_id = o.id AND v.key = 'feePerHire');

INSERT INTO operation_formulas (id, operation_id, label, expr, format, sort)
SELECT lower(hex(randomblob(16))), o.id, f.label, f.expr, 'money', f.sort
FROM operations o
JOIN (SELECT 'Earned from recruits (one-time)' label, 'hireFees' expr, -1 sort
      UNION ALL SELECT 'Could earn if prospects get hired', 'prospectFees', 101
      UNION ALL SELECT 'Average fee per hire', 'hireFees / hires', 102) f
WHERE o.type = 'systems' AND o.recruiting = 1
  AND NOT EXISTS (SELECT 1 FROM operation_formulas x WHERE x.operation_id = o.id AND x.expr = f.expr);
