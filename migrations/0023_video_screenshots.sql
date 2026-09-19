-- Insights screenshots affiliates upload as proof of views (trial reels and other posts whose
-- view count isn't public). Images live in R2 (SKETCHES bucket, key video-screenshots/<id>).
-- See CONTRACT.md §7.
CREATE TABLE IF NOT EXISTS video_screenshots (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  reported_views INTEGER CHECK (reported_views >= 0),  -- what the affiliate says the screenshot shows
  note TEXT,
  uploaded_at TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_screenshots_video ON video_screenshots(video_id, uploaded_at);
