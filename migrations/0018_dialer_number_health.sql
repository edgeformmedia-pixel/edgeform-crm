-- Per-caller-ID call history, so the dialer can see which of its numbers are
-- burning up and stop handing them out before a carrier flags them as spam.

CREATE TABLE IF NOT EXISTS dialer_number_calls (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  day TEXT NOT NULL,                        -- YYYY-MM-DD in the agent's timezone
  started_at INTEGER NOT NULL,              -- epoch ms, set when the dial fires
  talk_sec INTEGER NOT NULL DEFAULT 0,      -- seconds the call was actually connected
  answered INTEGER NOT NULL DEFAULT 0,      -- carrier-visible answer (SIP 200), voicemail included
  agent TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Rest periods: a number under rest is never handed to the dialer.
CREATE TABLE IF NOT EXISTS dialer_number_rest (
  owner_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  resting_until TEXT NOT NULL,              -- ISO timestamp
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, caller_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dialer_number_calls_recent ON dialer_number_calls(owner_id, started_at);
CREATE INDEX IF NOT EXISTS idx_dialer_number_calls_number ON dialer_number_calls(owner_id, caller_id, started_at);
