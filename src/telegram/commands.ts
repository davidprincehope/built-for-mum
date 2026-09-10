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

function formatUptime(): string {
  const sec = process.uptime();
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

export function buildWelcomeReply(): { text: string; replyMarkup: unknown } {
  const text = [
    '🤖 <b>Welcome to PaymentVerificationBot</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    'Send <code>/login &lt;password&gt;</code> to start (24h session)',
    '• Try <code>/help</code> for commands',
  ].join('\n');
  const replyMarkup = {
    inline_keyboard: [
      [{ text: '🔐 Login', callback_data: '/login' }],
      [{ text: '❓ Help', callback_data: '/help' }],
    ],
  };
  return { text, replyMarkup };
}

// --- login / logout ---
export async function handleLogin(chatId: string, args: string[], messageId?: number): Promise<{ text: string; replyMarkup?: unknown }> {
  if (!args || args.length === 0 || !args[0]) {
    return { text: 'Usage: /login <password>' };
  }
  if (isRateLimited(chatId, 'login', 5, 60_000)) {
    return { text: '⏳ Slow down — login cooling down, retry in ~60s. Tip: try again shortly' };
  }
  const password = args[0];
  const botPassword = process.env.TELEGRAM_BOT_PASSWORD ?? '';
  if (!botPassword) {
    return { text: '⚠️ Bot not configured — set TELEGRAM_BOT_PASSWORD' };
  }
  const { login } = await import('./session');
  const ok = login(chatId, password);
  if (ok) {
    logger.info({ chatId }, 'telegram login success');
    if (messageId) {
      try {
        const { deleteTelegramMessage } = await import('./sendMessage');
        deleteTelegramMessage(chatId, messageId).catch(() => {});
      } catch {}
    }
    return { text: '✅ Logged in for 24h • Try /balance, /history, /verify, /search' };
  }
  logger.warn({ chatId }, 'telegram login failed — wrong password');
  return { text: '❌ Wrong password' };
}

export async function handleLogout(chatId: string): Promise<{ text: string }> {
  const { logout } = await import('./session');
  logout(chatId);
  return { text: '👋 Logged out' };
}

// --- verify / search with rate-limit tuning per D-14 ---
export async function handleVerifyStub(chatId: string, args: string[]): Promise<{ text: string; replyMarkup?: unknown }> {
  if (isRateLimited(chatId, 'verify', 5, 60_000)) {
    return { text: '⏳ Slow down — Verify cooling down, retry in ~30s. Tip: try again shortly' };
  }
  const freeText = (args ?? []).join(' ').trim();
  if (freeText) {
    try {
      const { handleVerify } = await import('./verify');
      const reply = await handleVerify({ chatId, freeFormText: freeText });
      if (typeof reply === 'string') return { text: reply };
      return { text: reply.text, replyMarkup: (reply as { replyMarkup?: unknown }).replyMarkup };
    } catch (e) {
      logger.warn({ err: e, chatId }, 'handleVerify stub free-form failed');
      return { text: '⚠️ Verify failed — try again' };
    }
  }
  return { text: 'Send a photo/PDF with caption or type /verify 100k 2026-09-09 SAMPLE SENDER' };
}

export async function handleSearchStub(chatId: string, args: string[]): Promise<{ text: string; replyMarkup?: unknown }> {
  const { isLoggedIn } = await import('./session');
  if (!isLoggedIn(chatId)) {
    const w = buildWelcomeReply();
    return { text: w.text, replyMarkup: w.replyMarkup };
  }
  if (isRateLimited(chatId, 'search', 10, 60_000)) {
    return { text: '⏳ Slow down — Search cooling down, retry in ~30s. Tip: try again shortly' };
  }
  const q = (args ?? []).join(' ').trim();
  if (!q) return { text: 'Usage: /search <query> e.g. /search last week large transfers or /search SAMPLE SENDER 100k September' };
  // pagination callback: last arg numeric and first arg encoded
  // parseCommandText already split; for callback_data we have encoded query + offset
  // detect callback form: args length >=1 where last is numeric offset and first token contains % encoding or no spaces
  // We handle via handleSearch pagination param below
  let queryText = q;
  let offset = 0;
  if (args.length >= 2) {
    const last = args[args.length - 1];
    if (/^\d+$/.test(last)) {
      // check if first token is encoded search query
      const possibleOffset = Number(last);
      // If args came from callback_data "/search <encoded> <offset>", args[0] is encoded query
      // For normal text search like "SAMPLE SENDER 100k 10" would also look like numeric last, but we treat it as query text instead of pagination
      // Only treat as pagination when args length === 2 and first arg decodes without spaces? Safer: if we detect encode
      // We'll differentiate by checking callback context: if encoded contains % or is single token query
      // Use heuristic: if original args length === 2 and decode yields no error, treat as pagination
      if (args.length === 2) {
        try {
          const decoded = decodeURIComponent(args[0]);
          queryText = decoded;
          offset = possibleOffset;
        } catch {
          // not encoded, treat as normal query
        }
      }
    }
  }
  try {
    const { handleSearch } = await import('./search');
    const reply = await handleSearch(queryText, { offset });
    return reply;
  } catch (e) {
    logger.warn({ err: e, chatId }, 'handleSearch failed');
    return { text: '⚠️ Search failed — try again' };
  }
}

// --- help with professional UI and inline keyboard ---

export function buildHelpReply(): { text: string; replyMarkup?: unknown } {
  const text = [
    '🤖 <b>PaymentVerificationBot — Admin Console</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    '🔐 <b>Auth</b>',
    '  /login &lt;password&gt;  —  Login for 24h session',
    '  /logout  —  End session',
    '',
    '📊 <b>Monitoring</b>',
    '  /status  —  Worker health, DB & pipeline state',
    '  /health  —  Alias for /status',
    '  /logs <i>[n] [level]</i>  —  Tail worker logs <code>(20 warn)</code>',
    '',
    '💳 <b>Ledger</b>',
    '  /balance  —  Available & current + last TX',
    '  /history <i>[from to]</i>  —  Range Lagos DD/MM/YYYY or YYYY-MM-DD capped 50',
    '  /search <i>query</i>  —  Full-text AI search e.g. last week large transfers',
    '  /verify <i>[text]</i> + image/PDF  —  Verify transaction',
    '  /suspicious <i>[n]</i>  —  Last <i>n</i> spoofs <code>(5)</code>',
    '',
    '📈 <b>Analytics</b>',
    '  /summary  —  24h/7d counts & sums + last TX Africa/Lagos',
    '  /export <i>[from to]</i>  —  CSV via document',
    '  /duplicates  —  Hunt duplicates GROUP BY amount, date HAVING COUNT>1',
    '',
    '⚡ <b>Ops</b>',
    '  /poll    —  Trigger Gmail poll <i>(30s cooldown)</i>',
    '  /watch   —  Re-register Gmail watch <i>(60s cooldown)</i>',
    '  /logout  —  End 24h session',
    '',
    '💡 <i>Examples:</i> <code>/login secret</code>  <code>/balance</code>  <code>/history 01/09/2026 10/09/2026</code>  <code>/search SAMPLE SENDER 100k</code>  <code>/export 2026-09-01 2026-09-10</code>',
    '',
    '🔗 <a href="https://example.com/health">Health endpoint</a> • <code>Africa/Lagos</code>',
  ].join('\n');

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: '/status' },
        { text: '💰 Balance', callback_data: '/balance' },
      ],
      [
        { text: '📜 History', callback_data: '/history' },
        { text: '🔍 Search', callback_data: '/search' },
      ],
      [
        { text: '📊 Summary', callback_data: '/summary' },
        { text: '📄 Export', callback_data: '/export' },
      ],
      [
        { text: '🔎 Duplicates', callback_data: '/duplicates' },
        { text: '📋 Logs', callback_data: '/logs' },
      ],
      [
        { text: '⚡ Poll', callback_data: '/poll' },
        { text: '🔄 Watch', callback_data: '/watch' },
      ],
    ],
  };

  return { text: truncate(text, 4000), replyMarkup };
}

