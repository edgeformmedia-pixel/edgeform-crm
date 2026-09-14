-- Saved Find Influencers searches (for example one per client), selectable in the discovery window.

CREATE TABLE IF NOT EXISTS discovery_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  brief TEXT NOT NULL DEFAULT '',
  niche TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  follower_min INTEGER,
  follower_max INTEGER,
  exclusions TEXT NOT NULL DEFAULT '',
  -- JSON array of Instagram handles to find lookalikes of.
  lookalikes TEXT NOT NULL DEFAULT '[]',
  creator_count INTEGER,
  budget_usd REAL,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
