-- Instagram connections (CONTRACT.md §8). An affiliate links their Instagram Professional
-- account once; the Worker then reads view counts for their own posts, including trial reels,
-- whose counts aren't public anywhere else.
--
-- This does NOT bring back v3's automated polling. Nothing here prices a week or touches
-- earnings. The numbers land in video_api_views as a SUGGESTION that pre-fills the weekly
-- entry box, and a human still saves every priced week (CONTRACT.md §3).
CREATE TABLE IF NOT EXISTS creator_instagram_connections (
  creator_id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  username TEXT,
  access_token_encrypted TEXT NOT NULL,   -- AES-GCM under AFFILIATE_ENCRYPTION_KEY, never returned to any browser
  token_expires_at TEXT,                  -- long-lived tokens last ~60 days and are refreshed by cron
  scopes TEXT,
  connected_at TEXT NOT NULL,
  last_refreshed_at TEXT,
  last_synced_at TEXT,
  last_error TEXT,                        -- set when a refresh or sync fails, so staff can tell the affiliate to reconnect
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_connections_user ON creator_instagram_connections(ig_user_id);

-- The latest number the API reported for a video. One row per video, overwritten on each sync.
-- Read-only as far as pay is concerned: view_snapshots stays the only thing that prices anything.
CREATE TABLE IF NOT EXISTS video_api_views (
  video_id TEXT PRIMARY KEY,
  ig_media_id TEXT,
  views INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  fetched_at TEXT NOT NULL,
  error TEXT,                             -- e.g. the reel was deleted, or the media id no longer matches
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_api_views_fetched ON video_api_views(fetched_at);
