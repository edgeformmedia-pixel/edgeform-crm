-- Background discovery: runs are started, polled, and imported across requests and cron invocations.
-- status: starting → running → importing → complete | failed | cancelled

ALTER TABLE influencer_discovery_runs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN completed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN polled_at TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';
-- JSON shown in the Find Influencers window: summary, usage, plan, and diagnostics.
ALTER TABLE influencer_discovery_runs ADD COLUMN result TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_influencer_discovery_runs_user_status
  ON influencer_discovery_runs(user_id, status, created_at DESC);
