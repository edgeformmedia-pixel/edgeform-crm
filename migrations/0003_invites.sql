-- Invite-only accounts. Roles: owner (master admin) > admin > member.

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);

-- Public signup is closed; drop accounts that never finished verifying.
DELETE FROM users WHERE verified = 0;
DROP TABLE IF EXISTS verification_codes;

UPDATE users SET role = 'owner' WHERE email = 'edgeformmedia@gmail.com';

-- The cold-calling pipeline is retired (LeadHunter leads, appointments, call logs).
DROP TABLE IF EXISTS call_logs;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS leads;
