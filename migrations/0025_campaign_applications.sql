-- Campaign applications (CONTRACT.md §9, v8). A campaign can have a public application page; staff
-- review applications here, and approving one creates (or matches) the creator and adds them to the
-- campaign. Additive only: nothing existing is renamed or dropped.

-- ── Campaigns: the application page's settings ──
ALTER TABLE campaigns ADD COLUMN application_enabled INTEGER NOT NULL DEFAULT 0 CHECK (application_enabled IN (0, 1));
ALTER TABLE campaigns ADD COLUMN public_slug TEXT
  CHECK (public_slug IS NULL OR (length(public_slug) BETWEEN 3 AND 60 AND public_slug NOT GLOB '*[^a-z0-9-]*'));
ALTER TABLE campaigns ADD COLUMN public_headline TEXT NOT NULL DEFAULT '';
-- Public. campaigns.brief stays private and is never served on the application page.
ALTER TABLE campaigns ADD COLUMN public_pitch TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN brand_name TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN promo_url TEXT NOT NULL DEFAULT '';
-- 0 = the site refuses to be framed, so the page shows promo_image_url in a fallback card instead.
ALTER TABLE campaigns ADD COLUMN promo_embed INTEGER NOT NULL DEFAULT 1 CHECK (promo_embed IN (0, 1));
ALTER TABLE campaigns ADD COLUMN promo_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN application_questions TEXT NOT NULL DEFAULT '[]';   -- JSON Question[], max 10
ALTER TABLE campaigns ADD COLUMN application_seats INTEGER CHECK (application_seats IS NULL OR application_seats > 0);
ALTER TABLE campaigns ADD COLUMN application_closes_at TEXT;                          -- YYYY-MM-DD, inclusive
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_public_slug ON campaigns(public_slug) WHERE public_slug IS NOT NULL;

-- Existing campaigns get the default question pack too (new ones get it on create), so any campaign is
-- shareable the moment its page is switched on. Keep in sync with DEFAULT_QUESTIONS in worker/campaigns.js.
UPDATE campaigns SET application_questions = '[{"id":"fit","label":"What would your first video for this look like?","type":"long_text","required":true,"help":"A sentence or two on the hook or angle you''d use.","options":[],"max_length":600},{"id":"posted_similar","label":"Have you posted for a brand or product before?","type":"boolean","required":false,"help":"","options":[],"max_length":null},{"id":"best_video","label":"Link to your best-performing video","type":"url","required":false,"help":"Any platform. It doesn''t have to be sponsored.","options":[],"max_length":null},{"id":"typical_views","label":"Typical views on a recent video","type":"number","required":false,"help":"A rough number is fine.","options":[],"max_length":null},{"id":"start_when","label":"When could you post your first video?","type":"select","required":true,"help":"","options":["This week","Next week","Within a month"],"max_length":null}]'
  WHERE application_questions = '[]';

-- ── Example videos on the page. Never tracked, never paid, and separate from `videos`. ──
CREATE TABLE IF NOT EXISTS campaign_example_videos (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  platform_video_id TEXT NOT NULL,
  embed_url TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, platform, platform_video_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_example_videos_campaign ON campaign_example_videos(campaign_id, sort_order);

-- ── Creators: the company-wide referral side ──
-- 8 chars of Crockford base32 without vowels, minted the first time a creator is put on a campaign.
ALTER TABLE creators ADD COLUMN ref_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_ref_code ON creators(ref_code) WHERE ref_code IS NOT NULL;
-- Who brought them in, company-wide and set once. Per-campaign uplines stay on campaign_affiliates.upline_id.
ALTER TABLE creators ADD COLUMN referred_by_creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL;
ALTER TABLE creators ADD COLUMN referred_at TEXT;
CREATE INDEX IF NOT EXISTS idx_creators_referred_by ON creators(referred_by_creator_id);

-- ── Applications. Not creators: nothing here shows in Creators, campaign_affiliates, or earnings until approved. ──
CREATE TABLE IF NOT EXISTS campaign_applications (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'approved', 'declined', 'withdrawn')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,                                -- lowercased
  phone TEXT NOT NULL DEFAULT '',
  phone_e164 TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  tiktok TEXT NOT NULL DEFAULT '',
  youtube TEXT NOT NULL DEFAULT '',
  portfolio_url TEXT NOT NULL DEFAULT '',
  platforms TEXT NOT NULL DEFAULT '[]',
  audience_size TEXT NOT NULL DEFAULT '' CHECK (audience_size IN ('', 'under_5k', '5k_25k', '25k_100k', '100k_500k', '500k_plus')),
  posting_cadence TEXT NOT NULL DEFAULT '' CHECK (posting_cadence IN ('', '1_2_week', '3_5_week', '6_plus_week', 'not_sure')),
  niches TEXT NOT NULL DEFAULT '[]',
  why TEXT NOT NULL DEFAULT '',
  answers TEXT NOT NULL DEFAULT '{}',
  ref_code TEXT,                                      -- exactly what was on the link
  referred_by_creator_id TEXT,                        -- resolved at submit time
  creator_id TEXT,
  campaign_affiliate_id TEXT,
  consent INTEGER NOT NULL DEFAULT 0 CHECK (consent = 1),
  age_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (age_confirmed = 1),
  utm TEXT NOT NULL DEFAULT '{}',
  page_url TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',                   -- sha256(ip + AFFILIATE_ENCRYPTION_KEY); the raw IP is never stored
  review_notes TEXT NOT NULL DEFAULT '',
  decline_reason TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (referred_by_creator_id) REFERENCES creators(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE SET NULL,
  FOREIGN KEY (campaign_affiliate_id) REFERENCES campaign_affiliates(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_applications_email ON campaign_applications(campaign_id, email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_campaign_applications_status ON campaign_applications(campaign_id, status, submitted_at);
-- Rate limiting looks back one hour by IP hash and by email.
CREATE INDEX IF NOT EXISTS idx_campaign_applications_ip ON campaign_applications(ip_hash, submitted_at);
CREATE INDEX IF NOT EXISTS idx_campaign_applications_rate_email ON campaign_applications(email COLLATE NOCASE, submitted_at);
