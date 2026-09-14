-- Internal creator prospecting, review, and AI-assisted ranking.
-- All profile data is supplied by authenticated CRM users; no social scraping or actions.

CREATE TABLE IF NOT EXISTS influencer_leads (
  id TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handle TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  profile_url TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  niche TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  follower_count INTEGER,
  average_views INTEGER,
  engagement_rate REAL,
  bio TEXT NOT NULL DEFAULT '',
  recent_post_notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Ready to Review','Shortlisted','Contacted','Replied','Not a Fit','Archived')),
  ai_fit_score INTEGER,
  ai_confidence TEXT,
  ai_recommendation TEXT,
  ai_strengths TEXT NOT NULL DEFAULT '[]',
  ai_concerns TEXT NOT NULL DEFAULT '[]',
  ai_reason TEXT NOT NULL DEFAULT '',
  ai_missing_information TEXT NOT NULL DEFAULT '[]',
  ai_analyzed_at TEXT,
  ai_model TEXT NOT NULL DEFAULT '',
  ai_input_hash TEXT NOT NULL DEFAULT '',
  ai_state TEXT NOT NULL DEFAULT 'idle',
  ai_error TEXT NOT NULL DEFAULT '',
  last_reviewed_at TEXT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_influencer_leads_handle
  ON influencer_leads(handle) WHERE handle <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_influencer_leads_profile
  ON influencer_leads(profile_url) WHERE profile_url <> '';
CREATE INDEX IF NOT EXISTS idx_influencer_leads_status_created
  ON influencer_leads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_influencer_leads_score
  ON influencer_leads(ai_fit_score DESC);

CREATE TABLE IF NOT EXISTS influencer_lead_notes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES influencer_leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_influencer_lead_notes_lead
  ON influencer_lead_notes(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ideal_creator_profiles (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  brand_product TEXT NOT NULL DEFAULT '',
  target_customer TEXT NOT NULL DEFAULT '',
  desired_niches TEXT NOT NULL DEFAULT '',
  desired_locations TEXT NOT NULL DEFAULT '',
  follower_min INTEGER,
  follower_max INTEGER,
  content_style TEXT NOT NULL DEFAULT '',
  deal_type TEXT NOT NULL DEFAULT '',
  exclusions TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO ideal_creator_profiles (id) VALUES ('default');
