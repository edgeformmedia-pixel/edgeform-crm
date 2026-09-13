-- Intake form v2: six inquiry types, upsert by browser leadId, creator roster, contact dedupe.

ALTER TABLE submissions ADD COLUMN lead_id TEXT;
ALTER TABLE submissions ADD COLUMN form_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions ADD COLUMN inquiry_type TEXT NOT NULL DEFAULT 'website';
ALTER TABLE submissions ADD COLUMN inquiry_label TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN phone_e164 TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN phone_country TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
ALTER TABLE submissions ADD COLUMN page_url TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN referrer TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN utm TEXT NOT NULL DEFAULT '{}';
-- Sales workflow stage, separate from the form's partial/complete status.
ALTER TABLE submissions ADD COLUMN stage TEXT NOT NULL DEFAULT 'new';
ALTER TABLE submissions ADD COLUMN contact_id TEXT;
ALTER TABLE submissions ADD COLUMN completed_at TEXT;
-- Everything else the form sent, so new questions are never lost.
ALTER TABLE submissions ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_lead ON submissions(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(inquiry_type, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_contact ON submissions(contact_id);

ALTER TABLE contacts ADD COLUMN phone_e164 TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_e164);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- Creators are talent, not sales leads.
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL UNIQUE,
  submission_id TEXT NOT NULL,
  contact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  phone_e164 TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  tiktok TEXT NOT NULL DEFAULT '',
  youtube TEXT NOT NULL DEFAULT '',
  other_social TEXT NOT NULL DEFAULT '',
  audience_size TEXT NOT NULL DEFAULT '',
  audience_tier INTEGER NOT NULL DEFAULT 0,
  niches TEXT NOT NULL DEFAULT '[]',
  location TEXT NOT NULL DEFAULT '',
  content_types TEXT NOT NULL DEFAULT '[]',
  media_kit TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,
  form_status TEXT NOT NULL DEFAULT 'partial',
  roster_status TEXT NOT NULL DEFAULT 'applied',
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_creators_roster ON creators(roster_status, form_status);
