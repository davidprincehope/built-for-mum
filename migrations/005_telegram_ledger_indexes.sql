-- 005_telegram_ledger_indexes: pg_trgm GIN for ILIKE search + B-tree amount
-- Idempotent, safe to re-run. Existing idx_transactions_transaction_date already covers date range.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_transactions_sender_trgm ON transactions USING GIN (sender_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_description_trgm ON transactions USING GIN (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_amount ON transactions (amount);
COMMIT;
