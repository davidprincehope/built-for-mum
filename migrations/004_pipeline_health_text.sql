-- 004_pipeline_health_text.sql — allow TEXT cursors (gmail_history_id, expirations) alongside timestamps
-- pipeline_health.value was TIMESTAMPTZ but gmail cursors are TEXT (historyId numeric string, epoch millis).
-- Alter to TEXT so same KV table can store both; existing TIMESTAMPTZ values cast to TEXT via ISO.
ALTER TABLE pipeline_health ALTER COLUMN value TYPE TEXT USING value::TEXT;
