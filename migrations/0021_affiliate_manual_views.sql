-- Retiring automated view polling (YouTube API / TikTok+Instagram OAuth / Apify) for manual weekly
-- entry. Earnings move from "one lump sum on total views when a video locks" to "priced per week on
-- the delta since the last entry, paid as it's computed." See CONTRACT.md §3 (v4).
--
-- videos.tracking_ends_at, videos.next_fetch_at, videos.consecutive_fetch_failures, and
-- campaigns.view_tracking_window_days are left in place but retired: the app stops reading and writing
-- them. Dropping them would require rebuilding both tables (SQLite can't ALTER a column referenced by a
-- CHECK constraint, which view_tracking_window_days has), which isn't worth the risk on a live database
-- for columns that cost nothing sitting unused.

-- OAuth is fully retired; these were third-party access/refresh tokens, not worth retaining once dead.
DROP TABLE IF EXISTS creator_platform_connections;

-- No more cron due-query.
DROP INDEX IF EXISTS idx_videos_fetch;

-- Every future row is a manual weekly entry. delta_views/earned_cents are set once and never revisited
-- once earned_cents is non-NULL ("priced"). Historical rows from the old automated system keep both
-- NULL, so they're simply invisible to the new earnings sweep — the videos they belong to keep whatever
-- earned_cents they already had, untouched, forever.
ALTER TABLE view_snapshots ADD COLUMN delta_views INTEGER;
ALTER TABLE view_snapshots ADD COLUMN earned_cents INTEGER;
CREATE INDEX IF NOT EXISTS idx_view_snapshots_unpriced ON view_snapshots(video_id)
  WHERE delta_views IS NOT NULL AND earned_cents IS NULL;

-- ── Rebuild the three payout-shape tables so the "unit of payment" moves from one-video-forever to
-- one-snapshot(week)-forever. Their old UNIQUE constraints (video_id [, campaign_affiliate_id]) can't be
-- altered in place in SQLite and would actively block the new multiple-weeks-per-video reality, so each
-- table is recreated with the same rows plus a nullable view_snapshot_id (NULL on pre-existing rows,
-- which predate the concept and are left exactly as they were).

CREATE TABLE override_earnings_new (
  id TEXT PRIMARY KEY,
  view_snapshot_id TEXT,
  video_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_affiliate_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  source_campaign_affiliate_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  cpm_diff_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE (view_snapshot_id, campaign_affiliate_id),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (view_snapshot_id) REFERENCES view_snapshots(id),
  FOREIGN KEY (campaign_affiliate_id) REFERENCES campaign_affiliates(id) ON DELETE CASCADE
);
INSERT INTO override_earnings_new (id, view_snapshot_id, video_id, campaign_id, campaign_affiliate_id, creator_id, source_campaign_affiliate_id, depth, cpm_diff_cents, amount_cents)
  SELECT id, NULL, video_id, campaign_id, campaign_affiliate_id, creator_id, source_campaign_affiliate_id, depth, cpm_diff_cents, amount_cents FROM override_earnings;
DROP TABLE override_earnings;
ALTER TABLE override_earnings_new RENAME TO override_earnings;
CREATE INDEX IF NOT EXISTS idx_override_earnings_affiliate ON override_earnings(campaign_affiliate_id);
CREATE INDEX IF NOT EXISTS idx_override_earnings_campaign ON override_earnings(campaign_id);
CREATE INDEX IF NOT EXISTS idx_override_earnings_creator ON override_earnings(creator_id);
CREATE INDEX IF NOT EXISTS idx_override_earnings_snapshot ON override_earnings(view_snapshot_id);

CREATE TABLE payout_line_items_new (
  id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL,
  view_snapshot_id TEXT,
  video_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  billable_views INTEGER NOT NULL,
  cpm_rate_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE (view_snapshot_id),
  FOREIGN KEY (payout_id) REFERENCES payouts(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (view_snapshot_id) REFERENCES view_snapshots(id)
);
INSERT INTO payout_line_items_new (id, payout_id, view_snapshot_id, video_id, campaign_id, billable_views, cpm_rate_cents, amount_cents)
  SELECT id, payout_id, NULL, video_id, campaign_id, billable_views, cpm_rate_cents, amount_cents FROM payout_line_items;
DROP TABLE payout_line_items;
ALTER TABLE payout_line_items_new RENAME TO payout_line_items;
CREATE INDEX IF NOT EXISTS idx_payout_line_items_payout ON payout_line_items(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_line_items_video ON payout_line_items(video_id);

CREATE TABLE payout_override_items_new (
  id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL,
  view_snapshot_id TEXT,
  video_id TEXT NOT NULL,
  campaign_affiliate_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  source_campaign_affiliate_id TEXT NOT NULL,
  billable_views INTEGER NOT NULL,
  cpm_diff_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE (view_snapshot_id, campaign_affiliate_id),
  FOREIGN KEY (payout_id) REFERENCES payouts(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (view_snapshot_id) REFERENCES view_snapshots(id)
);
INSERT INTO payout_override_items_new (id, payout_id, view_snapshot_id, video_id, campaign_affiliate_id, campaign_id, source_campaign_affiliate_id, billable_views, cpm_diff_cents, amount_cents)
  SELECT id, payout_id, NULL, video_id, campaign_affiliate_id, campaign_id, source_campaign_affiliate_id, billable_views, cpm_diff_cents, amount_cents FROM payout_override_items;
DROP TABLE payout_override_items;
ALTER TABLE payout_override_items_new RENAME TO payout_override_items;
CREATE INDEX IF NOT EXISTS idx_payout_override_items_payout ON payout_override_items(payout_id);
