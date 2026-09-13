-- Shared team mailboxes (team@, inquiries@, admin@) sent and received through Resend.

CREATE TABLE IF NOT EXISTS mail_threads (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  subject_key TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  -- Counterparties (not our own mailbox addresses), comma separated, lowercased.
  participants TEXT NOT NULL DEFAULT '',
  -- Display line for the list: last sender name or recipients.
  display_from TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'inbox',
  unread INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  has_inbound INTEGER NOT NULL DEFAULT 0,
  has_outbound INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_threads_box ON mail_threads(mailbox, folder, last_message_at);
CREATE INDEX IF NOT EXISTS idx_mail_threads_subject ON mail_threads(mailbox, subject_key);

CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  direction TEXT NOT NULL,             -- in | out
  status TEXT NOT NULL,                -- received | sent | scheduled | sending | failed | canceled
  resend_id TEXT,
  message_id TEXT,                     -- RFC Message-ID
  in_reply_to TEXT,
  references_hdr TEXT,
  from_addr TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  -- Set instead of html when the body is too large for a D1 row.
  body_key TEXT,
  -- What the sender typed (no signature), kept so a scheduled send can be reopened as a draft.
  compose_html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  sent_by TEXT,
  sent_by_name TEXT NOT NULL DEFAULT '',
  error TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES mail_threads(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_resend ON mail_messages(mailbox, resend_id) WHERE resend_id IS NOT NULL AND direction = 'in';
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_messages_msgid ON mail_messages(mailbox, message_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_scheduled ON mail_messages(status, scheduled_at);

-- Files live in R2; rows start unattached (uploaded for a draft) and get a message_id on send.
CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  message_id TEXT,
  draft_id TEXT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  inline INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  access_token TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mail_attachments_message ON mail_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_draft ON mail_attachments(draft_id);

-- Drafts are private to the person writing them.
CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT,
  mode TEXT NOT NULL DEFAULT 'new',    -- new | reply | reply_all | forward
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mail_drafts_user ON mail_drafts(user_id, mailbox, updated_at);

-- Internal notes on a thread, visible to everyone with access to the mailbox, never emailed.
CREATE TABLE IF NOT EXISTS mail_notes (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES mail_threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mail_notes_thread ON mail_notes(thread_id, created_at);

-- Canned responses shared across the team.
CREATE TABLE IF NOT EXISTS mail_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-user signature details.
CREATE TABLE IF NOT EXISTS mail_settings (
  user_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Senders marked as spam; their future mail lands in Spam.
CREATE TABLE IF NOT EXISTS mail_blocked (
  mailbox TEXT NOT NULL,
  address TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mailbox, address)
);

-- Sync cursor and other small key/value state.
CREATE TABLE IF NOT EXISTS mail_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
