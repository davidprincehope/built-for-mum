import { logger } from '../observability/logger';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractTokenFromAlertUrl(url: string): string | null {
  try {
    const m = url.match(/api\.telegram\.org\/bot([^\/\s]+)/);
    if (m) return m[1];
  } catch {}
  return null;
}

function getBotToken(): string {
  const direct = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (direct) return direct;
  const alt = process.env.TELEGRAM_BOT_TOKEN_ALT ?? '';
  if (alt) return alt;
  const alertUrl = process.env.ALERT_WEBHOOK_URL ?? '';
  if (alertUrl.includes('api.telegram.org')) {
    const extracted = extractTokenFromAlertUrl(alertUrl);
    if (extracted) return extracted;
  }
  return '';
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  opts?: { parseMode?: 'HTML' | undefined },
): Promise<void> {
  const token = getBotToken();
  if (!token) {
    logger.warn({ chatId: String(chatId) }, 'sendTelegramMessage skipped — no TELEGRAM_BOT_TOKEN');
    return;
  }

  const escaped = escapeHtml(text);
  const sliced = escaped.slice(0, 4000);
  const parseMode = opts?.parseMode ?? 'HTML';

  const bodyBase = {
    chat_id: String(chatId),
    text: sliced,
    parse_mode: parseMode as string | undefined,
    disable_web_page_preview: true,
  };
  // if parseMode undefined, omit key
  if (!parseMode) delete (bodyBase as unknown as Record<string, unknown>).parse_mode;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const attempt = async (useParseMode: string | undefined): Promise<{ ok: boolean; status: number; json: unknown }> => {
    const body: Record<string, unknown> = {
      chat_id: String(chatId),
      text: sliced,
      disable_web_page_preview: true,
    };
    if (useParseMode) body.parse_mode = useParseMode;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({})) as unknown;
      return { ok: res.ok, status: res.status, json: j };
    } catch (err) {
      logger.warn({ err, chatId: String(chatId) }, 'sendTelegramMessage fetch failed');
      return { ok: false, status: 0, json: { error: (err as Error).message } };
    }
  };

  try {
    let result = await attempt(parseMode);
    if (!result.ok) {
      const j = result.json as { parameters?: { retry_after?: number }; description?: string };
      if (result.status === 429 && j?.parameters?.retry_after) {
        const delay = j.parameters.retry_after * 1000;
        logger.warn({ chatId: String(chatId), retry_after: j.parameters.retry_after }, 'Telegram 429 — retrying after delay');
        await new Promise((r) => setTimeout(r, delay));
        result = await attempt(parseMode);
        if (result.ok) return;
      }
      // 400 can't parse entities — retry without parse_mode
      const desc = String((j as { description?: string })?.description ?? '');
      if (result.status === 400 && /can't parse entities/i.test(desc) && parseMode) {
        logger.warn({ chatId: String(chatId), desc }, 'sendMessage parse error — retrying without parse_mode');
        result = await attempt(undefined);
        if (result.ok) return;
      }
      if (!result.ok) {
        logger.warn({ chatId: String(chatId), status: result.status, body: JSON.stringify(j).slice(0, 500) }, 'sendTelegramMessage non-2xx');
      }
    }
  } catch (err) {
    logger.warn({ err, chatId: String(chatId) }, 'sendTelegramMessage outer catch — never throw');
  }
  // never throw
}