// --- status/health with professional cards ---

export async function buildStatusReply(): Promise<{ text: string; replyMarkup?: unknown }> {
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

  const uptime = formatUptime();
  const staleStr = String(stale);
  const staleEmoji = staleStr === 'ok' ? '✅' : staleStr === 'stale' ? '⚠️' : staleStr === 'never_seeded' ? '—' : '❓';
  const staleLabel = staleStr === 'ok' ? 'Healthy' : staleStr === 'stale' ? 'Stale' : staleStr === 'never_seeded' ? 'No data' : staleStr;

  let lastTxLine: string;
  if (lastAt) {
    const d = lastAt as Date;
    const lagos = d.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour12: false });
    lastTxLine = `<code>${escapeHtml(lagos)}</code> <i>Africa/Lagos</i> • ${escapeHtml(formatAge(d))}`;
  } else {
    lastTxLine = '<i>never</i>';
  }

  let watchLine: string;
  if (watchExp) {
    try {
      const expMs = Number(watchExp);
      if (Number.isFinite(expMs)) {
        const ttlMs = expMs - Date.now();
        const ttlH = (ttlMs / 3600000).toFixed(1);
        const expDate = new Date(expMs).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour12: false });
        watchLine = `<code>${escapeHtml(expDate)}</code> <i>ttl ${ttlH}h</i>`;
      } else {
        watchLine = `<code>${escapeHtml(watchExp)}</code>`;
      }
    } catch {
      watchLine = `<code>${escapeHtml(String(watchExp))}</code>`;
    }
  } else {
    watchLine = '<i>unknown</i>';
  }

  const pollAfterStr = pollAfter != null ? new Date(pollAfter).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour12: false }) : 'unknown';
  const historySlice = historyId ? `<code>${escapeHtml((historyId as string).slice(0, 12))}…</code>` : '<i>none</i>';

  const statusEmoji = staleStr === 'ok' ? '🟢' : staleStr === 'stale' ? '🟡' : '⚪';
  const dbEmoji = Number(txCount) > 0 ? '🟢' : '⚪';

  const text = [
    `${statusEmoji} <b>Worker Status</b>  <i>up ${escapeHtml(uptime)}</i>`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    `${staleEmoji} <b>Pipeline:</b> ${escapeHtml(staleLabel)}  <code>${escapeHtml(staleStr)}</code>`,
    `⏰ <b>Last TX:</b> ${lastTxLine}`,
    '',
    `${dbEmoji} <b>Database</b>`,
    `  • <b>Transactions:</b> <code>${escapeHtml(String(txCount))}</code>  • <b>Suspicious:</b> <code>${escapeHtml(String(susCount))}</code>`,
    `  • <b>History ID:</b> ${historySlice}`,
    '',
    `📡 <b>Gmail</b>`,
    `  • <b>Watch expires:</b> ${watchLine}`,
    `  • <b>Poll after:</b> <code>${escapeHtml(pollAfterStr)}</code> <i>Africa/Lagos</i>`,
    '',
    `🔗 <a href="https://example.com/health">Health</a> • <code>Africa/Lagos 07:00–21:00</code>`,
  ].join('\n');

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: '/status' },
        { text: '📜 History 5', callback_data: '/history 5' },
      ],
      [
        { text: '📋 Logs', callback_data: '/logs 20' },
        { text: '⚡ Poll now', callback_data: '/poll' },
      ],
    ],
  };

  return { text: truncate(text, 4000), replyMarkup };
}

