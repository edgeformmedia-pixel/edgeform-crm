-- Diagnostics for discovery runs, so zero-result or failed searches can be explained later.
-- JSON columns are capped by the Worker. API keys and bearer tokens are redacted before storage.

ALTER TABLE influencer_discovery_runs ADD COLUMN effective_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN response_id TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN response_status TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN incomplete_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN api_error TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN search_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE influencer_discovery_runs ADD COLUMN candidate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN rejections TEXT NOT NULL DEFAULT '[]';
ALTER TABLE influencer_discovery_runs ADD COLUMN unconfirmed TEXT NOT NULL DEFAULT '[]';
ALTER TABLE influencer_discovery_runs ADD COLUMN search_queries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE influencer_discovery_runs ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN source_domains TEXT NOT NULL DEFAULT '{}';
ALTER TABLE influencer_discovery_runs ADD COLUMN source_urls TEXT NOT NULL DEFAULT '[]';
ALTER TABLE influencer_discovery_runs ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencer_discovery_runs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
