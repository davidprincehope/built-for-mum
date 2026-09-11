import { parse, isValid } from 'date-fns';
import { getPool } from '../db/pool';
import { logger } from '../observability/logger';
import { escapeHtml } from './sendMessage';
import { downloadTelegramFile, tmpWriteWithHash, extFromMime } from './media';
import { openRouterVision, openRouterPdf, openRouterTextParse, type ExtractedFields } from './openrouter';
import { extractSender } from '../zenith/sender';
import { formatNaira } from './naira';

const verifyCache = new Map<string, { result: string; at: number }>();
export const VERIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function isDuplicate(contentHash: string): boolean {
  const entry = verifyCache.get(contentHash);
  if (!entry) return false;
  if (Date.now() - entry.at > VERIFY_CACHE_TTL_MS) {
    verifyCache.delete(contentHash);
    return false;
  }
  return true;
}

export function cacheVerify(contentHash: string, replyText: string): void {
  verifyCache.set(contentHash, { result: replyText, at: Date.now() });
}

export function getCachedVerify(contentHash: string): string | null {
  const e = verifyCache.get(contentHash);
  if (!e) return null;
  if (Date.now() - e.at > VERIFY_CACHE_TTL_MS) {
    verifyCache.delete(contentHash);
    return null;
  }
  return e.result;
}

export function _resetVerifyCacheForTests(): void {
  verifyCache.clear();
}

export function _getVerifyCacheForTests(): Map<string, { result: string; at: number }> {
  return verifyCache;
}

export function getTelegramToken(): string {
  const direct = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (direct) return direct;
  const alt = process.env.TELEGRAM_BOT_TOKEN_ALT ?? '';
  if (alt) return alt;
  const alertUrl = process.env.ALERT_WEBHOOK_URL ?? '';
  const m = alertUrl.match(/api\.telegram\.org\/bot([^\/\s]+)/);
  if (m) return m[1];
  return '';
}

const NON_ZENITH_BANKS = ['GTB', 'GTBank', 'Access', 'FirstBank', 'First Bank', 'UBA', 'Ecobank', 'Fidelity', 'Sterling', 'Wema', 'Union Bank', 'Polaris', 'Keystone', 'Stanbic', 'FCMB'];

export function isNonZenithReceipt(rawText: string): boolean {
  if (!rawText) return false;
  const lower = rawText.toLowerCase();
  const hasNonZenith = NON_ZENITH_BANKS.some((b) => lower.includes(b.toLowerCase()));
  if (!hasNonZenith) return false;
  if (lower.includes('zenith')) return false;
  return true;
}

export function buildNonZenithNote(rawText: string): string {
  if (isNonZenithReceipt(rawText)) {
    return 'ℹ️ Non-Zenith receipt — searching Zenith ledger 999****999\n';
  }
  return '';
}

export const _verifyCache = verifyCache;

// --- free-form local regex parse ---
export function parseFreeForm(text: string): { amount?: number; currency?: string; date?: string; sender?: string } | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  let amount: number | undefined;
  const kMatch = t.match(/(\d[\d,]*\.?\d*)\s*k\b/i);
  if (kMatch) {
    const numStr = kMatch[1].replace(/,/g, '');
    const n = Number(numStr);
    if (Number.isFinite(n)) amount = n * 1000;
  } else {
    const m = t.match(/([\d,]+\.\d{2}|[\d,]+)/);
    if (m) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n)) amount = n;
    }
  }
  const currMatch = t.match(/\b(NGN|USD|EUR|GBP)\b/i);
  const currency = currMatch ? currMatch[0].toUpperCase() : 'NGN';

  let date: string | undefined;
  const dateRaw = t.match(/(\d{2}\/\d{2}\/\d{4})|(\d{4}-\d{2}-\d{2})/)?.[0];
  if (dateRaw) {
    if (dateRaw.includes('/')) {
      const d = parse(dateRaw, 'dd/MM/yyyy', new Date());
      if (isValid(d)) {
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    } else {
      // validate YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
        const d = new Date(dateRaw);
        if (!Number.isNaN(d.getTime())) date = dateRaw;
      }
    }
  }

  // sender: remaining words after stripping amount/date/currency and extracting via extractSender on leftover
  // crude: remove amount tokens, date tokens, currency tokens
  let sender: string | undefined;
  if (t) {
    // strip k amount and numbers
    let leftover = t;
    leftover = leftover.replace(/(\d[\d,]*\.?\d*)\s*k\b/gi, ' ');
    leftover = leftover.replace(/[\d,]+\.\d{2}/g, ' ');
    leftover = leftover.replace(/[\d,]+/g, ' ');
    leftover = leftover.replace(/\b(NGN|USD|EUR|GBP)\b/gi, ' ');
    leftover = leftover.replace(/\d{2}\/\d{2}\/\d{4}/g, ' ');
    leftover = leftover.replace(/\d{4}-\d{2}-\d{2}/g, ' ');
    leftover = leftover.replace(/[\/\-]/g, ' ');
    leftover = leftover.replace(/\s+/g, ' ').trim();
    if (leftover) {
      // use first 4 tokens or full if extractSender finds
      const candidate = leftover.split(/\s+/).slice(0, 4).join(' ').trim();
      if (candidate) sender = candidate;
    }
  }

  if (!amount || !date) return null;
  return { amount, currency, date, sender };
}

