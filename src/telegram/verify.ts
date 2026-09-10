import { logger } from '../observability/logger';

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
  // if explicitly mentions zenith, consider it zenith (no note)
  if (lower.includes('zenith')) return false;
  return true;
}

export function buildNonZenithNote(rawText: string): string {
  if (isNonZenithReceipt(rawText)) {
    return 'ℹ️ Non-Zenith receipt — searching Zenith ledger 999****999\n';
  }
  return '';
}

// Placeholder re-export; full handleVerify implemented in task 2
export const _verifyCache = verifyCache;