// --- history with professional table ---

export async function handleHistory(rawLimit: number | string | undefined): Promise<{ text: string; replyMarkup?: unknown }> {
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
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as import('pg').QueryResult<{ amount: string; currency: string; transaction_reference: string; transaction_date: string; sender_name: string }>,
    );
    const rows = (result as { rows: Array<{ amount: string; currency: string; transaction_reference: string; transaction_date: string; sender_name: string }> }).rows;

    if (!rows || rows.length === 0) {
      return { text: '📭 <b>History</b>\n<i>No transactions yet</i>\n\nSend a Zenith credit to <code>999****999</code> to see it here.', replyMarkup: undefined };
    }

    // Build professional table with monospace pre block
    const header = ` # │ Amount      │ Sender`;
    const divider = `───┼─────────────┼──────────────────`;
    const lines = rows.map((r, i) => {
      const num = String(i + 1).padStart(2, ' ');
      const amt = `${r.amount} ${r.currency}`.padEnd(11, ' ');
      const sender = (r.sender_name ?? '').substring(0, 18).padEnd(18, ' ');
      const ref = r.transaction_reference ? ` ref:${r.transaction_reference.slice(0, 12)}` : '';
      const date = r.transaction_date ? ` ${r.transaction_date}` : '';
      return `${num} │ ${amt} │ ${sender}${ref}${date}`;
    });

    const table = [header, divider, ...lines].join('\n');
    const totalLine = `Total: ${rows.length} shown • DB has more, use /history 10`;

    const text = [
      `💳 <b>Recent Transactions</b> <i>(last ${rows.length})</i>`,
      '━━━━━━━━━━━━━━━━━━━━',
      `<pre>${escapeHtml(table)}</pre>`,
      `<i>${escapeHtml(totalLine)}</i>`,
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🔄 Refresh', callback_data: `/history ${n}` },
          { text: n < 10 ? '📜 Show 10' : '📜 Show 5', callback_data: n < 10 ? '/history 10' : '/history 5' },
        ],
      ],
    };

    let out = text;
    if (out.length > 3800) out = out.slice(0, 3750) + '\n… truncated';
    return { text: out, replyMarkup };
  } catch (err) {
    logger.warn({ err }, 'handleHistory failed');
    return { text: '⚠️ <b>History unavailable</b>\n<i>DB error — check /logs</i>' };
  }
}

