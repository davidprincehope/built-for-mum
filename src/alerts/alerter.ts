import { logger as defaultLogger } from '../observability/logger';

type CooldownEntry = number; // epoch ms when cooldown expires
const cooldowns = new Map<string, CooldownEntry>();

function redactedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function getWebhookUrl(): string {
  return process.env.ALERT_WEBHOOK_URL ?? '';
}

function getFallbackUrl(): string {
  return process.env.ALERT_FALLBACK_WEBHOOK_URL ?? '';
}

function getChatId(): string {
  return process.env.TELEGRAM_CHAT_ID ?? process.env.ALERT_CHAT_ID ?? '';
}

function isTelegramUrl(url: string): boolean {
  return url.includes('api.telegram.org');
}

/**
 * Send alert once per cooldown window. Telegram primary with fallback to ALERT_FALLBACK_WEBHOOK_URL.
 * Never throws; never logs full URL (only host).
 */
export async function sendOnce(key: string, text: string, cooldownMs: number): Promise<void> {
  const now = Date.now();
  const expires = cooldowns.get(key);
  if (expires !== undefined && now < expires) {
    defaultLogger.debug({ key, cooldownMs, remainingMs: expires - now }, 'alert suppressed by cooldown');
    return;
  }
  cooldowns.set(key, now + cooldownMs);
  defaultLogger.warn({ alertKey: key }, text);

  const webhook = getWebhookUrl();
  if (!webhook) return;

  const attemptedPrimary = await sendToWebhook(webhook, text, key);
  if (attemptedPrimary) return;

  const fallback = getFallbackUrl();
  if (fallback) {
    defaultLogger.warn({ key, primaryHost: redactedHost(webhook), fallbackHost: redactedHost(fallback) }, 'primary alert failed — trying fallback');
    await sendToWebhook(fallback, text, key, true);
  } else {
    defaultLogger.error({ key, host: redactedHost(webhook) }, 'alert webhook failed and no fallback configured');
  }
}

async function sendToWebhook(webhook: string, text: string, key: string, isFallback = false): Promise<boolean> {
  const host = redactedHost(webhook);
  try {
    let body: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isTelegramUrl(webhook) && !isFallback) {
      const chatId = getChatId();
      const payload: Record<string, unknown> = { text, parse_mode: 'HTML' };
      if (chatId) payload.chat_id = chatId;
      else payload.chat_id = 'unknown';
      // Include key for traceability if chat_id missing
      body = JSON.stringify({ chat_id: payload.chat_id, text, parse_mode: 'HTML', key });
      // If chat_id is unknown, still send — Telegram will fail and fallback triggers, but we try
    } else {
      body = JSON.stringify({ text, key });
    }
    const res = await fetch(webhook, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      defaultLogger.warn({ status: res.status, key, host, isFallback }, 'alert webhook non-2xx');
      return false;
    }
    defaultLogger.info({ key, host, isFallback }, 'alert sent');
    return true;
  } catch (err) {
    defaultLogger.error({ err, key, host, isFallback }, 'alert webhook failed');
    return false;
  }
}

// Convenience methods with distinct prefixes per T-6.3/T-6.4
export async function suspicious(params: { messageId: string; from: string; reason: string; authResult: string }): Promise<void> {
  const text = `Possible spoof: ${params.reason} from=${params.from} auth=${params.authResult} email_message_id=${params.messageId}`;
  await sendOnce(`suspicious:${params.messageId}`, text, 0);
}

export async function parseFailure(params: { messageId: string; field: string; rawSubject: string }): Promise<void> {
  const subjectSnippet = (params.rawSubject ?? '').slice(0, 200);
  const text = `Zenith format drift: failed to parse ${params.field} subject=${subjectSnippet} email_message_id=${params.messageId}`;
  await sendOnce(`parse:${params.messageId}`, text, 5 * 60 * 1000);
}

export async function staleness(minutesSince: number): Promise<void> {
  const text = `Pipeline stale: no Zenith credit in ${minutesSince}m during business hours`;
  await sendOnce('staleness', text, 60 * 60 * 1000);
}

// Factory for DI / tests
export interface Alerter {
  sendOnce: typeof sendOnce;
  suspicious: typeof suspicious;
  parseFailure: typeof parseFailure;
  staleness: typeof staleness;
}

export function createAlerter(_opts?: { webhookUrl?: string; fallbackUrl?: string; logger?: typeof defaultLogger }): Alerter {
  // opts are accepted for API compatibility but env vars remain source of truth per NFR-1.6
  // If webhookUrl provided, temporarily override env for this instance via closure — but we keep global Map
  return { sendOnce, suspicious, parseFailure, staleness };
}

export function _resetCooldownsForTests(): void {
  cooldowns.clear();
}

export function _getCooldownExpiryForTests(key: string): number | undefined {
  return cooldowns.get(key);
}