export function extractFreeForm(text: string): ReturnType<typeof parseFreeForm> {
  return parseFreeForm(text);
}

let __pdfTextOverride: string | null = null;
export function __setPdfTextOverride(v: string | null): void {
  __pdfTextOverride = v;
}
export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (__pdfTextOverride !== null) return __pdfTextOverride;
  try {
    // pdf-parse: require dynamically to allow mocking in tests
    const pdfParse = (await import('pdf-parse')).default as unknown as (b: Buffer) => Promise<{ text: string }>;
    const data = await pdfParse(buffer);
    const txt = (data.text ?? '').trim();
    return txt;
  } catch (e) {
    logger.warn({ err: e }, 'extractPdfText failed');
    return '';
  }
}

// Deterministic match queries
export interface TxRow {
  amount: string;
  currency: string;
  transaction_date: string;
  sender_name: string;
  description: string;
  available_balance: string | null;
  branch: string | null;
  sim?: string;
}

export async function deterministicMatch(params: { amount: number; date: string; sender?: string }): Promise<{ status: 'FOUND'; row: TxRow } | { status: 'MULTIPLE'; rows: TxRow[] } | { status: 'NOT_FOUND' } > {
  const pool = getPool();
  const amountStr = String(params.amount);
  const senderLike = params.sender ? `%${params.sender}%` : '%';
  const exact = await pool.query<TxRow>(
    `SELECT amount::text,currency,transaction_date::text,sender_name,description,available_balance::text,branch FROM transactions WHERE amount = $1::numeric AND transaction_date = $2::date AND sender_name ILIKE $3 LIMIT 5`,
    [amountStr, params.date, senderLike],
  );
  if (exact.rows.length === 1) return { status: 'FOUND', row: exact.rows[0] as TxRow };
  if (exact.rows.length > 1) return { status: 'MULTIPLE', rows: exact.rows as TxRow[] };
  return { status: 'NOT_FOUND' };
}