export async function handleSuspicious(rawLimit: number | string | undefined): Promise<{ text: string; replyMarkup?: unknown }> {
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
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as import('pg').QueryResult<{ from_address: string; reason: string; subject: string | null }>,
    );
    const rows = (result2 as { rows: Array<{ from_address: string; reason: string; subject: string | null }> }).rows;

    if (!rows || rows.length === 0) {
      return { text: '✅ <b>Suspicious</b>\n<i>No spoof attempts — all Zenith mails passed DKIM ✅</i>' };
    }

    const lines = rows.map((r, i) => {
      const from = (r.from_address ?? '').slice(0, 24);
      const reason = r.reason ?? '';
      const subj = (r.subject ?? '').slice(0, 32);
      return `${i + 1}. <code>${escapeHtml(from)}</code>\n   └ <i>${escapeHtml(reason)}</i> • <code>${escapeHtml(subj)}</code>`;
    });

    const text = [
      `🚨 <b>Suspicious Emails</b> <i>(last ${rows.length})</i>`,
      '━━━━━━━━━━━━━━━━━━━━',
      ...lines,
    ].join('\n');

    let out = text;
    if (out.length > 3800) out = out.slice(0, 3750) + '\n… truncated';
    return { text: out };
  } catch (err) {
    logger.warn({ err }, 'handleSuspicious failed');
    return { text: '⚠️ <b>Suspicious unavailable</b>\n<i>DB error</i>' };
  }
}

// --- logs with pre block and level colors ---

