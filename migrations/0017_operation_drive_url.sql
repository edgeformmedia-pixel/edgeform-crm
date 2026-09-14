-- A shared Google Drive folder per operation, linked from its details.

ALTER TABLE operations ADD COLUMN drive_url TEXT NOT NULL DEFAULT '';
