-- An OpenAI key entered from Find Creators settings is encrypted before D1 storage.
-- The wrapping key remains a Cloudflare Worker secret and is never stored in D1.

CREATE TABLE IF NOT EXISTS influencer_ai_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  api_key_iv TEXT NOT NULL DEFAULT '',
  api_key_hint TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT,
  updated_at TEXT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO influencer_ai_settings (id) VALUES ('default');
