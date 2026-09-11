import { parse, isValid, parseISO } from 'date-fns';
import { getPool } from '../db/pool';
import { escapeHtml } from './sendMessage';
import { extractSender } from '../zenith/sender';
import { logger } from '../observability/logger';
import { formatNaira } from './naira';

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
    return { error: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
  }
  if (normalized.length === 2) {
    const from = parseDateArg(normalized[0]);
    const to = parseDateArg(normalized[1]);
    if (!from || !to) return { error: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
    if (from > to) return { error: 'Invalid range — from date is after to date' };
    return { from, to };
  }
  return { error: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
}

function parseDateArg(value: string): string | null {
  const v = value.trim();
  if (v.includes('/')) {
    const d = parse(v, 'dd/MM/yyyy', new Date());
    if (!isValid(d)) return null;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  try {
    const d = parseISO(v);
    if (!isValid(d)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    return v;
  } catch { return null; }
}

type TxRow = {
  amount: string;
  currency: string;
  transaction_date: string;
  transaction_time: string | null;
  description: string;
  sender_name: string;
  branch: string | null;
  available_balance: string | null;
};

function renderTxCard(row: TxRow): string {
  const cleaned = extractSender(row.description).senderName || row.sender_name || '—';
  const via = row.description.includes('NIP') ? 'NIP' : row.description.includes('KUDA') ? 'KUDA' : 'Zenith';
  const datePart = escapeHtml((row.transaction_date ?? '').slice(0, 10));
  const timePart = row.transaction_time ? ` <code>${escapeHtml(row.transaction_time.slice(0, 5))}</code>` : '';
  const branchLine = row.branch ? `🔖 <b>Branch:</b> <code>${escapeHtml(row.branch)}</code>` : null;
  const balanceLine = row.available_balance ? `💰 <b>Balance:</b> <code>${escapeHtml(formatNaira(row.available_balance))}</code>` : null;
  const descCleaned = escapeHtml(cleaned).slice(0, 60);
  const viaEsc = escapeHtml(via);
  const amountLine = escapeHtml(formatNaira(row.amount));
  const lines = [
    `💳 <b>${amountLine}</b>`,
    `👤 <b>Sender:</b> <code>${escapeHtml(cleaned)}</code>`,
    `📅 <b>Date:</b> <code>${datePart}</code>${timePart} <i>Africa/Lagos</i>`,
    `🏦 <b>via ${viaEsc}</b>`,
    branchLine,
    `📝 <i>${descCleaned} via ${viaEsc}</i>`,
    balanceLine,
  ].filter(Boolean).join('\n');
  return lines;
}

export async function handleHistoryWithRange(args: string[], opts?: { limit?: number; offset?: number }): Promise<{ text: string; replyMarkup?: unknown }> {
  const pool = getPool();
  let from: string | null = null;
  let to: string | null = null;
  let limit = opts?.limit ?? 5;
  let offset = opts?.offset ?? 0;

  limit = Math.max(1, Math.min(50, Math.floor(limit)));
  offset = Math.max(0, Math.floor(offset));

  if (!args || args.length === 0) {
    limit = Math.min(limit, 5);
    try {
      const result = await withTimeout(
        pool.query<TxRow>(
          `SELECT amount::text AS amount, currency, transaction_date::text AS transaction_date, transaction_time::text AS transaction_time, description, sender_name, branch, available_balance::text AS available_balance FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        5000,
        { rows: [] } as unknown as import('pg').QueryResult<never>,
      );
      const rows = (result as { rows: Array<TxRow> }).rows ?? [];
      if (!rows.length) return { text: '📭 <b>History</b>\n<i>No transactions yet</i>' };
      let total = rows.length;
      if (rows.length === limit) {
        try {
          const cnt = await withTimeout(
            pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM transactions`),
            2000,
            { rows: [{ count: String(rows.length) }] } as unknown as import('pg').QueryResult<{ count: string }>,
          );
          total = Number((cnt as { rows: Array<{ count: string }> }).rows[0]?.count ?? String(rows.length));
        } catch { total = rows.length; }
      }
      return formatRows(rows, { from: '', to: '', total, limit, offset, isDefault: true });
    } catch {
      return { text: '⚠️ History unavailable — DB error' };
    }
  }

  // pagination for default recent: "/history 5 10" => limit offset
  if (args.length === 2 && /^\d+$/.test(args[0]) && /^\d+$/.test(args[1])) {
    limit = Math.max(1, Math.min(50, Number(args[0])));
    offset = Math.max(0, Number(args[1]));
    try {
      const result = await withTimeout(
        pool.query<TxRow>(
          `SELECT amount::text AS amount, currency, transaction_date::text AS transaction_date, transaction_time::text AS transaction_time, description, sender_name, branch, available_balance::text AS available_balance FROM transactions ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        5000,
        { rows: [] } as unknown as import('pg').QueryResult<never>,
      );
      const rows2 = (result as { rows: Array<TxRow> }).rows ?? [];
      if (!rows2.length) return { text: '📭 <b>History</b>\n<i>No more transactions</i>' };
      let total2 = rows2.length + offset;
      try {
        const cnt = await withTimeout(
          pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM transactions`),
          2000,
          { rows: [{ count: String(total2) }] } as unknown as import('pg').QueryResult<{ count: string }>,
        );
        total2 = Number((cnt as { rows: Array<{ count: string }> }).rows[0]?.count ?? String(total2));
      } catch {}
      return formatRows(rows2, { from: '', to: '', total: total2, limit, offset, isDefault: true });
    } catch {
      return { text: '⚠️ History unavailable — DB error' };
    }
  }

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
      if (!('error' in parsed)) {
        from = (parsed as { from: string; to: string }).from;
        to = (parsed as { from: string; to: string }).to;
      } else {
        const hasExplicitDates = args.some((a) => /^\d{4}-\d{2}-\d{2}$/.test(a) || /^\d{2}\/\d{2}\/\d{4}$/.test(a));
        if (hasExplicitDates) {
          return { text: escapeHtml((parsed as { error: string }).error) };
        }
        const joined = args.join(' ').trim();
        const hasWords = /[A-Za-z]/.test(joined);
        if (hasWords) {
          let aiFrom: string | null = null;
          let aiTo: string | null = null;
          try {
            const { openRouterSearchIntent } = await import('./search');
            const intent = await openRouterSearchIntent(joined);
            if (intent?.fromDate && intent?.toDate) {
              const vFrom = intent.fromDate;
              const vTo = intent.toDate;
              if (/^\d{4}-\d{2}-\d{2}$/.test(vFrom) && /^\d{4}-\d{2}-\d{2}$/.test(vTo) && vFrom <= vTo) {
                aiFrom = vFrom; aiTo = vTo;
              } else {
                logger.warn({ vFrom, vTo }, 'history NL AI dates invalid — fallback to local');
              }
            } else if (intent == null) {
              logger.warn('history NL AI returned null — fallback to local');
            }
          } catch (e) {
            const msg = (e as Error)?.message ?? '';
            if (/OPENROUTER_429|429/.test(msg)) logger.warn({ err: e }, 'history NL AI 429 — fallback to local');
            else logger.warn({ err: e }, 'history NL AI failed — fallback to local');
          }
          if (aiFrom && aiTo) {
            from = aiFrom; to = aiTo;
          } else {
            try {
              const { localKeywordIntent } = await import('./search');
              const local = localKeywordIntent(joined);
              if (local.fromDate && local.toDate && /^\d{4}-\d{2}-\d{2}$/.test(local.fromDate) && /^\d{4}-\d{2}-\d{2}$/.test(local.toDate) && local.fromDate <= local.toDate) {
                from = local.fromDate; to = local.toDate;
              } else {
                return { text: 'Invalid date — try DD/MM/YYYY or \'last week\'' };
              }
            } catch {
              return { text: 'Invalid date — try DD/MM/YYYY or \'last week\'' };
            }
          }
        } else {
          return { text: escapeHtml((parsed as { error: string }).error) };
        }
      }
    } else if (args.length === 1) {
      const joined = args.join(' ').trim();
      if (/[A-Za-z]/.test(joined)) {
        let aiFrom: string | null = null;
        let aiTo: string | null = null;
        try {
          const { openRouterSearchIntent } = await import('./search');
          const intent = await openRouterSearchIntent(joined);
          if (intent?.fromDate && intent?.toDate && /^\d{4}-\d{2}-\d{2}$/.test(intent.fromDate) && /^\d{4}-\d{2}-\d{2}$/.test(intent.toDate) && intent.fromDate <= intent.toDate) {
            aiFrom = intent.fromDate; aiTo = intent.toDate;
          }
        } catch {}
        if (aiFrom && aiTo) { from = aiFrom; to = aiTo; }
        else {
          try {
            const { localKeywordIntent } = await import('./search');
            const local = localKeywordIntent(joined);
            if (local.fromDate && local.toDate) { from = local.fromDate; to = local.toDate; }
            else return { text: 'Invalid date — try DD/MM/YYYY or \'last week\'' };
          } catch { return { text: 'Invalid date — try DD/MM/YYYY or \'last week\'' }; }
        }
      } else {
        const parsed = parseLagosDateRange(args.slice(0, 2));
        if ('error' in parsed) {
          const err = (parsed as { error: string }).error;
          if (err !== 'no-args') return { text: escapeHtml(err) };
        }
        if (!from) return { text: 'Invalid date — use DD/MM/YYYY or YYYY-MM-DD Africa/Lagos' };
      }
    } else if (args.length !== 4) {
      const parsed = parseLagosDateRange(args.slice(0, 2));
      if ('error' in parsed) {
        const err = (parsed as { error: string }).error;
        if (err !== 'no-args') return { text: escapeHtml(err) };
      }
      const joined = args.join(' ').trim();
      if (!from && /[A-Za-z]/.test(joined)) {
        try {
          const { openRouterSearchIntent } = await import('./search');
          const intent = await openRouterSearchIntent(joined);
          if (intent?.fromDate && intent?.toDate && /^\d{4}-\d{2}-\d{2}$/.test(intent.fromDate) && /^\d{4}-\d{2}-\d{2}$/.test(intent.toDate) && intent.fromDate <= intent.toDate) {
            from = intent.fromDate; to = intent.toDate;
          } else {
            const { localKeywordIntent } = await import('./search');
            const local = localKeywordIntent(joined);
            if (local.fromDate && local.toDate) { from = local.fromDate; to = local.toDate; }
          }
        } catch {}
      }
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
      pool.query<TxRow>(
        `SELECT amount::text AS amount, currency, transaction_date::text AS transaction_date, transaction_time::text AS transaction_time, description, sender_name, branch, available_balance::text AS available_balance FROM transactions WHERE transaction_date::date BETWEEN $1::date AND $2::date ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT $3 OFFSET $4`,
        [from, to, limit, offset],
      ),
      5000,
      { rows: [] } as unknown as import('pg').QueryResult<never>,
    );
    const rows = (rowsResult as { rows: Array<TxRow> }).rows ?? [];
    if (!rows.length) {
      return { text: `📭 <b>History</b> ${escapeHtml(from)} → ${escapeHtml(to)}\n<i>No transactions in range</i>\nTotal: 0 in range` };
    }
    return formatRows(rows, { from, to, total, limit, offset, isDefault: false });
  } catch {
    return { text: '⚠️ History unavailable — DB error' };
  }
}

