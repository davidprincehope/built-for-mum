import { getPool } from '../db/pool';
import { escapeHtml } from './sendMessage';
import { formatNaira } from './naira';

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
      branch: string | null;
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
        branch: string | null;
      }>(
        `SELECT available_balance::text, current_balance::text, amount::text, currency, sender_name, transaction_date::text, transaction_time::text, description, branch FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1`,
      ),
      5000,
      fallback,
    );
    const rows = (result as { rows?: Array<Record<string, string | null>> }).rows ?? [];
    if (!rows || rows.length === 0) {
      return {
        text: '📭 <b>Balance</b>\n<i>No transactions yet</i>\nCredits to 999****999 will appear here once delivered. Use <code>/status</code> to check the pipeline.',
        replyMarkup: { inline_keyboard: [[{ text: '📊 Check status', callback_data: '/status' }], [{ text: '← Back to menu', callback_data: '/help' }]] },
      };
    }
    const r = rows[0] as Record<string, string | null>;
    const availRaw = r.available_balance;
    const currRaw = r.current_balance;
    const avail = escapeHtml(formatNaira(availRaw));
    const curr = escapeHtml(formatNaira(currRaw));
    const amountNaira = formatNaira(r.amount);
    const amount = escapeHtml(amountNaira);
    const sender = r.sender_name ? escapeHtml(r.sender_name) : '—';
    const date = r.transaction_date ? escapeHtml(r.transaction_date.slice(0, 10)) : '';
    const time = r.transaction_time ? escapeHtml(r.transaction_time.slice(0, 5)) : '';
    const branch = r.branch ? escapeHtml(r.branch) : '';

    // 7d summary: count, sum, avg — parameterised and timeout-safe
    const summaryFallback = { rows: [{ cnt: '0', sum: '0' }] } as unknown as import('pg').QueryResult<{ cnt: string; sum: string }>;
    const summaryRes = await withTimeout(
      pool.query<{ cnt: string; sum: string }>(
        `SELECT COUNT(*)::text AS cnt, COALESCE(SUM(amount),0)::text AS sum FROM transactions WHERE transaction_date >= CURRENT_DATE - INTERVAL '7 days'`,
      ),
      3000,
      summaryFallback,
    );
    const summaryRow = (summaryRes as { rows: Array<{ cnt: string; sum: string }> }).rows[0] ?? { cnt: '0', sum: '0' };
    const cnt = summaryRow.cnt ?? '0';
    const sum = summaryRow.sum ?? '0';
    const cntNum = Number(cnt) || 0;
    const sumNum = Number(String(sum).replace(/,/g, '')) || 0;
    const avgNum = cntNum > 0 ? sumNum / cntNum : 0;
    const sumFormatted = escapeHtml(formatNaira(sum));
    const avgFormatted = escapeHtml(formatNaira(avgNum));

    const lines: string[] = [];
    lines.push('💰 <b>Balance</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Available: ${avail} • Current: ${curr} • Last: ${date}${time ? ' ' + time : ''}`);
    lines.push('');
    lines.push('📅 <b>Last Transaction</b>');
    if (date) {
      lines.push(`  💳 <code>${amount}</code> from <code>${sender}</code>`);
      lines.push(`  📅 <code>${date}</code>${time ? ` <code>${time}</code>` : ''} <i>Africa/Lagos</i>`);
      if (branch) lines.push(`  🔖 <code>${branch}</code>`);
    } else {
      lines.push(`  💳 <code>${amount}</code> from <code>${sender}</code>`);
    }
    lines.push('');
    lines.push(`7d: ${escapeHtml(cnt)} tx, total ${sumFormatted}, avg ${avgFormatted}`);

    let text = lines.join('\n');
    if (text.length > 4000) text = text.slice(0, 3990) + '\n… truncated';
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🔄 Refresh balance', callback_data: '/balance', style: 'primary' },
          { text: '📜 History', callback_data: '/history' },
        ],
        [
          { text: '🔍 Search', callback_data: '/search' },
          { text: '← Back to menu', callback_data: '/help' },
        ],
      ],
    };
    return { text, replyMarkup };
  } catch {
    return { text: '⚠️ <b>Balance unavailable</b>\n<i>DB error — check /logs</i>' };
  }
}