const ALLOWED_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export function handleLogs(rawN: number | string | undefined, rawLevel: string | undefined): { text: string; replyMarkup?: unknown } {
  let n = Number(rawN ?? 20);
  if (!Number.isFinite(n)) n = 20;
  n = Math.max(1, Math.min(50, Math.floor(n)));

  let level: string | undefined;
  if (rawLevel && ALLOWED_LEVELS.has(rawLevel.toLowerCase())) {
    level = rawLevel.toLowerCase();
  } else if (rawLevel && !ALLOWED_LEVELS.has(rawLevel.toLowerCase())) {
    level = undefined;
  }

  const entries = logRing.tail(n, level);
  if (entries.length === 0) {
    return { text: '📭 <b>Logs</b>\n<i>No logs yet — Railway dashboard is canonical for deep history</i>\n<code>railway logs --service worker --lines 100</code>' };
  }

  const levelEmoji: Record<string, string> = {
    trace: '🔍',
    debug: '🐛',
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    fatal: '💀',
  };

  const lines = entries.map((e) => {
    const time = new Date(e.ts).toISOString().slice(11, 19);
    const emoji = levelEmoji[e.level] ?? '•';
    const lvl = e.level.padEnd(5, ' ');
    const msg = e.msg.slice(0, 120).replace(/\n/g, ' ');
    return `${time} ${emoji} ${lvl} ${msg}`;
  });

  const header = `📋 <b>Logs</b> <i>(last ${entries.length}${level ? ' • ' + escapeHtml(level) + '+' : ''})</i>`;
  const table = lines.join('\n');
  const text = `${header}\n<pre>${escapeHtml(table)}</pre>`;

  let out = text;
  if (out.length > 3800) out = out.slice(0, 3750) + '\n… truncated';
  const replyMarkup = {
    inline_keyboard: [[{ text: '🔄 Refresh logs', callback_data: `/logs ${n}${level ? ' ' + level : ''}` }]],
  };
  return { text: out, replyMarkup };
}

// --- poll/watch triggers with polished replies ---

export async function handlePollTrigger(chatId: string): Promise<{ text: string; replyMarkup?: unknown }> {
  if (isRateLimited(chatId, 'poll', 1, 30_000)) {
    return { text: '⏳ <b>Slow down — poll cooling down</b>\n<i>Retry in ~30s. Tip: protects Gmail quota (250 qps)</i>' };
  }

  try {
    const { _isPollRunningForTests } = await import('../gmail/poll');
    if (_isPollRunningForTests()) {
      return { text: '⏳ <b>Poll already running</b>\n<i>Try again shortly</i>' };
    }
  } catch {}

  setImmediate(async () => {
    try {
      const { pollSweep } = await import('../gmail/poll');
      const result = await pollSweep();
      const count = (result as unknown as { totalProcessed?: number })?.totalProcessed ?? 0;
      await sendTelegramMessage(chatId, `✅ <b>Poll done</b>\n<i>Processed ${count} message(s)</i> • <code>${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}</code>`, { replyMarkup: { inline_keyboard: [[{ text: '📜 History', callback_data: '/history 5' }]] } });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await sendTelegramMessage(chatId, `⚠️ <b>Poll failed</b>\n<code>${escapeHtml(msg.slice(0, 300))}</code>`);
    }
  });

  return { text: '⏳ <b>Poll sweep started</b>\n<i>I’ll report back in a moment…</i>\n<code>q:(from:zenithbank.com) after:cursor</code>' };
}

export async function handleWatchTrigger(chatId: string): Promise<{ text: string; replyMarkup?: unknown }> {
  if (isRateLimited(chatId, 'watch', 1, 60_000)) {
    return { text: '⏳ <b>Slow down — watch cooling down</b>\n<i>Retry in ~60s. Tip: try again shortly</i>' };
  }

  setImmediate(async () => {
    try {
      const { registerWatch } = await import('../gmail/watch');
      const result = await registerWatch();
      const hid = result.historyId ? result.historyId.slice(0, 12) + '…' : 'none';
      const exp = result.expiration ? new Date(Number(result.expiration)).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : 'unknown';
      await sendTelegramMessage(chatId, `✅ <b>Watch registered</b>\n• <b>History ID:</b> <code>${escapeHtml(hid)}</code>\n• <b>Expires:</b> <code>${escapeHtml(exp)}</code> <i>Africa/Lagos</i>\n• <b>Topic:</b> <code>projects/example-project/topics/gmail-zenith-notifications</code>`, { replyMarkup: { inline_keyboard: [[{ text: '📊 Status', callback_data: '/status' }]] } });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await sendTelegramMessage(chatId, `⚠️ <b>Watch failed</b>\n<code>${escapeHtml(msg.slice(0, 300))}</code>`);
    }
  });

  return { text: '⏳ <b>Watch registration started</b>\n<i>I’ll report back…</i>\n<code>projects/example-project/topics/gmail-zenith-notifications</code>' };
}