function formatRows(
  rows: Array<TxRow>,
  ctx: { from: string; to: string; total: number; limit: number; offset: number; isDefault: boolean },
): { text: string; replyMarkup?: unknown } {
  const cards = rows.map((r) => renderTxCard(r));
  const divider = '\n━━━━━━━━━━━━\n';
  let joined = cards.join(divider);

  const rangeHeader = ctx.isDefault
    ? `💳 <b>Recent Transactions</b> <i>(last ${rows.length})</i>`
    : `💳 <b>History</b> <i>${escapeHtml(ctx.from)} → ${escapeHtml(ctx.to)}</i>`;

  const totalLine = ctx.isDefault
    ? `Total: ${ctx.total} shown`
    : `Total: ${ctx.total} in range`;

  const headerWithDiv = `${rangeHeader}\n━━━━━━━━━━━━━━━━━━━━\n`;
  let text = headerWithDiv + joined + `\n<i>${escapeHtml(totalLine)}</i>`;

  // 4096 safe: if exceeds 3800, drop last whole cards then append truncation hint — never slice mid-card
  if (text.length > 3800) {
    let kept = [...cards];
    while (kept.length > 1 && (headerWithDiv + kept.join(divider) + `\n<i>${escapeHtml(totalLine)}</i>`).length > 3800) {
      kept.pop();
    }
    const dropped = cards.length - kept.length;
    joined = kept.join(divider);
    const suffix = dropped > 0 ? `\n… + ${dropped} more — tap Next 5` : '';
    text = headerWithDiv + joined + suffix + `\n<i>${escapeHtml(totalLine)}</i>`;
  }

  if (text.length > 4000) text = text.slice(0, 3990) + '\n… truncated';

  const hasNext = ctx.offset + ctx.limit < ctx.total;
  const hasPrev = ctx.offset > 0;
  const buttons: Array<Array<{ text: string; callback_data: string; style?: string }>> = [];
  const navRow: Array<{ text: string; callback_data: string; style?: string }> = [];
  if (hasPrev) {
    const prevOff = Math.max(0, ctx.offset - ctx.limit);
    if (ctx.isDefault) {
      navRow.push({ text: '⬅️ Prev', callback_data: `/history 5 ${prevOff}` });
    } else {
      navRow.push({ text: '⬅️ Prev', callback_data: `/history ${ctx.from} ${ctx.to} 5 ${prevOff}` });
    }
  }
  if (hasNext) {
    const nextOff = ctx.offset + ctx.limit;
    if (ctx.isDefault) {
      navRow.push({ text: 'Next 5 ➡️', callback_data: `/history 5 ${nextOff}`, style: 'primary' });
    } else {
      navRow.push({ text: 'Next 5 ➡️', callback_data: `/history ${ctx.from} ${ctx.to} 5 ${nextOff}`, style: 'primary' });
    }
  }
  if (navRow.length) buttons.push(navRow);
  buttons.push([{ text: '← Back to menu', callback_data: '/help' }]);

  const replyMarkup = { inline_keyboard: buttons };
  return { text, replyMarkup };
}
