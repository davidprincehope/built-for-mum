import { logger } from '../observability/logger';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REFERER = 'https://example.com';
const TITLE = 'PaymentVerificationBot';

export interface ExtractedFields {
  amount: number;
  currency: string;
  date: string;
  sender: string;
}

function getHeaders(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': REFERER,
    'X-Title': TITLE,
  };
}

function tryParseJson(content: string): ExtractedFields | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const amountRaw = j.amount ?? j.Amount;
    const currencyRaw = j.currency ?? j.Currency;
    const dateRaw = j.date ?? j.Date ?? j.transaction_date;
    const senderRaw = j.sender ?? j.sender_name ?? j.Sender ?? j.name;
    if (amountRaw == null || dateRaw == null) return null;
    const amount = Number(String(amountRaw).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const currency = String(currencyRaw ?? 'NGN').toUpperCase();
    const date = String(dateRaw);
    const sender = String(senderRaw ?? '').trim();
    return { amount, currency, date, sender };
  } catch {
    // try extract json object substring
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const j = JSON.parse(match[0]) as Record<string, unknown>;
        const amount = Number(String((j as Record<string, unknown>).amount ?? '').replace(/,/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return {
          amount,
          currency: String((j as Record<string, unknown>).currency ?? 'NGN').toUpperCase(),
          date: String((j as Record<string, unknown>).date ?? ''),
          sender: String((j as Record<string, unknown>).sender ?? ''),
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function openRouterVision(
  imageBase64: string,
  mime: string = 'image/jpeg',
): Promise<ExtractedFields | null> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (!key) return null;
  const dataUrl = `data:${mime};base64,${imageBase64}`;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract from this receipt: amount (numeric), currency (NGN/USD/EUR/GBP), date (YYYY-MM-DD), sender name. Return JSON only: {"amount":100000,"currency":"NGN","date":"2026-09-10","sender":"SAMPLE SENDER"}',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0,
      }),
    });
    if (res.status === 429) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: 429, body: txt.slice(0, 300) }, 'openRouterVision 429');
      throw new Error('OPENROUTER_429');
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, 'openRouterVision non-200');
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content ?? '';
    return tryParseJson(content);
  } catch (e) {
    if ((e as Error).message === 'OPENROUTER_429') throw e;
    logger.warn({ err: e }, 'openRouterVision failed');
    return null;
  }
}

export async function openRouterPdf(pdfBase64: string): Promise<ExtractedFields | null> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (!key) return null;
  const dataUrl = `data:application/pdf;base64,${pdfBase64}`;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract amount, currency, date (YYYY-MM-DD), sender from this PDF. Return JSON {"amount":100000,"currency":"NGN","date":"2026-09-10","sender":"EXAMPLE MERCHANT"}',
              },
              { type: 'file', file: { filename: 'receipt.pdf', file_data: dataUrl } } as unknown as { type: string },
            ],
          },
        ],
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0,
      }),
    });
    if (res.status === 429) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: 429, body: txt.slice(0, 300) }, 'openRouterPdf 429');
      throw new Error('OPENROUTER_429');
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, 'openRouterPdf non-200');
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content ?? '';
    return tryParseJson(content);
  } catch (e) {
    if ((e as Error).message === 'OPENROUTER_429') throw e;
    logger.warn({ err: e }, 'openRouterPdf failed');
    return null;
  }
}

export async function openRouterTextParse(text: string): Promise<ExtractedFields | null> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (!key || !text) return null;
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: 'google/gemma-3-27b-it',
        messages: [
          {
            role: 'user',
            content: `Extract amount,currency,date,sender from text "${text}"; today is ${now} Lagos; return JSON {"amount":100000,"currency":"NGN","date":"2026-09-10","sender":"SAMPLE SENDER"}`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
        temperature: 0,
      }),
    });
    if (res.status === 429) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: 429, body: txt.slice(0, 300) }, 'openRouterTextParse 429');
      throw new Error('OPENROUTER_429');
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, 'openRouterTextParse non-200');
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content ?? '';
    return tryParseJson(content);
  } catch (e) {
    if ((e as Error).message === 'OPENROUTER_429') throw e;
    logger.warn({ err: e }, 'openRouterTextParse failed');
    return null;
  }
}
