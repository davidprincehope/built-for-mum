import { z } from 'zod';
import { isValid } from 'date-fns';
import { getPool } from '../db/pool';
import { logger } from '../observability/logger';
import { escapeHtml } from './sendMessage';
import { formatNaira } from './naira';
import { extractSender } from '../zenith/sender';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REFERER = 'https://example.com';
const TITLE = 'PaymentVerificationBot';

export const SearchIntentSchema = z.object({
  sender: z.string().min(1).optional(),
  minAmount: z.number().positive().optional(),
  maxAmount: z.number().positive().optional(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => {
      const d = new Date(v);
      return !Number.isNaN(d.getTime()) && isValid(d);
    }, 'invalid date')
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => {
      const d = new Date(v);
      return !Number.isNaN(d.getTime()) && isValid(d);
    }, 'invalid date')
    .optional(),
});

export type SearchIntent = z.infer<typeof SearchIntentSchema>;

function getLagosDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getWeekAgoRange(): { today: string; weekAgo: string } {
  const now = new Date();
  const today = getLagosDateString(now);
  const weekAgo = getLagosDateString(addDays(now, -7));
  return { today, weekAgo };
}

function normalizeCandidate(candidate: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  if (candidate.sender != null) normalized.sender = String(candidate.sender).trim() || undefined;
  if (candidate.Sender != null && !normalized.sender) normalized.sender = String(candidate.Sender).trim() || undefined;
  if (candidate.minAmount != null) {
    const v = Number(String(candidate.minAmount).replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) normalized.minAmount = v;
  }
  if (candidate.min_amount != null && normalized.minAmount == null) {
    const v = Number(String(candidate.min_amount).replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) normalized.minAmount = v;
  }
  if (candidate.maxAmount != null) {
    const v = Number(String(candidate.maxAmount).replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) normalized.maxAmount = v;
  }
  if (candidate.max_amount != null && normalized.maxAmount == null) {
    const v = Number(String(candidate.max_amount).replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) normalized.maxAmount = v;
  }
  if (candidate.fromDate != null) normalized.fromDate = String(candidate.fromDate).trim();
  else if (candidate.from_date != null) normalized.fromDate = String(candidate.from_date).trim();
  else if (candidate.from != null) normalized.fromDate = String(candidate.from).trim();
  if (candidate.toDate != null) normalized.toDate = String(candidate.toDate).trim();
  else if (candidate.to_date != null) normalized.toDate = String(candidate.to_date).trim();
  else if (candidate.to != null) normalized.toDate = String(candidate.to).trim();
  return normalized;
}

function validateAndSanitize(normalized: Record<string, unknown>): SearchIntent | null {
  const validated = SearchIntentSchema.safeParse(normalized);
  if (!validated.success) {
    const withoutBadDates: Record<string, unknown> = { ...normalized };
    if (validated.error.issues.some((i) => String(i.path[0]).includes('fromDate'))) delete withoutBadDates.fromDate;
    if (validated.error.issues.some((i) => String(i.path[0]).includes('toDate'))) delete withoutBadDates.toDate;
    const second = SearchIntentSchema.safeParse(withoutBadDates);
    if (second.success) return sanitize(second.data);
    delete withoutBadDates.minAmount;
    delete withoutBadDates.maxAmount;
    const third = SearchIntentSchema.safeParse(withoutBadDates);
    if (third.success) return sanitize(third.data);
    return null;
  }
  return sanitize(validated.data);
}

function sanitize(data: SearchIntent): SearchIntent {
  if (data.sender && data.sender.trim() === '') delete (data as Record<string, unknown>).sender;
  if (data.minAmount != null && data.maxAmount != null && data.minAmount > data.maxAmount) {
    const tmp = data.minAmount;
    data.minAmount = data.maxAmount;
    data.maxAmount = tmp;
  }
  return data;
}

