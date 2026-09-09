import { getPool } from './pool';
import { capRawEmail } from '../zenith/validation';

export interface SuspiciousRow {
  email_message_id: string;
  from_address: string;
  subject: string | null;
  auth_result: string;
  reason: string;
  raw_email?: string | null;
}

export async function insertSuspicious(row: SuspiciousRow): Promise<'inserted' | 'duplicate'> {
  const pool = getPool();
  const capped = capRawEmail(row.raw_email ?? null);
  const res = await pool.query(
    `INSERT INTO suspicious_emails (email_message_id, from_address, subject, auth_result, reason, raw_email)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email_message_id) DO NOTHING
     RETURNING id`,
    [row.email_message_id, row.from_address, row.subject, row.auth_result, row.reason, capped],
  );
  if (res.rowCount === 0) return 'duplicate';
  return 'inserted';
}
