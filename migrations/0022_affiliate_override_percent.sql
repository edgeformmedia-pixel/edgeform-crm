-- Upline overrides move from "the CPM difference" to "a percentage of what the downline gets paid".
-- The percentage is paid on top of the downline's earnings (it never comes out of them). Stored in basis
-- points (500 = 5%) so fractional percents like 5.5% stay exact integers. See CONTRACT.md §6 (v5).

-- Campaign-wide default. Existing campaigns start at 5%.
ALTER TABLE campaigns ADD COLUMN default_override_bps INTEGER NOT NULL DEFAULT 500 CHECK (default_override_bps >= 0 AND default_override_bps <= 10000);

-- Per-person override: what THIS person earns on their downline. NULL = the campaign default.
ALTER TABLE campaign_affiliates ADD COLUMN override_bps INTEGER CHECK (override_bps >= 0 AND override_bps <= 10000);

-- The percentage each override row was priced at. NULL on rows priced under the old CPM-difference rule
-- (those keep their cpm_diff_cents); new rows store cpm_diff_cents = 0.
ALTER TABLE override_earnings ADD COLUMN override_bps INTEGER;
ALTER TABLE payout_override_items ADD COLUMN override_bps INTEGER;