export function senderSimilarity(a: string, b: string): number {
  const sa = (a ?? '').toLowerCase().trim();
  const sb = (b ?? '').toLowerCase().trim();
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  if (sa.includes(sb) || sb.includes(sa)) return 0.6;
  const getBigrams = (s: string): Set<string> => {
    const padded = ` ${s} `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 1; i++) set.add(padded.slice(i, i + 2));
    return set;
  };
  const setA = getBigrams(sa);
  const setB = getBigrams(sb);
  let inter = 0;
  for (const g of setA) if (setB.has(g)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function nearMatch(params: { amount: number; date: string; sender?: string }): Promise<TxRow[]> {
  const pool = getPool();
  const amountStr = String(params.amount);
  const sender = (params.sender ?? '').trim();
  try {
    const candidates = await pool.query<TxRow>(
      `SELECT amount::text,currency,transaction_date::text,sender_name,description,available_balance::text,branch FROM transactions WHERE amount = $1::numeric AND transaction_date::date BETWEEN ($2::date - interval '1 day') AND ($2::date + interval '1 day') LIMIT 20`,
      [amountStr, params.date],
    );
    const rows = candidates.rows as TxRow[];
    if (!sender) {
      return rows.slice(0, 3);
    }
    const scored = rows
      .map((r) => {
        const cleaned = extractSender(r.description ?? '').senderName || r.sender_name || '';
        const simDesc = senderSimilarity(cleaned, sender);
        const simName = senderSimilarity(r.sender_name ?? '', sender);
        const sim = Math.max(simDesc, simName);
        return { row: r, sim };
      })
      .filter((x) => x.sim > 0.3)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map((x) => x.row);
    return scored;
  } catch (e) {
    logger.warn({ err: e }, 'nearMatch query failed');
    return [];
  }
}

export function renderFoundCard(row: TxRow): { text: string; replyMarkup: unknown } {
  const amt = escapeHtml(formatNaira(row.amount ?? ''));
  const cleanedRaw = extractSender(row.description ?? '').senderName || row.sender_name || '—';
  const cleaned = escapeHtml(cleanedRaw);
  const dateRaw = (row.transaction_date ?? '').slice(0, 10);
  const date = escapeHtml(dateRaw);
  const timeRaw = (row as { transaction_time?: string }).transaction_time?.slice(0, 5) ?? '';
  const time = timeRaw ? ` <code>${escapeHtml(timeRaw)}</code>` : '';
  const desc = row.description ?? '';
  let via: string;
  if (desc.includes('NIP')) via = 'NIP';
  else if (desc.includes('KUDA')) via = 'KUDA';
  else via = 'Zenith';
  const viaEsc = escapeHtml(via);
  const avail = row.available_balance ? escapeHtml(formatNaira(row.available_balance)) : '—';
  const text = [
    `✅ <b>VERIFIED</b> — this credit is in the Zenith ledger`,
    `💳 <b>Amount:</b> <code>${amt}</code>`,
    `👤 <b>Sender:</b> <code>${cleaned}</code>`,
    `📅 <b>Date:</b> <code>${date}</code>${time} <i>Africa/Lagos</i> • via <b>${viaEsc}</b>`,
    `💰 <b>Available after:</b> <code>${avail}</code>`,
  ].join('\n');
  const replyMarkup = {
    inline_keyboard: [
      [{ text: '📜 View history', callback_data: '/history 5', style: 'primary' }],
      [{ text: '🔍 Search similar', callback_data: '/search' }, { text: '← Back to menu', callback_data: '/help' }],
    ],
  };
  return { text, replyMarkup };
}

export function renderNotFoundBase(): string {
  return `❌ <b>Not found</b> — no matching credit for that amount + date in the ledger\n<i>Check the amount, sender, and date. Try /history with a wider range or /search.</i>`;
}

function formatFound(row: TxRow): string {
  return renderFoundCard(row).text;
}

function formatMultiple(rows: TxRow[]): string {
  const lines = rows.slice(0, 5).map((r, i) => {
    const cleanedRaw = extractSender(r.description ?? '').senderName || r.sender_name || '—';
    const cleaned = escapeHtml(cleanedRaw);
    return `${i + 1}. ${escapeHtml(formatNaira(r.amount))} from ${cleaned} on ${escapeHtml(r.transaction_date)}`;
  });
  return `🔎 MULTIPLE (${rows.length}) matches:\n` + lines.join('\n');
}

function buildReplyFromMatch(
  match: Awaited<ReturnType<typeof deterministicMatch>>,
  near: TxRow[],
  amount: number,
  _currency: string,
  date: string,
  sender: string | undefined,
  rawTextForNote: string,
): string {
  const note = buildNonZenithNote(rawTextForNote);
  if (match.status === 'FOUND') {
    return (note + formatFound(match.row)).slice(0, 4000);
  }
  if (match.status === 'MULTIPLE') {
    return (note + formatMultiple(match.rows)).slice(0, 4000);
  }
  // NOT_FOUND
  let txt = note + renderNotFoundBase();
  if (near.length > 0) {
    const sugg = near
      .map((r) => {
        const cleanedRaw = extractSender(r.description ?? '').senderName || r.sender_name || '—';
        const cleaned = escapeHtml(cleanedRaw);
        return `${escapeHtml(formatNaira(r.amount))} • ${cleaned} • ${escapeHtml((r.transaction_date ?? '').slice(0, 10))}`;
      })
      .join('\n');
    txt += `\n\nNear matches (amount exact, date ±1, sender similarity >0.3):\n${sugg}`;
  }
  return txt.slice(0, 4000);
}

export function buildFoundReply(row: TxRow, rawTextForNote: string): { text: string; replyMarkup: unknown } {
  const card = renderFoundCard(row);
  const note = buildNonZenithNote(rawTextForNote);
  return { text: (note + card.text).slice(0, 4000), replyMarkup: card.replyMarkup };
}

function isValidExtracted(e: ExtractedFields | null): e is ExtractedFields {
  if (!e) return false;
  if (!Number.isFinite(e.amount) || e.amount <= 0) return false;
  const allowed = new Set(['NGN', 'USD', 'EUR', 'GBP']);
  if (!allowed.has(String(e.currency).toUpperCase())) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return false;
  const d = new Date(e.date);
  if (Number.isNaN(d.getTime())) return false;
  return true;
}

function normalizeExtracted(raw: { amount?: number; currency?: string; date?: string; sender?: string } | ExtractedFields | null): ExtractedFields | null {
  if (!raw) return null;
  const amount = Number((raw as Record<string, unknown>).amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = String((raw as Record<string, unknown>).currency ?? 'NGN').toUpperCase();
  const date = String((raw as Record<string, unknown>).date ?? '').trim();
  const sender = String((raw as Record<string, unknown>).sender ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { amount, currency, date, sender };
}

export type VerifyReply = string | { text: string; replyMarkup?: unknown };

export async function handleVerify(opts: {
  chatId: string;
  fileId?: string;
  mime?: string;
  caption?: string;
  freeFormText?: string;
  isPdf?: boolean;
}): Promise<VerifyReply> {
  const { chatId, fileId, mime, caption, freeFormText, isPdf } = opts;
  const rawTextForNote = (caption ?? freeFormText ?? '');

  // File path: download + dedup
  if (fileId) {
    const token = getTelegramToken();
    if (!token) {
      logger.warn({ chatId }, 'handleVerify no token');
      return '⚠️ Bot not configured — missing TELEGRAM_BOT_TOKEN';
    }
    let buffer: Buffer;
    let filePath: string;
    try {
      const dl = await downloadTelegramFile(fileId, token);
      buffer = dl.buffer;
      filePath = dl.filePath;
      void filePath;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      logger.warn({ chatId, err: e }, 'downloadTelegramFile failed');
      if (msg.includes('File too large')) return `⚠️ ${msg}`;
      if (msg.includes('getFile failed')) return `⚠️ File unavailable — ${msg}. Try compressed image`;
      return `⚠️ Download failed — ${escapeHtml(msg.slice(0, 200))}`;
    }

    const ext = isPdf ? '.pdf' : extFromMime(mime);
    let contentHash: string;
    let tmpPath: string;
    try {
      const wrote = await tmpWriteWithHash(buffer, ext);
      tmpPath = wrote.tmpPath;
      contentHash = wrote.contentHash;
      void tmpPath;
    } catch (e) {
      logger.warn({ chatId, err: e }, 'tmpWriteWithHash failed');
      // still compute hash for dedup even if write fails
      const { createHash } = await import('node:crypto');
      contentHash = createHash('sha256').update(buffer).digest('hex');
    }

    // Dedup check before AI/DB
    const cached = getCachedVerify(contentHash);
    if (cached) {
      logger.info({ chatId, contentHash: contentHash.slice(0, 12) }, 'verify dedup hit');
      if (cached.startsWith('Already verified')) return cached;
      return `Already verified: ${cached}`.slice(0, 4000);
    }

    let extracted: ExtractedFields | null = null;

    if (isPdf || mime === 'application/pdf') {
      const pdfText = await extractPdfText(buffer);
      if (pdfText.length >= 40) {
        const parsed = parseFreeForm(pdfText);
        extracted = normalizeExtracted(parsed as unknown as ExtractedFields);
        if (extracted) logger.info({ chatId, contentHash: contentHash.slice(0, 12) }, 'pdf local parse hit');
      }
      if (!extracted) {
        try {
          const ai = await openRouterPdf(buffer.toString('base64'));
          extracted = isValidExtracted(ai) ? ai : null;
        } catch (e) {
          if ((e as Error).message === 'OPENROUTER_429') {
            return '⏳ OpenRouter rate limited — try again shortly';
          }
          logger.warn({ chatId, err: e }, 'openRouterPdf failed fallback');
        }
      }
    } else {
      // image
      if (caption) {
        const parsed = parseFreeForm(caption);
        if (parsed) {
          extracted = normalizeExtracted(parsed as unknown as ExtractedFields);
          if (extracted) logger.info({ chatId, contentHash: contentHash.slice(0, 12) }, 'caption local parse hit — skipping vision');
        }
      }
      if (!extracted) {
        // vision only when caption fails and key present
        const vision = await openRouterVision(buffer.toString('base64'), mime ?? 'image/jpeg').catch((e) => {
          if ((e as Error).message === 'OPENROUTER_429') throw e;
          return null;
        });
        if (vision && isValidExtracted(vision)) extracted = vision;
        else if (vision === null && !process.env.OPENROUTER_API_KEY) {
          // graceful fallback: no key, try free-form parse on caption if any else clarify
        }
      }
      if (!extracted && caption) {
        // last resort: if still no extracted and caption was not parsable but vision missing key, we already tried
      }
    }

    if (!extracted || !isValidExtracted(extracted)) {
      const clarify = 'Need amount and date — e.g. \'100k 2026-09-09 SAMPLE SENDER\'';
      // cache clarify? no - not useful for dedup
      return clarify;
    }

    // deterministic match
    let match: Awaited<ReturnType<typeof deterministicMatch>>;
    try {
      match = await deterministicMatch({ amount: extracted.amount, date: extracted.date, sender: extracted.sender });
    } catch (e) {
      logger.warn({ chatId, err: e }, 'deterministicMatch failed');
      return '⚠️ DB error during verify — try again';
    }
    if (match.status === 'FOUND') {
      const found = buildFoundReply(match.row, rawTextForNote);
      cacheVerify(contentHash, found.text);
      logger.info({ chatId, contentHash: contentHash.slice(0, 12), amount: extracted.amount, date: extracted.date, sender: extracted.sender }, 'verify done FOUND');
      return found;
    }
    let near: TxRow[] = [];
    if (match.status === 'NOT_FOUND') {
      near = await nearMatch({ amount: extracted.amount, date: extracted.date, sender: extracted.sender });
    }
    const reply = buildReplyFromMatch(match, near, extracted.amount, extracted.currency, extracted.date, extracted.sender, rawTextForNote);
    // cache final reply
    cacheVerify(contentHash, reply);
    logger.info({ chatId, contentHash: contentHash.slice(0, 12), amount: extracted.amount, date: extracted.date, sender: extracted.sender }, 'verify done');
    return reply;
  }

  // Free-form text without file
  if (freeFormText) {
    const textHash = `text:${freeFormText.trim().toLowerCase()}`;
    const cachedText = getCachedVerify(textHash);
    if (cachedText) {
      if (cachedText.startsWith('Already verified')) return cachedText;
      return `Already verified: ${cachedText}`.slice(0, 4000);
    }

    let extracted: ExtractedFields | null = null;
    const local = parseFreeForm(freeFormText);
    if (local) extracted = normalizeExtracted(local as unknown as ExtractedFields);
    if (!extracted) {
      try {
        const ai = await openRouterTextParse(freeFormText);
        if (isValidExtracted(ai)) extracted = ai;
      } catch (e) {
        if ((e as Error).message === 'OPENROUTER_429') return '⏳ OpenRouter rate limited — try again shortly';
      }
    }

    if (!extracted || !isValidExtracted(extracted)) {
      return 'Need amount and date — e.g. \'100k 2026-09-09 SAMPLE SENDER\'';
    }

    let match: Awaited<ReturnType<typeof deterministicMatch>>;
    try {
      match = await deterministicMatch({ amount: extracted.amount, date: extracted.date, sender: extracted.sender });
    } catch (e) {
      logger.warn({ chatId, err: e }, 'deterministicMatch free-form failed');
      return '⚠️ DB error during verify — try again';
    }
    if (match.status === 'FOUND') {
      const found = buildFoundReply(match.row, rawTextForNote);
      cacheVerify(textHash, found.text);
      return found;
    }
    let near: TxRow[] = [];
    if (match.status === 'NOT_FOUND') {
      near = await nearMatch({ amount: extracted.amount, date: extracted.date, sender: extracted.sender });
    }
    const reply = buildReplyFromMatch(match, near, extracted.amount, extracted.currency, extracted.date, extracted.sender, rawTextForNote);
    // cache free-form too for dedup (text hash)
    cacheVerify(textHash, reply);
    return reply;
  }

  return 'Send a photo/PDF with caption or type /verify 100k 2026-09-09 SAMPLE SENDER';
}

export { parseFreeForm as parseFreeFormAlias };
