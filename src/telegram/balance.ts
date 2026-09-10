import { getPool } from '../db/pool';
import { escapeHtml } from './sendMessage';

async function withTimeout<T>(p: Promise<T>, ms = 5000, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    const result = await Promise.race([p, timeout]);
    return result;
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildBalanceReply(): Promise<{ text: string; replyMarkup?: unknown }> {
  const pool = getPool();
  try {
    const fallback = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as import('pg').QueryResult<{
      available_balance: string | null;
      current_balance: string | null;
      amount: string | null;
      currency: string | null;
      sender_name: string | null;
      transaction_date: string | null;
      transaction_time: string | null;
      description: string | null;
    }>;
    const result = await withTimeout(
      pool.query<{
        available_balance: string | null;
        current_balance: string | null;
        amount: string | null;
        currency: string | null;
        sender_name: string | null;
        transaction_date: string | null;
        transaction_time: string | null;
        description: string | null;
      }>(
        `SELECT available_balance::text, current_balance::text, amount::text, currency, sender_name, transaction_date::text, transaction_time::text, description FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1`,
      ),
      5000,
      fallback,
    );
    const rows = (result as { rows?: Array<Record<string, string | null>> }).rows ?? [];
    if (!rows || rows.length === 0) {
      return { text: '📭 No transactions yet' };
    }
    const r = rows[0] as Record<string, string | null>;
    const availRaw = r.available_balance;
    const currRaw = r.current_balance;
    const avail = availRaw != null && availRaw !== '' ? escapeHtml(availRaw) : '—';
    const curr = currRaw != null && currRaw !== '' ? escapeHtml(currRaw) : '—';
    const amount = r.amount != null && r.amount !== '' ? escapeHtml(r.amount) : '—';
    const currency = r.currency ? escapeHtml(r.currency) : 'NGN';
    const sender = r.sender_name ? escapeHtml(r.sender_name) : '—';
    const date = r.transaction_date ? escapeHtml(r.transaction_date) : '';
    const time = r.transaction_time ? escapeHtml(r.transaction_time) : '';
    const lagosTime = time ? time.slice(0, 5) : '';
    const lastLine = date ? `${amount} ${currency} from ${sender} ${date} ${lagosTime}`.trim() + ' Africa/Lagos' : `${amount} ${currency} from ${sender}`;
    let text = `💰 <b>Balance</b>\nAvailable: ${avail}\nCurrent: ${curr}\nLast: ${lastLine}`;
    if (text.length > 4000) text = text.slice(0, 3990) + '\n… truncated';
    return { text };
  } catch {
    return { text: '⚠️ Balance unavailable — DB error' };
  }
}
