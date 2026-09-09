import { getPool } from './pool';

export async function getHealth(key: string): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ value: unknown }>('SELECT value FROM pipeline_health WHERE key = $1', [key]);
  if (rows.length === 0) return null;
  const v = rows[0].value as string | Date | null;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function setHealth(key: string, value: string | Date): Promise<void> {
  const pool = getPool();
  const val = value instanceof Date ? value.toISOString() : String(value);
  // value column is TEXT after migration 004 — no ::timestamptz cast, supports both ISO timestamps and cursor strings
  await pool.query(
    `INSERT INTO pipeline_health (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, val],
  );
}

export async function getLastProcessedAt(): Promise<Date | null> {
  const v = await getHealth('last_zenith_email_processed_at');
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export async function setLastProcessedAt(date: Date = new Date()): Promise<void> {
  await setHealth('last_zenith_email_processed_at', date);
}

export async function getHistoryId(): Promise<string | null> {
  return getHealth('gmail_history_id');
}

export async function setHistoryId(id: string): Promise<void> {
  await setHealth('gmail_history_id', id);
}

export async function getWatchExpiration(): Promise<string | null> {
  return getHealth('gmail_watch_expiration');
}

export async function setWatchExpiration(expiration: string): Promise<void> {
  await setHealth('gmail_watch_expiration', expiration);
}

export async function getPollAfter(): Promise<string | null> {
  return getHealth('gmail_poll_after');
}

export async function setPollAfter(value: string): Promise<void> {
  await setHealth('gmail_poll_after', value);
}

export async function getPollAfterMs(): Promise<number | null> {
  const v = await getPollAfter();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function setPollAfterMs(ms: number): Promise<void> {
  await setPollAfter(String(ms));
}
