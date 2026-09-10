import { timingSafeEqual } from 'node:crypto';

const sessions = new Map<string, number>(); // chatId string -> expiry ms
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function isLoggedIn(chatId: string | number): boolean {
  const key = String(chatId);
  const exp = sessions.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(key);
    return false;
  }
  return true;
}

export function login(chatId: string | number, password: string): boolean {
  const want = process.env.TELEGRAM_BOT_PASSWORD ?? '';
  if (!want) return false; // fail-closed if env missing
  if (!constantTimeEqual(password, want)) return false;
  sessions.set(String(chatId), Date.now() + SESSION_TTL_MS);
  return true;
}

export function logout(chatId: string | number): void {
  sessions.delete(String(chatId));
}

export function _resetSessionsForTests(): void {
  sessions.clear();
}

// expose for diagnostics/tests if needed
export function _getSessionsForTests(): Map<string, number> {
  return sessions;
}

// hourly sweep unref
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of sessions) {
    if (now > exp) sessions.delete(k);
  }
}, 60 * 60 * 1000);

if (typeof (sweepInterval as unknown as { unref?: () => void }).unref === 'function') {
  (sweepInterval as unknown as { unref: () => void }).unref();
}

export { constantTimeEqual };