// --- dispatch ---

type Handler = (chatId: string, args: string[]) => Promise<{ text: string; replyMarkup?: unknown } | string> | string;

export async function handleExportWrapper(chatId: string, args: string[]): Promise<{ text: string; replyMarkup?: unknown } | string> {
  const { isLoggedIn } = await import('./session');
  if (!isLoggedIn(chatId)) return buildWelcomeReply();
  if (isRateLimited(chatId, 'export', 5, 60_000)) return '⏳ Slow down — Export cooling down, retry in ~30s. Tip: try again shortly';
  try {
    const { handleExport } = await import('./export');
    return await handleExport(args, chatId);
  } catch (e) {
    logger.warn({ err: e, chatId }, 'handleExport failed');
    return '⚠️ Export failed — try again';
  }
}

export async function handleDuplicatesWrapper(chatId: string, _args: string[]): Promise<{ text: string; replyMarkup?: unknown } | string> {
  const { isLoggedIn } = await import('./session');
  if (!isLoggedIn(chatId)) return buildWelcomeReply();
  try {
    const { handleDuplicates } = await import('./export');
    return await handleDuplicates();
  } catch (e) {
    logger.warn({ err: e, chatId }, 'handleDuplicates failed');
    return '⚠️ Duplicates failed — try again';
  }
}

export async function handleSummaryWrapper(chatId: string, _args: string[]): Promise<{ text: string; replyMarkup?: unknown } | string> {
  const { isLoggedIn } = await import('./session');
  if (!isLoggedIn(chatId)) return buildWelcomeReply();
  try {
    const { handleSummary } = await import('./export');
    return await handleSummary();
  } catch (e) {
    logger.warn({ err: e, chatId }, 'handleSummary failed');
    return '⚠️ Summary failed — try again';
  }
}

const handlers: Record<string, Handler> = {
  help: async () => buildHelpReply(),
  status: async () => buildStatusReply(),
  health: async () => buildStatusReply(),
  login: async (chatId, args) => handleLogin(chatId, args),
  logout: async (chatId) => handleLogout(chatId),
  balance: async (chatId, _args) => {
    try {
      const { buildBalanceReply } = await import('./balance');
      return buildBalanceReply();
    } catch {
      return '⚠️ Balance not yet available';
    }
  },
  history: async (chatId, args) => {
    // Try new Lagos range handler first; fallback to legacy single-arg
    try {
      const { handleHistoryWithRange } = await import('./history');
      return handleHistoryWithRange(args);
    } catch {
      return handleHistory(args[0]);
    }
  },
  verify: async (chatId, args) => handleVerifyStub(chatId, args),
  search: async (chatId, args) => handleSearchStub(chatId, args),
  summary: async (chatId, args) => handleSummaryWrapper(chatId, args),
  export: async (chatId, args) => handleExportWrapper(chatId, args),
  duplicates: async (chatId, args) => handleDuplicatesWrapper(chatId, args),
  suspicious: async (chatId, args) => handleSuspicious(args[0]),
  logs: async (chatId, args) => handleLogs(args[0] ? Number(args[0]) : undefined, args[1]),
  poll: async (chatId) => handlePollTrigger(chatId),
  watch: async (chatId) => handleWatchTrigger(chatId),
};

