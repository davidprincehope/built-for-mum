-- 001_transactions.sql — transactions ledger (Phase 1 tracer)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  transaction_reference TEXT,
  transaction_date DATE NOT NULL,
  transaction_time TIME,
  sender_name TEXT,
  sender_account TEXT,
  description TEXT,
  branch TEXT,
  available_balance NUMERIC(14,2),
  bank TEXT NOT NULL DEFAULT 'Zenith Bank',
  email_message_id TEXT NOT NULL UNIQUE,
  email_auth_result TEXT NOT NULL,
  raw_email TEXT,
  matched_receipt_id UUID NULL,
  matched_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_transaction_date ON transactions (transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions (created_at);
