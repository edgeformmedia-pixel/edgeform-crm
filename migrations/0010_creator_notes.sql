-- Creators can be added by hand (no form submission), carry follower counts per platform,
-- and keep a dated log of notes instead of one notes box.

CREATE TABLE creators_new (
  id TEXT PRIMARY KEY,
  lead_id TEXT UNIQUE,                   -- NULL for creators added by hand
  submission_id TEXT,
  contact_id TEXT,
  source TEXT NOT NULL DEFAULT 'form',   -- form | manual
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
  instagram_followers INTEGER,           -- NULL = not entered yet
  tiktok_followers INTEGER,
  youtube_followers INTEGER,
  followers_updated_at TEXT,
  audience_size TEXT NOT NULL DEFAULT '',
  audience_tier INTEGER NOT NULL DEFAULT 0,
  niches TEXT NOT NULL DEFAULT '[]',
  location TEXT NOT NULL DEFAULT '',
  content_types TEXT NOT NULL DEFAULT '[]',
  media_kit TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,
  form_status TEXT NOT NULL DEFAULT 'partial',
  roster_status TEXT NOT NULL DEFAULT 'applied',
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

INSERT INTO creators_new (id, lead_id, submission_id, contact_id, source, created_at, updated_at, name, email, phone, phone_e164,
  instagram, tiktok, youtube, other_social, audience_size, audience_tier, niches, location, content_types, media_kit, consent, form_status, roster_status)
SELECT id, lead_id, submission_id, contact_id, 'form', created_at, updated_at, name, email, phone, phone_e164,
  instagram, tiktok, youtube, other_social, audience_size, audience_tier, niches, location, content_types, media_kit, consent, form_status, roster_status
FROM creators;

-- The old single notes box becomes the first note, dated when the creator was last updated.
-- Staged without a foreign key so dropping the old table can't cascade into it.
CREATE TABLE creator_notes_import AS
SELECT lower(hex(randomblob(16))) id, id creator_id, notes body, updated_at created_at FROM creators WHERE trim(notes) <> '';

DROP TABLE creators;
ALTER TABLE creators_new RENAME TO creators;

CREATE TABLE IF NOT EXISTS creator_notes (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  body TEXT NOT NULL,
  user_id TEXT,
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

INSERT INTO creator_notes (id, creator_id, body, author, created_at)
SELECT id, creator_id, body, '', created_at FROM creator_notes_import;
DROP TABLE creator_notes_import;

CREATE INDEX IF NOT EXISTS idx_creators_roster ON creators(roster_status, form_status);
CREATE INDEX IF NOT EXISTS idx_creator_notes_creator ON creator_notes(creator_id, created_at);
