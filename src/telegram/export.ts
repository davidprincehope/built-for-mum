import { getPool } from '../db/pool';
import { logger } from '../observability/logger';
import { escapeHtml } from './sendMessage';
import { parseLagosDateRange } from './history';

function getBotToken(): string {
  const direct = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (direct) return direct;
  const alt = process.env.TELEGRAM_BOT_TOKEN_ALT ?? '';
  if (alt) return alt;
  const alertUrl = process.env.ALERT_WEBHOOK_URL ?? '';
  const m = alertUrl.match(/api\.telegram\.org\/bot([^\/\s]+)/);
  if (m) return m[1];
  return '';
}

function csvQuote(value: string | null | undefined): string {
  const s = value ?? '';
  const escaped = String(s).replace(/"/g, '""');
  return `"${escaped}"`;
}

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

export async function sendTelegramDocument(
  chatId: string | number,
  csvBuffer: Buffer,
  filename: string,
  caption: string,
): Promise<void> {
  const token = getBotToken();
  if (!token) {
    logger.warn({ chatId: String(chatId) }, 'sendTelegramDocument skipped — no token');
    throw new Error('Bot not configured — missing TELEGRAM_BOT_TOKEN');
  }
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1024));
  // Blob with csvBuffer
  const blob = new Blob([csvBuffer], { type: 'text/csv' });
  form.set('document', blob, filename);

  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const res = await fetch(url, {
    method: 'POST',
    body: form as unknown as any,
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || json.ok === false) {
    const desc = String(json.description ?? `status ${res.status}`);
    logger.warn({ chatId: String(chatId), status: res.status, desc: desc.slice(0, 300) }, 'sendTelegramDocument non-ok');
    throw new Error(`sendDocument failed: ${desc}`);
  }
}

