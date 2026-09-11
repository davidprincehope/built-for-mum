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

export function getBotToken(): string {
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
  opts?: { parseMode?: 'HTML' | undefined; replyMarkup?: unknown },
): Promise<void> {
  const token = getBotToken();
  if (!token) {
    logger.warn({ chatId: String(chatId) }, 'sendTelegramMessage skipped — no TELEGRAM_BOT_TOKEN');
    return;
  }

  // Caller builds HTML and escapes dynamic values via escapeHtml already.
  // Do NOT double-escape the whole message — that would turn <b> into &lt;b&gt; and show raw tags.
  const sliced = text.slice(0, 4000);
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
    if (opts?.replyMarkup) body.reply_markup = opts.replyMarkup;
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

export async function deleteTelegramMessage(chatId: string | number, messageId: number): Promise<void> {
  const token = getBotToken();
  if (!token || !messageId) return;
  try {
    const url = `https://api.telegram.org/bot${token}/deleteMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), message_id: messageId }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
      if (res.status === 429 && j?.parameters?.retry_after) {
        const delay = j.parameters.retry_after * 1000;
        logger.warn({ chatId: String(chatId), retry_after: j.parameters.retry_after }, 'deleteTelegramMessage 429 retrying');
        await new Promise((r) => setTimeout(r, delay));
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId), message_id: messageId }),
          });
        } catch {}
      }
      // swallow 400/429 never throw
    }
  } catch {
    // never throw — hygiene best-effort
  }
}

export async function sendTelegramMessageWithId(
  chatId: string | number,
  text: string,
  opts?: { parseMode?: 'HTML' | undefined; replyMarkup?: unknown },
): Promise<number | null> {
  const token = getBotToken();
  if (!token) {
    logger.warn({ chatId: String(chatId) }, 'sendTelegramMessageWithId skipped — no token');
    return null;
  }
  const sliced = text.slice(0, 4000);
  const parseMode = opts?.parseMode ?? 'HTML';
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const attempt = async (useParseMode: string | undefined): Promise<{ ok: boolean; status: number; json: unknown }> => {
    const body: Record<string, unknown> = {
      chat_id: String(chatId),
      text: sliced,
      disable_web_page_preview: true,
    };
    if (useParseMode) body.parse_mode = useParseMode;
    if (opts?.replyMarkup) body.reply_markup = opts.replyMarkup;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as unknown;
      return { ok: res.ok, status: res.status, json: j };
    } catch (err) {
      logger.warn({ err, chatId: String(chatId) }, 'sendTelegramMessageWithId fetch failed');
      return { ok: false, status: 0, json: { error: (err as Error).message } };
    }
  };

  try {
    let result = await attempt(parseMode);
    if (!result.ok) {
      const j = result.json as { parameters?: { retry_after?: number }; description?: string };
      if (result.status === 429 && j?.parameters?.retry_after) {
        const delay = j.parameters.retry_after * 1000;
        logger.warn({ chatId: String(chatId), retry_after: j.parameters.retry_after }, 'Telegram 429 WithId — retrying');
        await new Promise((r) => setTimeout(r, delay));
        result = await attempt(parseMode);
        if (result.ok) {
          const okJson = result.json as { result?: { message_id?: number } };
          return okJson.result?.message_id ?? null;
        }
      }
      const desc = String((j as { description?: string })?.description ?? '');
      if (result.status === 400 && /can't parse entities/i.test(desc) && parseMode) {
        logger.warn({ chatId: String(chatId), desc }, 'sendWithId parse error — retrying without parse_mode');
        result = await attempt(undefined);
        if (result.ok) {
          const okJson = result.json as { result?: { message_id?: number } };
          return okJson.result?.message_id ?? null;
        }
      }
      if (!result.ok) {
        logger.warn({ chatId: String(chatId), status: result.status }, 'sendTelegramMessageWithId non-2xx');
        return null;
      }
    }
    const okJson = result.json as { result?: { message_id?: number }; ok?: boolean };
    if (okJson?.result?.message_id) return okJson.result.message_id;
    // Some api responses wrap directly
    return null;
  } catch (err) {
    logger.warn({ err, chatId: String(chatId) }, 'sendTelegramMessageWithId outer catch');
    return null;
  }
}

export async function editTelegramMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  opts?: { replyMarkup?: unknown },
): Promise<boolean> {
  const token = getBotToken();
  if (!token || !messageId) return false;
  try {
    const sliced = text.slice(0, 4000);
    const body: Record<string, unknown> = {
      chat_id: String(chatId),
      message_id: messageId,
      text: sliced,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (opts?.replyMarkup) body.reply_markup = opts.replyMarkup;
    const url = `https://api.telegram.org/bot${token}/editMessageText`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { description?: string };
      const desc = String(j.description ?? '');
      if (/message is not modified/i.test(desc)) return true;
      if (/can't parse entities/i.test(desc)) {
        // retry without parse_mode stripping tags
        const plain = text.slice(0, 4000).replace(/<[^>]+>/g, '');
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId), message_id: messageId, text: plain }),
          });
        } catch {}
        return true;
      }
      if (/message to edit not found/i.test(desc) || /message not found/i.test(desc) || /message can't be edited/i.test(desc) || /message to delete not found/i.test(desc)) {
        return false;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = getBotToken();
  if (!token || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 200) } : {}) }),
    });
  } catch {
    // spinner auto-dismiss after ~30s
  }
}

export async function sendChatAction(chatId: string | number, action: 'typing' | 'upload_document' | 'upload_photo' = 'typing'): Promise<void> {
  const token = getBotToken();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), action }),
    });
  } catch {
    // best-effort, never throw
  }
}
