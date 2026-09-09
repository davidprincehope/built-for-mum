-- 002_suspicious_emails.sql — quarantine for auth-failed mail
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS suspicious_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  subject TEXT,
  auth_result TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suspicious_created_at ON suspicious_emails (created_at);