async function callOpenRouter(model: string, prompt: string, key: string, timeoutMs = 8000): Promise<SearchIntent | null> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': REFERER,
        'X-Title': TITLE,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 200,
      }),
      signal: controller.signal,
    });
    if (res.status === 429 || res.status >= 500 || !res.ok) {
      logger.warn({ status: res.status, model }, 'openRouter call rate/error fallback');
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content ?? '';
    if (!content || !content.trim()) {
      logger.warn({ model }, 'openRouter empty content fallback');
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.trim());
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    const candidate = parsed as Record<string, unknown>;
    const normalized = normalizeCandidate(candidate);
    const result = validateAndSanitize(normalized);
    if (!result || Object.keys(result).length === 0) {
      // empty intent treated as no useful extraction
      return null;
    }
    return result;
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    if (/abort/i.test(msg)) logger.warn({ model }, 'openRouter timeout fallback');
    else logger.warn({ err: e, model }, 'openRouter call failed fallback');
    return null;
  } finally {
    clearTimeout(tid);
  }
}

export async function openRouterSearchIntentWithFallback(nlQuery: string): Promise<SearchIntent | null> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (!key) return null;
  if (!nlQuery || !nlQuery.trim()) return null;
  const { today, weekAgo } = getWeekAgoRange();
  const prompt = `Today is ${today} (Africa/Lagos, YYYY-MM-DD). Extract intent from query "${nlQuery}" into JSON {sender?:string,minAmount?:number,maxAmount?:number,fromDate?:string (YYYY-MM-DD),toDate?:string} — last week means ${weekAgo} to ${today}. Large means minAmount 500000. Return JSON only.`;
  const primary = await callOpenRouter('google/gemma-3-27b-it', prompt, key, 8000);
  if (primary && Object.keys(primary).length > 0) return primary;
  logger.warn('gemma fallback escalating to gemini-2.0-flash-001');
  const fallback = await callOpenRouter('google/gemini-2.0-flash-001', prompt, key, 8000);
  if (fallback && Object.keys(fallback).length > 0) return fallback;
  return null;
}

// Backward compat alias — delegates to fallback chain
export async function openRouterSearchIntent(nlQuery: string): Promise<SearchIntent | null> {
  return openRouterSearchIntentWithFallback(nlQuery);
}

