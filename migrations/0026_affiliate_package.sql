-- Affiliate package (CONTRACT.md §10, v9): a per-campaign video bank (links on any platform) and a
-- written affiliate guide. Shown to affiliates on the campaign, never on the public application page.
-- Additive only.
ALTER TABLE campaigns ADD COLUMN affiliate_guide TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN video_bank TEXT NOT NULL DEFAULT '[]';   -- JSON [{ "url", "title" }], max 100
