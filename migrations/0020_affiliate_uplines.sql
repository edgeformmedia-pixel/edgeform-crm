-- Affiliate uplines and ranks (MLM). Per campaign, each affiliate can have an upline in the same campaign
-- and a rank: top_creator > master > general > rookie. An upline earns the difference between their CPM
-- and the highest CPM below them in the chain, on every view in their downline (never negative).

ALTER TABLE campaign_affiliates ADD COLUMN upline_id TEXT REFERENCES campaign_affiliates(id) ON DELETE SET NULL;
ALTER TABLE campaign_affiliates ADD COLUMN rank TEXT NOT NULL DEFAULT 'rookie' CHECK (rank IN ('top_creator', 'master', 'general', 'rookie'));
CREATE INDEX IF NOT EXISTS idx_campaign_affiliates_upline ON campaign_affiliates(upline_id);

-- Override earnings per (video, upline). Recomputed with the campaign like videos.earned_cents.
-- Status follows the video: locked = earned, approved = pending.
CREATE TABLE IF NOT EXISTS override_earnings (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_affiliate_id TEXT NOT NULL,          -- the upline who earns it
  creator_id TEXT NOT NULL,                     -- the upline's creator
  source_campaign_affiliate_id TEXT NOT NULL,   -- who posted the video
  depth INTEGER NOT NULL,                       -- 1 = direct upline
  cpm_diff_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE (video_id, campaign_affiliate_id),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_affiliate_id) REFERENCES campaign_affiliates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_override_earnings_affiliate ON override_earnings(campaign_affiliate_id);
CREATE INDEX IF NOT EXISTS idx_override_earnings_campaign ON override_earnings(campaign_id);
CREATE INDEX IF NOT EXISTS idx_override_earnings_creator ON override_earnings(creator_id);

-- Overrides on a payout, alongside payout_line_items (which stay one row per video for the poster).
CREATE TABLE IF NOT EXISTS payout_override_items (
  id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  campaign_affiliate_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  source_campaign_affiliate_id TEXT NOT NULL,
  billable_views INTEGER NOT NULL,
  cpm_diff_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE (video_id, campaign_affiliate_id),
  FOREIGN KEY (payout_id) REFERENCES payouts(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);
CREATE INDEX IF NOT EXISTS idx_payout_override_items_payout ON payout_override_items(payout_id);