export async function handleExport(
  args: string[],
  chatId: string | number,
): Promise<{ text: string }> {
  const pool = getPool();

  let from: string | null = null;
  let to: string | null = null;
  let isFiltered = false;

  if (!args || args.length === 0) {
    // no args -> last 50 without filter
    isFiltered = false;
  } else if (args.length === 1 || args.length === 2) {
    const parsed = parseLagosDateRange(args);
    if ('error' in parsed) {
      const err = (parsed as { error: string }).error;
      if (err !== 'no-args') {
        return { text: escapeHtml(err) };
      }
    } else {
      from = (parsed as { from: string; to: string }).from;
      to = (parsed as { from: string; to: string }).to;
      isFiltered = true;
    }
    // if still not filtered but args length 1, return error
    if (!isFiltered && args.length > 0) {
      // Invalid single date case already returns error above, but fallback
      return { text: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
    }
  } else {
    return { text: 'Usage: /export [from to] e.g. /export 01/09/2026 10/09/2026 or /export 2026-09-01 2026-09-10' };
  }

  type TxRow = {
    amount: string;
    currency: string;
    transaction_date: string;
    transaction_time: string;
    sender_name: string;
    description: string;
    branch: string | null;
    available_balance: string | null;
  };

  let rows: TxRow[] = [];
  try {
    if (!isFiltered) {
      const result = await withTimeout(
        pool.query<TxRow>(
          `SELECT amount::text,currency,transaction_date::text,transaction_time::text,sender_name,description,branch,available_balance::text FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 50`,
        ),
        5000,
        { rows: [] } as unknown as import('pg').QueryResult<TxRow>,
      );
      rows = (result as { rows: TxRow[] }).rows ?? [];
      if (rows.length === 0) {
        return { text: '📭 <b>Export</b>\n<i>No transactions to export</i>' };
      }
      // derive filename from row range
      const lastDate = rows[rows.length - 1]?.transaction_date ?? 'start';
      const firstDate = rows[0]?.transaction_date ?? 'end';
      from = lastDate.slice(0, 10);
      to = firstDate.slice(0, 10);
    } else {
      const result = await withTimeout(
        pool.query<TxRow>(
          `SELECT amount::text,currency,transaction_date::text,transaction_time::text,sender_name,description,branch,available_balance::text FROM transactions WHERE transaction_date::date BETWEEN $1::date AND $2::date ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 100`,
          [from, to],
        ),
        5000,
        { rows: [] } as unknown as import('pg').QueryResult<TxRow>,
      );
      rows = (result as { rows: TxRow[] }).rows ?? [];
      if (rows.length === 0) {
        return { text: `📭 <b>Export</b> ${escapeHtml(from!)} → ${escapeHtml(to!)}\n<i>No transactions in range</i>` };
      }
    }

    // Build CSV quoted rows
    const header = ['amount', 'currency', 'date', 'time', 'sender', 'description', 'branch', 'balance'].map(csvQuote).join(',');
    const csvLines = [header];
    for (const r of rows) {
      const cols = [
        csvQuote(r.amount),
        csvQuote(r.currency),
        csvQuote(r.transaction_date),
        csvQuote(r.transaction_time),
        csvQuote(r.sender_name),
        csvQuote(r.description),
        csvQuote(r.branch),
        csvQuote(r.available_balance),
      ];
      csvLines.push(cols.join(','));
    }
    const csvText = csvLines.join('\n');
    const csvBuffer = Buffer.from(csvText, 'utf-8');
    const filename = `transactions-${from}-to-${to}.csv`;
    const caption = `📄 CSV ${rows.length} rows ${from} to ${to} • Africa/Lagos`;

    try {
      await sendTelegramDocument(chatId, csvBuffer, filename, caption);
      logger.info({ chatId: String(chatId), from, to, count: rows.length }, 'export sent via sendDocument');
      return { text: `📄 Sent ${rows.length} rows as ${escapeHtml(filename)}` };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      logger.warn({ err: e, chatId: String(chatId) }, 'sendTelegramDocument failed fallback');
      // fallback to truncated inline preview if document failed? return error reply
      return { text: `⚠️ Export failed — ${escapeHtml(msg.slice(0, 300))}` };
    }
  } catch (err) {
    logger.warn({ err }, 'handleExport DB error');
    return { text: '⚠️ Export unavailable — DB error' };
  }
}

export async function handleDuplicates(): Promise<{ text: string; replyMarkup?: unknown }> {
  const pool = getPool();
  try {
    const result = await withTimeout(
      pool.query<{
        amount: string;
        currency: string;
        transaction_date: string;
        c: string;
      }>(
        `SELECT amount::text, currency, transaction_date::text, COUNT(*)::text AS c FROM transactions GROUP BY amount, currency, transaction_date HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC, transaction_date DESC LIMIT 10`,
      ),
      5000,
      { rows: [] } as unknown as import('pg').QueryResult<{ amount: string; currency: string; transaction_date: string; c: string }>,
    );
    const rows = (result as { rows: Array<{ amount: string; currency: string; transaction_date: string; c: string }> }).rows ?? [];
    if (!rows || rows.length === 0) {
      return { text: '✅ <b>Duplicates</b>\n<i>No duplicates — each amount+date unique</i>' };
    }
    const header = ` # │ Amount      │ Date       │ Count`;
    const divider = `───┼─────────────┼────────────┼──────`;
    const lines = rows.map((r, i) => {
      const num = String(i + 1).padStart(2, ' ');
      const amt = `${r.amount} ${r.currency}`.padEnd(11, ' ');
      const date = (r.transaction_date ?? '').slice(0, 10).padEnd(10, ' ');
      const cnt = r.c.padStart(5, ' ');
      return `${num} │ ${amt} │ ${date} │ ${cnt}`;
    });
    const table = [header, divider, ...lines].join('\n');
    let text = `🔎 <b>Duplicates</b> <i>(top ${rows.length})</i>\n━━━━━━━━━━━━━━━━━━━━\n<pre>${escapeHtml(table)}</pre>`;
    if (text.length > 4000) text = text.slice(0, 4000);
    return { text };
  } catch (err) {
    logger.warn({ err }, 'handleDuplicates failed');
    return { text: '⚠️ Duplicates unavailable — DB error' };
  }
}

export async function handleSummary(): Promise<{ text: string; replyMarkup?: unknown }> {
  const pool = getPool();
  try {
    // today counts/sum via CURRENT_DATE in DB timezone (DB is UTC, but transaction_date is DATE Lagos? We use CURRENT_DATE as DB's date - acceptable)
    // For accuracy we query using CURRENT_DATE in SQL
    const queries = await Promise.all([
      withTimeout(
        pool.query<{ count: string; sum: string | null }>(
          `SELECT COUNT(*)::text AS count, COALESCE(SUM(amount),0)::text AS sum FROM transactions WHERE transaction_date = CURRENT_DATE`,
        ),
        5000,
        { rows: [{ count: '0', sum: '0' }] } as unknown as import('pg').QueryResult<{ count: string; sum: string }>,
      ),
      withTimeout(
        pool.query<{ count: string; sum: string | null }>(
          `SELECT COUNT(*)::text AS count, COALESCE(SUM(amount),0)::text AS sum FROM transactions WHERE transaction_date >= CURRENT_DATE - INTERVAL '7 days'`,
        ),
        5000,
        { rows: [{ count: '0', sum: '0' }] } as unknown as import('pg').QueryResult<{ count: string; sum: string }>,
      ),
      withTimeout(
        pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM transactions`),
        5000,
        { rows: [{ count: '0' }] } as unknown as import('pg').QueryResult<{ count: string }>,
      ),
      withTimeout(
        pool.query<{
          amount: string;
          currency: string;
          transaction_date: string;
          transaction_time: string;
          sender_name: string;
          available_balance: string | null;
        }>(
          `SELECT amount::text, currency, transaction_date::text, transaction_time::text, sender_name, available_balance::text FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1`,
        ),
        5000,
        { rows: [] } as unknown as import('pg').QueryResult<never>,
      ),
    ]);

    const todayRow = (queries[0] as { rows: Array<{ count: string; sum: string }> }).rows[0] ?? { count: '0', sum: '0' };
    const weekRow = (queries[1] as { rows: Array<{ count: string; sum: string }> }).rows[0] ?? { count: '0', sum: '0' };
    const totalRow = (queries[2] as { rows: Array<{ count: string }> }).rows[0] ?? { count: '0' };
    const lastRows = (queries[3] as { rows: Array<{ amount: string; currency: string; transaction_date: string; transaction_time: string; sender_name: string; available_balance: string | null }> }).rows ?? [];

    const todayCount = todayRow.count ?? '0';
    const todaySum = todayRow.sum ?? '0';
    const weekCount = weekRow.count ?? '0';
    const weekSum = weekRow.sum ?? '0';
    const totalCount = totalRow.count ?? '0';

    let lastLine: string;
    if (lastRows.length > 0) {
      const r = lastRows[0];
      const amt = escapeHtml(r.amount ?? '');
      const curr = escapeHtml(r.currency ?? 'NGN');
      const sender = escapeHtml((r.sender_name ?? '').substring(0, 22));
      const date = escapeHtml((r.transaction_date ?? '').slice(0, 10));
      const time = escapeHtml((r.transaction_time ?? '').slice(0, 5));
      const lagosDisplay = `${date} ${time} Africa/Lagos`;
      lastLine = `${amt} ${curr} from ${sender} • ${lagosDisplay}`;
      if (r.available_balance) lastLine += ` • Bal ${escapeHtml(r.available_balance)}`;
    } else {
      lastLine = '<i>No transactions yet</i>';
    }

    // Format with Lagos today string for header
    const lagosToday = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });
    let text = [
      `📊 <b>Summary</b> <i>${escapeHtml(lagosToday)} Africa/Lagos</i>`,
      '━━━━━━━━━━━━━━━━━━━━',
      `24h: <b>${escapeHtml(todayCount)}</b> • NGN ${escapeHtml(todaySum)}`,
      `7d: <b>${escapeHtml(weekCount)}</b> • NGN ${escapeHtml(weekSum)}`,
      `Total: <b>${escapeHtml(totalCount)}</b>`,
      `Last: ${lastLine}`,
    ].join('\n');
    if (text.length > 4000) text = text.slice(0, 4000);
    return { text };
  } catch (err) {
    logger.warn({ err }, 'handleSummary failed');
    return { text: '⚠️ Summary unavailable — DB error' };
  }
}
