import { getPool } from '../db/pool';
import { getHistoryId, getLastProcessedAt, getPollAfterMs, getWatchExpiration } from '../db/health';
import { checkStaleness } from '../observability/staleness';
import { logger } from '../observability/logger';
import { logRing } from './ringBuffer';
import { isRateLimited } from './rateLimit';
import { sendTelegramMessage, escapeHtml } from './sendMessage';
import { parseCommandText } from './webhook';

// --- helpers ---

function truncate(text: string, cap = 4000): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap - 20) + '\n… truncated';
}

function formatAge(date: Date | null): string {
  if (!date) return 'never';
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

// --- help ---

export function buildHelpReply(): string {
  return [
    '<b>PaymentVerificationBot — Admin Commands</b>',
    '',
    '/help — this message',
    '/status — worker health, DB counts, staleness, watch & poll state',
    '/health — alias for /status',
    '/history [n] — last n transactions (default 5, max 10)',
    '/suspicious [n] — last n suspicious emails (default 5, max 10)',
    '/logs [n] [level] — tail worker logs (default 20, max 50; levels: trace debug info warn error fatal)',
    '/poll — trigger Gmail poll sweep (cooldown 30s)',
    '/watch — re-register Gmail watch (cooldown 60s)',
    '',
    'Examples: /history 5  /logs 20 warn  /poll',
  ].join('\n');
}

// --- status/health ---

export async function buildStatusReply(): Promise<string> {
  const pool = getPool();

  const txCountP = withTimeout(
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM transactions').then((r) => r.rows[0]?.count ?? '?'),
    5000,
    '?',
  );
  const susCountP = withTimeout(
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM suspicious_emails').then((r) => r.rows[0]?.count ?? '?'),
    5000,
    '?',
  );
  const lastAtP = withTimeout(getLastProcessedAt().catch(() => null), 5000, null as Date | null);
  const watchExpP = withTimeout(getWatchExpiration().catch(() => null), 5000, null as string | null);
  const pollAfterP = withTimeout(getPollAfterMs().catch(() => null), 5000, null as number | null);
  const historyIdP = withTimeout(getHistoryId().catch(() => null), 5000, null as string | null);
  const staleP = withTimeout(checkStaleness({ now: new Date() }).catch(() => '?' as unknown as string), 5000, '?' as unknown as string);

  const [txCount, susCount, lastAt, watchExp, pollAfter, historyId, stale] = await Promise.all([
    txCountP,
    susCountP,
    lastAtP,
    watchExpP,
    pollAfterP,
    historyIdP,
    staleP,
  ]);

  const uptimeSec = process.uptime();
  const uptimeH = (uptimeSec / 3600).toFixed(1);
  const uptimeM = Math.floor(uptimeSec / 60);

  let lastTxLine: string;
  if (lastAt) {
    const iso = (lastAt as Date).toISOString();
    lastTxLine = `${escapeHtml(iso)} (${escapeHtml(formatAge(lastAt as Date))})`;
  } else {
    lastTxLine = 'never';
  }

  let watchLine: string;
  if (watchExp) {
    try {
      const expMs = Number(watchExp);
      if (Number.isFinite(expMs)) {
        const ttlMs = expMs - Date.now();
        const ttlH = (ttlMs / 3600000).toFixed(1);
        watchLine = `${escapeHtml(watchExp)} (ttl ${ttlH}h)`;
      } else {
        watchLine = escapeHtml(watchExp);
      }
    } catch {
      watchLine = escapeHtml(String(watchExp));
    }
  } else {
    watchLine = 'unknown';
  }

  const pollAfterStr = pollAfter != null ? String(pollAfter) : 'unknown';
  const historySlice = historyId ? escapeHtml((historyId as string).slice(0, 16)) + '…' : 'none';

  const lines = [
    `<b>Worker</b> up ${uptimeH}h (${uptimeM}m)  stale:${escapeHtml(String(stale))}`,
    `DB: ${escapeHtml(String(txCount))} tx  ${escapeHtml(String(susCount))} suspicious`,
    `last_tx: ${lastTxLine}`,
    `watch_exp: ${watchLine}  poll_after: ${escapeHtml(pollAfterStr)}`,
    `historyId: <code>${historySlice}</code>`,
  ];

  const out = lines.join('\n');
  return truncate(out, 4000);
}

// --- history ---

export async function handleHistory(rawLimit: number | string | undefined): Promise<string> {
  let n = Number(rawLimit ?? 5);
  if (!Number.isFinite(n)) n = 5;
  n = Math.max(1, Math.min(10, Math.floor(n)));

  const pool = getPool();
  try {
    const result = await withTimeout(
      pool.query<{
        amount: string;
        currency: string;
        transaction_reference: string;
        transaction_date: string;
        sender_name: string;
        created_at: string;
      }>(
        `SELECT amount::text AS amount, currency, transaction_reference, transaction_date::text AS transaction_date, sender_name, created_at::text AS created_at
         FROM transactions ORDER BY created_at DESC LIMIT $1`,
        [n],
      ),
      5000,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as import('pg').QueryResult<{ amount: string; currency: string; transaction_reference: string; transaction_date: string; sender_name: string; created_at: string }>,
    );
    const rows = (result as { rows: Array<{ amount: string; currency: string; transaction_reference: string; transaction_date: string; sender_name: string }> }).rows;

    if (!rows || rows.length === 0) return 'no transactions yet';

    const formatted = rows.map((r, i) => {
      const amt = escapeHtml(String(r.amount));
      const cur = escapeHtml(String(r.currency));
      const ref = escapeHtml(String(r.transaction_reference ?? ''));
      const date = escapeHtml(String(r.transaction_date ?? ''));
      const sender = escapeHtml(String(r.sender_name ?? ''));
      return `${i + 1}. <code>${amt} ${cur}</code> ref:<code>${ref}</code> date:${date} from:${sender}`;
    });

    let out = `<b>History (last ${rows.length})</b>\n` + formatted.join('\n');
    if (out.length > 4000) {
      // truncate with '+ N more' if overflow due to long rows
      out = out.slice(0, 3950) + `\n… + ${rows.length} more (truncated, use smaller n)`;
    }
    return out;
  } catch (err) {
    logger.warn({ err }, 'handleHistory failed');
    return 'history unavailable — DB error';
  }
}

export async function handleSuspicious(rawLimit: number | string | undefined): Promise<string> {
  let n = Number(rawLimit ?? 5);
  if (!Number.isFinite(n)) n = 5;
  n = Math.max(1, Math.min(10, Math.floor(n)));

  const pool = getPool();
  try {
    const result2 = await withTimeout(
      pool.query<{
        from_address: string;
        reason: string;
        subject: string | null;
        created_at: string;
      }>(
        `SELECT from_address, reason, subject, created_at::text AS created_at
         FROM suspicious_emails ORDER BY created_at DESC LIMIT $1`,
        [n],
      ),
      5000,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as import('pg').QueryResult<{ from_address: string; reason: string; subject: string | null; created_at: string }>,
    );
    const rows = (result2 as { rows: Array<{ from_address: string; reason: string; subject: string | null }> }).rows;

    if (!rows || rows.length === 0) return 'no suspicious emails';

    const formatted = rows.map((r, i) => {
      const from = escapeHtml(String(r.from_address ?? ''));
      const reason = escapeHtml(String(r.reason ?? ''));
      const subj = escapeHtml(String(r.subject ?? '').slice(0, 80));
      return `${i + 1}. from:${from} reason:${reason} subj:<code>${subj}</code>`;
    });

    let out = `<b>Suspicious (last ${rows.length})</b>\n` + formatted.join('\n');
    if (out.length > 4000) out = out.slice(0, 3950) + '\n… truncated';
    return out;
  } catch (err) {
    logger.warn({ err }, 'handleSuspicious failed');
    return 'suspicious unavailable — DB error';
  }
}

// --- logs ---

const ALLOWED_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export function handleLogs(rawN: number | string | undefined, rawLevel: string | undefined): string {
  let n = Number(rawN ?? 20);
  if (!Number.isFinite(n)) n = 20;
  n = Math.max(1, Math.min(50, Math.floor(n)));

  let level: string | undefined;
  if (rawLevel && ALLOWED_LEVELS.has(rawLevel.toLowerCase())) {
    level = rawLevel.toLowerCase();
  } else if (rawLevel && !ALLOWED_LEVELS.has(rawLevel.toLowerCase())) {
    // unknown level -> ignore filter, treat as no filter but inform? just ignore
    level = undefined;
  }

  const entries = logRing.tail(n, level);
  if (entries.length === 0) {
    return 'no logs yet — Railway dashboard is canonical for deep history';
  }

  const lines = entries.map((e) => {
    const time = new Date(e.ts).toISOString().slice(11, 19);
    const lvl = escapeHtml(e.level);
    const msg = escapeHtml(e.msg.slice(0, 200));
    return `[${time} ${lvl}] ${msg}`;
  });

  let out = `<b>Logs (last ${entries.length}${level ? ' level>=' + escapeHtml(level) : ''})</b>\n` + lines.join('\n');
  if (out.length > 4000) out = out.slice(0, 3950) + '\n… truncated';
  return out;
}

// --- poll/watch triggers ---

export async function handlePollTrigger(chatId: string): Promise<string> {
  // strict rate: 1 per 30s
  if (isRateLimited(chatId, 'poll', 1, 30_000)) {
    return '⏳ /poll cooldown — retry in ~30s';
  }

  // overlap guard via pollRunning
  try {
    const { _isPollRunningForTests } = await import('../gmail/poll');
    if (_isPollRunningForTests()) {
      return '⏳ poll already running — try again shortly';
    }
  } catch {
    // if import fails, continue
  }

  // ack then off-path
  setImmediate(async () => {
    try {
      const { pollSweep } = await import('../gmail/poll');
      await pollSweep();
      await sendTelegramMessage(chatId, '✅ poll done');
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await sendTelegramMessage(chatId, `⚠️ poll failed: ${escapeHtml(msg.slice(0, 300))}`);
    }
  });

  return '⏳ poll sweep started — I\'ll report back…';
}

export async function handleWatchTrigger(chatId: string): Promise<string> {
  if (isRateLimited(chatId, 'watch', 1, 60_000)) {
    return '⏳ /watch cooldown — retry in ~60s';
  }

  setImmediate(async () => {
    try {
      const { registerWatch } = await import('../gmail/watch');
      const result = await registerWatch();
      const hid = result.historyId ? result.historyId.slice(0, 16) + '…' : 'none';
      const exp = result.expiration ?? 'unknown';
      await sendTelegramMessage(chatId, `✅ watch registered — historyId: ${escapeHtml(hid)} expires: ${escapeHtml(String(exp))}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await sendTelegramMessage(chatId, `⚠️ watch failed: ${escapeHtml(msg.slice(0, 300))}`);
    }
  });

  return '⏳ watch registration started — I\'ll report back…';
}

// --- dispatch ---

type Handler = (chatId: string, args: string[]) => Promise<string> | string;

const handlers: Record<string, Handler> = {
  help: async () => buildHelpReply(),
  status: async () => buildStatusReply(),
  health: async () => buildStatusReply(),
  history: async (chatId, args) => handleHistory(args[0]),
  suspicious: async (chatId, args) => handleSuspicious(args[0]),
  logs: async (chatId, args) => handleLogs(args[0] ? Number(args[0]) : undefined, args[1]),
  poll: async (chatId) => handlePollTrigger(chatId),
  watch: async (chatId) => handleWatchTrigger(chatId),
};

export async function handleTelegramUpdate(update: unknown): Promise<string | null> {
  try {
    const u = update as { message?: { text?: string; chat?: { id?: number | string }; from?: { id?: number | string } } };
    const text = u?.message?.text?.trim() ?? '';
    if (!text.startsWith('/')) return null;
    const { cmd, args } = parseCommandText(text);
    if (!cmd) return null;
    const h = handlers[cmd];
    if (!h) return `Unknown command /${escapeHtml(cmd)}. Try /help`;
    const chatId = String((u.message!.chat?.id ?? u.message!.from?.id ?? '') as string | number);
    if (!chatId) return null;
    const result = await h(chatId, args);
    return result ?? null;
  } catch (err) {
    logger.warn({ err }, 'handleTelegramUpdate failed — never throw');
    return null;
  }
}
