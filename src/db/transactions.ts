import pg from 'pg';
import { getPool } from './pool';
import { logger } from '../observability/logger';
import { capRawEmail } from '../zenith/validation';

export interface TransactionRow {
  amount: number | string;
  currency: string;
  transaction_reference: string;
  transaction_date: string; // YYYY-MM-DD
  transaction_time?: string | null;
  sender_name: string;
  sender_account: string;
  description?: string;
  branch?: string;
  available_balance?: number | string | null;
  bank?: string;
  email_message_id: string;
  email_auth_result: string;
  raw_email?: string | null;
}

export { capRawEmail };

async function logCappedRawEmailMeta(original: string | null | undefined, capped: string | null, emailMessageId: string) {
  if (!original || !capped) return;
  const origBytes = Buffer.byteLength(original, 'utf-8');
  const cappedBytes = Buffer.byteLength(capped, 'utf-8');
  if (cappedBytes !== origBytes || capped.includes('[image stripped]') || capped.includes('[truncated')) {
    logger.debug({ email_message_id: emailMessageId, origBytes, cappedBytes, stripped: cappedBytes < origBytes }, 'raw_email capped/stripped');
  }
}

export async function insertTransactionAtomically(row: TransactionRow): Promise<'inserted' | 'duplicate'> {
  const pool = getPool();
  // Resilience T-5.2: Postgres unavailable — lightweight retry 2x with 100ms backoff only for insert path, not infinite loop
  let client: pg.PoolClient | null = null;
  let connectAttempts = 0;
  while (true) {
    try {
      client = await pool.connect();
      break;
    } catch (e) {
      connectAttempts++;
      if (connectAttempts > 2) throw e;
      logger.warn({ attempt: connectAttempts, err: e }, 'pg connect failed — retry 100ms');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    await client.query('BEGIN');

    const cappedRaw = capRawEmail(row.raw_email ?? null);
    await logCappedRawEmailMeta(row.raw_email ?? null, cappedRaw, row.email_message_id);

    // Normalize amount/balance to string for pg NUMERIC
    const amountStr = String(row.amount);
    const balanceStr = row.available_balance != null ? String(row.available_balance) : null;

    const res = await client.query(
      `INSERT INTO transactions
        (amount, currency, transaction_reference, transaction_date, transaction_time, sender_name, sender_account, description, branch, available_balance, bank, email_message_id, email_auth_result, raw_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Zenith Bank',$11,$12,$13)
       ON CONFLICT (email_message_id) DO NOTHING
       RETURNING id`,
      [
        amountStr,
        row.currency,
        row.transaction_reference,
        row.transaction_date,
        row.transaction_time ?? null,
        row.sender_name,
        row.sender_account,
        row.description ?? null,
        row.branch ?? null,
        balanceStr,
        row.email_message_id,
        row.email_auth_result,
        cappedRaw,
      ],
    );

    if (res.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.debug({ email_message_id: row.email_message_id }, 'transaction duplicate — ON CONFLICT');
      return 'duplicate';
    }

    await client.query(
      `INSERT INTO pipeline_health (key, value, updated_at) VALUES ('last_zenith_email_processed_at', now(), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );

    await client.query('COMMIT');
    logger.info({ email_message_id: row.email_message_id, reference: row.transaction_reference }, 'transaction inserted');
    return 'inserted';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