// --- local keyword fallback per plan ---
export function localKeywordIntent(nlQuery: string): SearchIntent {
  const q = (nlQuery ?? '').trim();
  const lower = q.toLowerCase();
  const intent: SearchIntent = {};
  // amount: (\d[\d,]*\.?\d*)\s*k\b → *1000
  const kMatch = q.match(/(\d[\d,]*\.?\d*)\s*k\b/i);
  if (kMatch) {
    const n = Number(kMatch[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) intent.minAmount = n * 1000;
  }
  // date via keyword
  const now = new Date();
  const todayStr = getLagosDateString(now);
  if (lower.includes('last week')) {
    intent.fromDate = getLagosDateString(addDays(now, -7));
    intent.toDate = todayStr;
  } else if (lower.includes('today')) {
    intent.fromDate = todayStr;
    intent.toDate = todayStr;
  } else if (lower.includes('this month')) {
    const start = new Date(now);
    start.setDate(1);
    intent.fromDate = getLagosDateString(start);
    intent.toDate = todayStr;
  }
  // explicit date tokens YYYY-MM-DD or DD/MM/YYYY overrides keyword if found
  const dateTokens = q.match(/(\d{4}-\d{2}-\d{2})|(\d{2}\/\d{2}\/\d{4})/g);
  if (dateTokens && dateTokens.length > 0) {
    // if single token, treat as fromDate == toDate == that date? we'll set both
    const parsedDates: string[] = [];
    for (const dt of dateTokens) {
      if (dt.includes('/')) {
        // parse DD/MM/YYYY
        const parts = dt.split('/');
        const d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
        if (isValid(d) && !Number.isNaN(d.getTime())) {
          parsedDates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
      } else {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
          const d = new Date(dt);
          if (!Number.isNaN(d.getTime()) && isValid(d)) parsedDates.push(dt);
        }
      }
    }
    if (parsedDates.length === 1) {
      intent.fromDate = parsedDates[0];
      intent.toDate = parsedDates[0];
    } else if (parsedDates.length >= 2) {
      intent.fromDate = parsedDates[0];
      intent.toDate = parsedDates[1];
      if (intent.fromDate > intent.toDate) {
        const tmp = intent.fromDate;
        intent.fromDate = intent.toDate;
        intent.toDate = tmp;
      }
    }
  }
  // also September / month name -> handle "September" as month of current year
  if (!intent.fromDate) {
    const months: Record<string, number> = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };
    for (const [name, num] of Object.entries(months)) {
      if (lower.includes(name)) {
        const y = now.getFullYear();
        const mm = String(num).padStart(2, '0');
        const lastDay = new Date(y, num, 0).getDate();
        intent.fromDate = `${y}-${mm}-01`;
        intent.toDate = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`;
        break;
      }
    }
  }

  // sender via remaining words heuristic (remove amount/k, dates, currency, stopwords)
  let leftover = q;
  leftover = leftover.replace(/(\d[\d,]*\.?\d*)\s*k\b/gi, ' ');
  leftover = leftover.replace(/\d{4}-\d{2}-\d{2}/g, ' ');
  leftover = leftover.replace(/\d{2}\/\d{2}\/\d{4}/g, ' ');
  leftover = leftover.replace(/\b(NGN|USD|EUR|GBP)\b/gi, ' ');
  leftover = leftover.replace(/\b(last week|today|this month|large|transfers?|small|big|recent)\b/gi, ' ');
  // remove month names leftover for sender
  leftover = leftover.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, ' ');
  leftover = leftover.replace(/[^A-Za-z0-9 ]/g, ' ');
  leftover = leftover.replace(/\s+/g, ' ').trim();
  const tokens = leftover.split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    // take up to 3 tokens as sender
    const sender = tokens.slice(0, 3).join(' ').trim();
    if (sender && sender.length >= 2) intent.sender = sender;
  }
  // validate via zod, stripping invalid
  const validated = SearchIntentSchema.safeParse(intent);
  if (validated.success) return validated.data;
  // strip invalid fields
  const clean: SearchIntent = {};
  if (intent.sender) clean.sender = intent.sender;
  if (intent.minAmount != null && Number.isFinite(intent.minAmount) && intent.minAmount > 0) clean.minAmount = intent.minAmount;
  if (intent.maxAmount != null && Number.isFinite(intent.maxAmount) && intent.maxAmount > 0) clean.maxAmount = intent.maxAmount;
  if (intent.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(intent.fromDate)) {
    const d = new Date(intent.fromDate);
    if (isValid(d)) clean.fromDate = intent.fromDate;
  }
  if (intent.toDate && /^\d{4}-\d{2}-\d{2}$/.test(intent.toDate)) {
    const d = new Date(intent.toDate);
    if (isValid(d)) clean.toDate = intent.toDate;
  }
  return clean;
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

export async function handleSearch(
  query: string,
  opts: { offset?: number } = {},
): Promise<{ text: string; replyMarkup?: unknown }> {
  const q = (query ?? '').trim();
  if (!q) {
    return { text: 'Usage: /search <query> e.g. /search last week large transfers or /search SAMPLE SENDER 100k September' };
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = 5;

  // intent: try OpenRouter (gemma→gemini), fallback to local
  let intent: SearchIntent | null = null;
  try {
    intent = await openRouterSearchIntentWithFallback(q);
  } catch {
    intent = null;
  }
  if (!intent || Object.keys(intent).length === 0) {
    const local = localKeywordIntent(q);
    intent = local && Object.keys(local).length > 0 ? local : intent ?? local;
    if (!intent || Object.keys(intent).length === 0) {
      // if truly empty, use empty intent (no filters) to at least not crash -> will show recent matching by no filter
      intent = {};
    }
    // if openRouter returned something but local has complementary fields, merge non-overlapping?
    // Keep openRouter precedence; localKeywords only when openRouter null is already handled above.
    // When openRouter null and local has data, we just used local.
  } else {
    // openRouter produced something — if missing date but local has date, keep local date? Per spec fallback is only when null, but enhance coverage: if intent has no dates but local has, merge.
    const local = localKeywordIntent(q);
    if (local.fromDate && !intent.fromDate) intent.fromDate = local.fromDate;
    if (local.toDate && !intent.toDate) intent.toDate = local.toDate;
    if (local.minAmount && !intent.minAmount) intent.minAmount = local.minAmount;
    if (local.sender && !intent.sender) intent.sender = local.sender;
  }

  const validatedIntent = SearchIntentSchema.safeParse(intent ?? {}).success
    ? (intent as SearchIntent)
    : localKeywordIntent(q);

  const senderParam = validatedIntent.sender ?? null;
  const minAmountParam = validatedIntent.minAmount != null ? String(validatedIntent.minAmount) : null;
  const maxAmountParam = validatedIntent.maxAmount != null ? String(validatedIntent.maxAmount) : null;
  const fromDateParam = validatedIntent.fromDate ?? null;
  const toDateParam = validatedIntent.toDate ?? null;

  const pool = getPool();

  const whereClause = `WHERE ($1::text IS NULL OR sender_name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%') AND ($2::numeric IS NULL OR amount >= $2::numeric) AND ($3::numeric IS NULL OR amount <= $3::numeric) AND ($4::date IS NULL OR transaction_date >= $4::date) AND ($5::date IS NULL OR transaction_date <= $5::date)`;

  const countFallback = { rows: [{ count: '0' }] } as unknown as import('pg').QueryResult<{ count: string }>;
  const countResult = await withTimeout(
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM transactions ${whereClause}`, [
      senderParam,
      minAmountParam,
      maxAmountParam,
      fromDateParam,
      toDateParam,
    ]),
    5000,
    countFallback,
  );
  const total = Number((countResult as { rows: Array<{ count: string }> }).rows[0]?.count ?? '0');

  const orderBy = senderParam
    ? `ORDER BY similarity(sender_name, $1) DESC NULLS LAST, transaction_date DESC, transaction_time DESC, created_at DESC`
    : `ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC`;

  const rowsFallback = { rows: [] } as unknown as import('pg').QueryResult<never>;
  let rowsResult: unknown;
  try {
    rowsResult = await withTimeout(
      pool.query<{
        amount: string;
        currency: string;
        transaction_date: string;
        transaction_time: string;
        sender_name: string;
        description: string;
        available_balance: string;
        branch: string | null;
      }>(
        `SELECT amount::text,currency,transaction_date::text,transaction_time::text,sender_name,description,available_balance::text,branch FROM transactions ${whereClause} ${orderBy} LIMIT 5 OFFSET $6`,
        [senderParam, minAmountParam, maxAmountParam, fromDateParam, toDateParam, offset],
      ),
      5000,
      rowsFallback,
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    if (senderParam && /similarity|function.*does not exist|pg_trgm/i.test(msg)) {
      logger.warn({ err: e }, 'similarity ORDER BY failed — fallback to date');
      rowsResult = await withTimeout(
        pool.query<{
          amount: string;
          currency: string;
          transaction_date: string;
          transaction_time: string;
          sender_name: string;
          description: string;
          available_balance: string;
          branch: string | null;
        }>(
          `SELECT amount::text,currency,transaction_date::text,transaction_time::text,sender_name,description,available_balance::text,branch FROM transactions ${whereClause} ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 5 OFFSET $6`,
          [senderParam, minAmountParam, maxAmountParam, fromDateParam, toDateParam, offset],
        ),
        5000,
        rowsFallback,
      );
    } else {
      throw e;
    }
  }
  const rows = (rowsResult as { rows: Array<Record<string, string>> }).rows ?? [];

  if (!rows || rows.length === 0) {
    const msg = `🔍 <b>Search</b> <code>${escapeHtml(q)}</code>\n<i>No matches — try a broader name, a different amount, or check history</i>\nTotal: 0 matching`;
    const sliced = msg.length > 4000 ? msg.slice(0, 4000) : msg;
    return {
      text: sliced,
      replyMarkup: {
        inline_keyboard: [
          [{ text: '📜 View history', callback_data: '/history 5' }],
          [{ text: '← Back to menu', callback_data: '/help' }],
        ],
      },
    };
  }

  // Render 5 hybrid cards with formatNaira, divider, 4096 safety — same contract as history
  const header = `🔍 <b>Search</b> <code>${escapeHtml(q)}</code> • <i>Found ${total} matching</i>`;
  const cardDivider = '\n━━━━━━━━━━━━\n';
  const divider = '━━━━━━━━━━━━━━━━━━━━';
  const cards = rows.map((r) => {
    const cleaned = extractSender(r.description ?? '').senderName || r.sender_name || '—';
    const via = r.description?.includes('NIP') ? 'NIP' : r.description?.includes('KUDA') ? 'KUDA' : 'Zenith';
    const datePart = escapeHtml((r.transaction_date ?? '').slice(0, 10));
    const timePart = r.transaction_time ? ` <code>${escapeHtml(r.transaction_time.slice(0, 5))}</code>` : '';
    const amt = escapeHtml(formatNaira(r.amount));
    const viaEsc = escapeHtml(via);
    const branchLine = r.branch ? `🔖 <code>${escapeHtml(r.branch)}</code>` : '';
    const balanceLine = r.available_balance ? `💰 <code>${escapeHtml(formatNaira(r.available_balance))}</code>` : '';
    return [
      `💳 <b>${amt}</b>`,
      `👤 <b>Sender:</b> <code>${escapeHtml(cleaned.slice(0, 40))}</code>`,
      `📅 <b>Date:</b> <code>${datePart}</code>${timePart} <i>Africa/Lagos</i>`,
      `🏦 <b>via ${viaEsc}</b>`,
      branchLine,
      balanceLine,
    ].filter(Boolean).join('\n');
  });
  let text = [header, divider, cards.join(cardDivider)].join('\n');
  if (total > offset + rows.length) {
    text += `\n<i>Showing ${offset + 1}-${offset + rows.length} of ${total}</i>`;
  } else {
    text += `\n<i>Total: ${total} matching</i>`;
  }
  // 4096 safe: drop whole cards if >3800
  if (text.length > 3800) {
    let kept = [...cards];
    const footerBase = `\n<i>Showing ${offset + 1}-${offset + rows.length} of ${total}</i>`;
    const totalFooter = total > offset + rows.length ? footerBase : `\n<i>Total: ${total} matching</i>`;
    while (kept.length > 1 && ([header, divider, kept.join(cardDivider)].join('\n') + totalFooter).length > 3800) {
      kept.pop();
    }
    const dropped = cards.length - kept.length;
    const suffix = dropped > 0 ? `\n… + ${dropped} more — tap Next 5` : '';
    text = [header, divider, kept.join(cardDivider)].join('\n') + suffix + totalFooter;
  }
  if (text.length > 4000) text = text.slice(0, 3990) + '\n… truncated';

  // pagination ≤64B per RESEARCH Pitfall 1: truncate to 30 before encode so %20 bloat stays under limit
  const truncatedQuery = q.slice(0, 30);
  const encoded = encodeURIComponent(truncatedQuery);
  const buttons: Array<Array<{ text: string; callback_data: string; style?: string }>> = [];
  const navRow: Array<{ text: string; callback_data: string; style?: string }> = [];
  if (offset > 0) {
    const prevOff = Math.max(0, offset - 5);
    navRow.push({ text: '⬅️ Prev', callback_data: `/search ${encoded} ${prevOff}` });
  }
  if (offset + limit < total) {
    const nextOff = offset + limit;
    navRow.push({ text: 'Next 5 ➡️', callback_data: `/search ${encoded} ${nextOff}`, style: 'primary' });
  }
  if (navRow.length) buttons.push(navRow);
  // second row: new search + menu
  buttons.push([
    { text: '🔍 New search', callback_data: '/help' },
    { text: '← Back to menu', callback_data: '/help' },
  ]);
  const replyMarkup = { inline_keyboard: buttons };

  return { text, replyMarkup };
}
