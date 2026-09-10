import { parse, isValid, parseISO } from 'date-fns';
import { getPool } from '../db/pool';
import { escapeHtml } from './sendMessage';
import { extractSender } from '../zenith/sender';

async function withTimeout<T>(p: Promise<T>, ms = 5000, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([p, timeout]); } catch { return fallback; } finally { if (timer) clearTimeout(timer); }
}

export function parseLagosDateRange(args: string[]): { from: string; to: string } | { error: string } {
  const normalized: string[] = [];
  for (const a of args ?? []) {
    if (a) normalized.push(a.trim());
  }
  if (normalized.length === 0) {
    return { error: 'no-args' } as unknown as { error: string };
  }
  if (normalized.length === 1) {
    // single date unsupported, require pair
    return { error: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
  }
  if (normalized.length === 2) {
    const from = parseDateArg(normalized[0]);
    const to = parseDateArg(normalized[1]);
    if (!from || !to) return { error: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
    if (from > to) return { error: 'Invalid range — from date is after to date' };
    return { from, to };
  }
  // >2 args invalid
  return { error: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
}

function parseDateArg(value: string): string | null {
  const v = value.trim();
  // DD/MM/YYYY
  if (v.includes('/')) {
    const d = parse(v, 'dd/MM/yyyy', new Date());
    if (!isValid(d)) return null;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  // YYYY-MM-DD
  try {
    const d = parseISO(v);
    if (!isValid(d)) return null;
    // validate format exactly YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    return v;
  } catch { return null; }
}

export async function handleHistoryWithRange(args: string[], opts?: { limit?: number; offset?: number }): Promise<{ text: string; replyMarkup?: unknown }> {
  const pool = getPool();
  let from: string | null = null;
  let to: string | null = null;
  let limit = opts?.limit ?? 10;
  let offset = opts?.offset ?? 0;

  limit = Math.max(1, Math.min(50, Math.floor(limit)));
  offset = Math.max(0, Math.floor(offset));

  // Handle callback_data encoded as "/history from to limit offset"
  // args may already be split; if no args -> default last 5
  if (!args || args.length === 0) {
    limit = 5;
    // default: recent without date filter
    try {
      const result = await withTimeout(
        pool.query<{ amount: string; currency: string; transaction_date: string; transaction_time: string; description: string; sender_name: string; branch: string | null; available_balance: string | null }>(
          `SELECT amount::text AS amount, currency, transaction_date::text AS transaction_date, transaction_time::text AS transaction_time, description, sender_name, branch, available_balance::text AS available_balance FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        5000,
        { rows: [] } as unknown as import('pg').QueryResult<never>,
      );
      const rows = (result as { rows: Array<Record<string, string>> }).rows ?? [];
      if (!rows.length) return { text: '📭 <b>History</b>\n<i>No transactions yet</i>' };
      return formatRows(rows as unknown as Array<{ amount: string; currency: string; transaction_date: string; transaction_time: string; description: string; sender_name: string }>, { from: '', to: '', total: rows.length, limit, offset, isDefault: true });
    } catch {
      return { text: '⚠️ History unavailable — DB error' };
    }
  }

  // detect 4-arg pagination form: from to limit offset
  if (args.length === 4 && /^\d+$/.test(args[2]) && /^\d+$/.test(args[3])) {
    const maybeFrom = parseDateArg(args[0]);
    const maybeTo = parseDateArg(args[1]);
    if (maybeFrom && maybeTo) {
      from = maybeFrom; to = maybeTo;
      limit = Math.max(1, Math.min(50, Number(args[2])));
      offset = Math.max(0, Number(args[3]));
    }
  }

  if (!from || !to) {
    if (args.length === 2) {
      const parsed = parseLagosDateRange(args);
      if ('error' in parsed) {
        return { text: escapeHtml(parsed.error) };
      }
      from = (parsed as { from: string }).from;
      to = (parsed as { from: string; to: string }).to;
    } else if (args.length !== 4) {
      // try to parse first two as dates; if fails return error
      const parsed = parseLagosDateRange(args.slice(0, 2));
      if ('error' in parsed) {
        const err = (parsed as { error: string }).error;
        if (err !== 'no-args') return { text: escapeHtml(err) };
      }
      // fallback to unfiltered if no date args? treat as invalid
      if (!from) return { text: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
    }
  }

  if (!from || !to) return { text: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };

  try {
    const countResult = await withTimeout(
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM transactions WHERE transaction_date::date BETWEEN $1::date AND $2::date`,
        [from, to],
      ),
      5000,
      { rows: [{ count: '0' }] } as unknown as import('pg').QueryResult<{ count: string }>,
    );
    const total = Number((countResult as { rows: Array<{ count: string }> }).rows[0]?.count ?? '0');

    const rowsResult = await withTimeout(
      pool.query<{
        amount: string;
        currency: string;
        transaction_date: string;
        transaction_time: string;
        description: string;
        sender_name: string;
        branch: string | null;
        available_balance: string | null;
      }>(
        `SELECT amount::text AS amount, currency, transaction_date::text AS transaction_date, transaction_time::text AS transaction_time, description, sender_name, branch, available_balance::text AS available_balance FROM transactions WHERE transaction_date::date BETWEEN $1::date AND $2::date ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT $3 OFFSET $4`,
        [from, to, limit, offset],
      ),
      5000,
      { rows: [] } as unknown as import('pg').QueryResult<never>,
    );
    const rows = (rowsResult as { rows: Array<Record<string, string>> }).rows ?? [];
    if (!rows.length) {
      return { text: `📭 <b>History</b> ${escapeHtml(from)} → ${escapeHtml(to)}\n<i>No transactions in range</i>\nTotal: 0 in range` };
    }
    return formatRows(rows as unknown as Array<{ amount: string; currency: string; transaction_date: string; transaction_time: string; description: string; sender_name: string }>, { from, to, total, limit, offset, isDefault: false });
  } catch {
    return { text: '⚠️ History unavailable — DB error' };
  }
}

function formatRows(
  rows: Array<{ amount: string; currency: string; transaction_date: string; transaction_time: string; description: string; sender_name: string }>,
  ctx: { from: string; to: string; total: number; limit: number; offset: number; isDefault: boolean },
): { text: string; replyMarkup?: unknown } {
  const header = ` # │ Amount      │ Sender          │ Date`;
  const divider = `───┼─────────────┼─────────────────┼────────────`;
  const lines = rows.map((r, i) => {
    const num = String(ctx.offset + i + 1).padStart(2, ' ');
    const amt = `${r.amount} ${r.currency}`.padEnd(11, ' ');
    const senderRaw = extractSender(r.description).senderName || r.sender_name || '';
    const sender = senderRaw.substring(0, 17).padEnd(17, ' ');
    const date = (r.transaction_date ?? '').slice(0, 10);
    return `${num} │ ${amt} │ ${sender} │ ${date}`;
  });
  const table = [header, divider, ...lines].join('\n');
  const totalLine = ctx.isDefault
    ? `Total: ${rows.length} shown`
    : `Total: ${ctx.total} in range${ctx.total > rows.length ? ', use narrower dates or /export' : ''}`;
  const rangeHeader = ctx.isDefault
    ? `💳 <b>Recent Transactions</b> <i>(last ${rows.length})</i>`
    : `💳 <b>History</b> <i>${escapeHtml(ctx.from)} → ${escapeHtml(ctx.to)}</i>`;

  const text = [
    rangeHeader,
    '━━━━━━━━━━━━━━━━━━━━',
    `<pre>${escapeHtml(table)}</pre>`,
    `<i>${escapeHtml(totalLine)}</i>`,
  ].join('\n');

  let out = text;
  if (out.length > 4000) out = out.slice(0, 3990) + '\n… truncated';

  const hasNext = ctx.offset + ctx.limit < ctx.total;
  const hasPrev = ctx.offset > 0;
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (hasPrev) {
    const prevOff = Math.max(0, ctx.offset - ctx.limit);
    navRow.push({ text: '⬅️ Prev', callback_data: `/history ${ctx.from} ${ctx.to} ${ctx.limit} ${prevOff}` });
  }
  if (hasNext) {
    const nextOff = ctx.offset + ctx.limit;
    navRow.push({ text: 'Next ➡️', callback_data: `/history ${ctx.from} ${ctx.to} ${ctx.limit} ${nextOff}` });
  }
  if (navRow.length) buttons.push(navRow);

  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;
  return { text: out, replyMarkup };
}
