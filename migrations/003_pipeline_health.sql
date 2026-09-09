-- 003_pipeline_health.sql — single-row heartbeat KV (FR-1.11)
CREATE TABLE IF NOT EXISTS pipeline_health (
  key TEXT PRIMARY KEY,
  value TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- seed heartbeat row so staleness checker has a value to read on first boot
INSERT INTO pipeline_health (key, value, updated_at)
VALUES ('last_zenith_email_processed_at', NULL, now())
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