export async function handleTelegramUpdate(update: unknown): Promise<{ text: string; replyMarkup?: unknown } | string | null> {
  try {
    const u = update as {
      message?: {
        text?: string;
        caption?: string;
        photo?: Array<{ file_id: string; file_size?: number }>;
        document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
        chat?: { id?: number | string };
        from?: { id?: number | string };
      };
      callback_query?: { data?: string; message?: { chat?: { id?: number | string } }; from?: { id?: number | string } };
    };
    // Handle callback queries from inline keyboards
    if (u?.callback_query?.data) {
      const data = u.callback_query.data.trim();
      const chatId = String((u.callback_query.message?.chat?.id ?? u.callback_query.from?.id ?? '') as string | number);
      if (!chatId) return null;
      const { cmd, args } = parseCommandText(data);
      if (!cmd) return null;
      const h = handlers[cmd];
      if (!h) return `Unknown command /${escapeHtml(cmd)}. Try /help`;
      const result = await h(chatId, args);
      if (typeof result === 'string') return result;
      return result ?? null;
    }

    // Media verify branch — photo/document with optional caption, implicit verify if logged in
    const msg = u?.message;
    if (msg && (msg.photo || msg.document)) {
      const chatId = String((msg.chat?.id ?? msg.from?.id ?? '') as string | number);
      if (!chatId) return null;

      // login gate before any download — no token burn for unauth
      try {
        const { isLoggedIn } = await import('./session');
        if (!isLoggedIn(chatId)) {
          return buildWelcomeReply();
        }
      } catch {}

      if (isRateLimited(chatId, 'verify', 5, 60_000)) {
        return '⏳ Slow down — Verify cooling down, retry in ~30s. Tip: try again shortly';
      }

      // resolve fileId and mime
      let fileId: string | undefined;
      let mime: string | undefined;
      let isPdf = false;
      if (msg.photo && msg.photo.length > 0) {
        const { getLargestPhotoId } = await import('./media');
        const largest = getLargestPhotoId(msg.photo);
        if (largest) {
          fileId = largest;
          mime = 'image/jpeg';
        }
      }
      if (!fileId && msg.document) {
        fileId = msg.document.file_id;
        mime = msg.document.mime_type ?? (msg.document.file_name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
        isPdf = mime === 'application/pdf' || (msg.document.file_name?.toLowerCase().endsWith('.pdf') ?? false);
      }

      if (fileId) {
        const caption = msg.caption?.trim() ?? '';
        // caption may contain "/verify ..." — strip prefix if present
        let captionForVerify: string | undefined = caption || undefined;
        if (captionForVerify && captionForVerify.startsWith('/verify')) {
          const { args } = parseCommandText(captionForVerify);
          captionForVerify = args.join(' ') || undefined;
        }
        // If caption empty and isPdf false and photo, allow verify with no caption (will hit vision)
        try {
          const { handleVerify } = await import('./verify');
          const reply = await handleVerify({
            chatId,
            fileId,
            mime,
            caption: captionForVerify,
            isPdf,
          });
          return reply;
        } catch (e) {
          logger.warn({ err: e, chatId }, 'handleTelegramUpdate media verify failed');
          return '⚠️ Verify failed — try again';
        }
      }
    }

    const text = u?.message?.text?.trim() ?? '';
    if (!text.startsWith('/')) return null;
    const { cmd, args } = parseCommandText(text);
    if (!cmd) return null;
    const h = handlers[cmd];
    if (!h) return `Unknown command /${escapeHtml(cmd)}. Try /help`;
    const chatId = String((u.message!.chat?.id ?? u.message!.from?.id ?? '') as string | number);
    if (!chatId) return null;
    // Forward message_id for /login delete path
    if (cmd === 'login') {
      const mid = (u.message as { message_id?: number })?.message_id;
      const result = await handleLogin(chatId, args, typeof mid === 'number' ? mid : undefined);
      if (typeof result === 'string') return result;
      return result ?? null;
    }
    const result = await h(chatId, args);
    if (typeof result === 'string') return result;
    return result ?? null;
  } catch (err) {
    logger.warn({ err }, 'handleTelegramUpdate failed — never throw');
    return null;
  }
}
