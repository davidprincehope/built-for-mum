function buildAllowedSet(): Set<string> {
  // Prefer TELEGRAM_ADMIN_CHAT_IDS if non-empty, fallback to TELEGRAM_CHAT_ID for backward compat
  const rawAdmin = process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '';
  const rawFallback = process.env.TELEGRAM_CHAT_ID ?? '';
  const raw = rawAdmin.trim() !== '' ? rawAdmin : rawFallback;
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(ids.map(String));
}

export function getAllowedSet(): Set<string> {
  return buildAllowedSet();
}

export function isAllowedChat(chatId: string | number | undefined): boolean {
  if (chatId === undefined || chatId === null || chatId === '') return false;
  const set = buildAllowedSet();
  if (set.size === 0) return false; // fail-closed when no allowlist configured
  return set.has(String(chatId));
}

// Test helpers — no-op but provided for spec compliance; rebuild is dynamic so no state to reset
export function _resetForTests(): void {
  // nothing to reset; set is recomputed from env on each call
}

export function _resetAllowlistForTests(): void {
  // alias
}
