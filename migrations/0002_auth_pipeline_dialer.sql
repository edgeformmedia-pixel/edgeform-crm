-- Replaces the Google Apps Script auth service, LeadHunter sheets, and dialer sheets.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  lead_key TEXT NOT NULL UNIQUE,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_codes (
  user_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dedupe_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  review_count TEXT NOT NULL DEFAULT '',
  has_website TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  maps_url TEXT NOT NULL DEFAULT '',
  search_url TEXT NOT NULL DEFAULT '',
  website_type TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'New Lead',
  notes TEXT NOT NULL DEFAULT '',
  scan_query TEXT NOT NULL DEFAULT '',
  scanned_at TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'leadhunter',
  UNIQUE (owner_id, dedupe_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT NOT NULL,
  lead_id TEXT,
  lead_name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  maps_url TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  booker TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT NOT NULL,
  lead_id TEXT,
  lead_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'pipeline',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dialer_lists (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '[]',
  UNIQUE (owner_id, name),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dialer_rows (
  list_id TEXT NOT NULL,
  row_idx INTEGER NOT NULL,
  cells TEXT NOT NULL DEFAULT '[]',
  outcomes TEXT NOT NULL DEFAULT '[]',
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, row_idx),
  FOREIGN KEY (list_id) REFERENCES dialer_lists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dialer_tracker (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  dials INTEGER NOT NULL DEFAULT 0,
  pickups INTEGER NOT NULL DEFAULT 0,
  booked INTEGER NOT NULL DEFAULT 0,
  ni INTEGER NOT NULL DEFAULT 0,
  cb INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments(user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_user ON call_logs(user_id, created_at DESC);
