import { timingSafeEqual } from 'node:crypto';

export function verifySecretToken(req: import('http').IncomingMessage): boolean {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!want) return false;
  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function extractChatId(body: unknown): string | null {
  const b = body as { message?: { chat?: { id?: number | string }; from?: { id?: number | string } } } | null | undefined;
  const id = b?.message?.chat?.id ?? b?.message?.from?.id ?? null;
  if (id === null || id === undefined) return null;
  return String(id);
}

export function parseCommandText(text: string): { cmd: string; args: string[] } {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('/')) return { cmd: '', args: [] };
  const withoutSlash = trimmed.slice(1);
  const parts = withoutSlash.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { cmd: '', args: [] };
  const rawCmd = parts[0] ?? '';
  const cmd = rawCmd.toLowerCase().replace(/@.+$/, '');
  const args = parts.slice(1);
  return { cmd, args };
}

export async function readJsonBody(req: import('http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}
