-- Affiliate system (see CONTRACT.md §2): campaigns on marketing operations, affiliates assigned to them,
-- submitted videos with polled view counts, payouts, portal logins, and an audit log.
-- Money is integer cents, timestamps ISO TEXT, booleans 0/1, arrays JSON TEXT.

-- ── Creators: portal + payout fields ──
ALTER TABLE creators ADD COLUMN payout_method TEXT CHECK (payout_method IN ('paypal', 'wise', 'bank', 'manual'));
ALTER TABLE creators ADD COLUMN payout_details_encrypted TEXT;   -- AES-GCM (AFFILIATE_ENCRYPTION_KEY), never returned
ALTER TABLE creators ADD COLUMN payout_details_last4 TEXT;
ALTER TABLE creators ADD COLUMN tax_form_received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE creators ADD COLUMN country TEXT;                    -- ISO-2
ALTER TABLE creators ADD COLUMN portal_last_login_at TEXT;

-- Email is the portal login key. Checked for duplicates before this migration (none).
CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_email ON creators(email COLLATE NOCASE) WHERE email <> '';

-- ── Campaigns ──
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  start_date TEXT,
  end_date TEXT,
  platforms_allowed TEXT NOT NULL DEFAULT '["tiktok","instagram","youtube"]',
  default_cpm_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_cpm_rate_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  max_payout_per_video_cents INTEGER CHECK (max_payout_per_video_cents >= 0),
  max_payout_per_affiliate_cents INTEGER CHECK (max_payout_per_affiliate_cents >= 0),
  total_budget_cents INTEGER CHECK (total_budget_cents >= 0),
  view_tracking_window_days INTEGER NOT NULL DEFAULT 30 CHECK (view_tracking_window_days > 0),
  min_views_to_qualify INTEGER CHECK (min_views_to_qualify >= 0),
  requires_video_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_video_approval IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_operation ON campaigns(operation_id, created_at);

CREATE TABLE IF NOT EXISTS campaign_channels (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('email', 'affiliate')),
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, type),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaign_affiliates (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  cpm_rate_override_cents INTEGER CHECK (cpm_rate_override_cents >= 0),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'removed')),
  invited_at TEXT,
  joined_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, creator_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_affiliates_creator ON campaign_affiliates(creator_id, status);

-- ── OAuth connections (TikTok / Instagram) ──
CREATE TABLE IF NOT EXISTS creator_platform_connections (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  platform_user_id TEXT NOT NULL,
  platform_username TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  connected_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (creator_id, platform),
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

-- ── Videos ──
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  campaign_affiliate_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  submitted_url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  platform_video_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  thumbnail_url TEXT,
  caption TEXT,
  posted_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected', 'removed', 'locked')),
  rejection_reason TEXT,
  submitted_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  tracking_ends_at TEXT NOT NULL,
  locked_at TEXT,
  latest_view_count INTEGER NOT NULL DEFAULT 0,
  billable_views INTEGER NOT NULL DEFAULT 0,
  earned_cents INTEGER NOT NULL DEFAULT 0,
  last_fetched_at TEXT,
  next_fetch_at TEXT,
  consecutive_fetch_failures INTEGER NOT NULL DEFAULT 0,
  UNIQUE (platform, platform_video_id),
  FOREIGN KEY (campaign_affiliate_id) REFERENCES campaign_affiliates(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_campaign ON videos(campaign_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_videos_creator ON videos(creator_id, status);
CREATE INDEX IF NOT EXISTS idx_videos_fetch ON videos(status, next_fetch_at);

-- Append-only: never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS view_snapshots (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  view_count INTEGER NOT NULL,
  like_count INTEGER,
  comment_count INTEGER,
  source TEXT NOT NULL CHECK (source IN ('api', 'oauth', 'scraper', 'manual')),
  fetched_at TEXT NOT NULL,
  raw_response TEXT,
  entered_by TEXT,
  note TEXT,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (entered_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_view_snapshots_video ON view_snapshots(video_id, fetched_at);

CREATE TABLE IF NOT EXISTS video_flags (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('handle_mismatch', 'fetch_failed', 'video_unavailable', 'suspicious_spike')),
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_video_flags_open ON video_flags(resolved_at, created_at);
CREATE INDEX IF NOT EXISTS idx_video_flags_video ON video_flags(video_id, type);

-- ── Payouts (recorded here; money is always sent by a person, never by the app) ──
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'failed')),
  payment_method TEXT CHECK (payment_method IN ('paypal', 'wise', 'bank', 'manual')),
  payment_reference TEXT,
  paid_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES creators(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_payouts_creator ON payouts(creator_id, created_at);

CREATE TABLE IF NOT EXISTS payout_line_items (
  id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL,
  video_id TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  billable_views INTEGER NOT NULL,
  cpm_rate_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  FOREIGN KEY (payout_id) REFERENCES payouts(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);
CREATE INDEX IF NOT EXISTS idx_payout_line_items_payout ON payout_line_items(payout_id);

-- ── Portal auth (separate from staff sessions) ──
CREATE TABLE IF NOT EXISTS affiliate_login_tokens (
  token_hash TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_affiliate_login_tokens_creator ON affiliate_login_tokens(creator_id, created_at);

CREATE TABLE IF NOT EXISTS affiliate_sessions (
  token_hash TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_affiliate_sessions_creator ON affiliate_sessions(creator_id, expires_at);

-- ── Audit log ──
CREATE TABLE IF NOT EXISTS affiliate_audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'creator', 'system')),
  actor_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_affiliate_audit_entity ON affiliate_audit_log(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_audit_created ON affiliate_audit_log(created_at);
