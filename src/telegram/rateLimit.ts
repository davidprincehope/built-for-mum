const hits = new Map<string, number[]>();

export function isRateLimited(
  chatId: string,
  command: string,
  limit = 5,
  windowMs = 10_000,
): boolean {
  const key = `${chatId}:${command}`;
  const now = Date.now();
  const existing = hits.get(key) ?? [];
  const filtered = existing.filter((t) => now - t < windowMs);
  if (filtered.length >= limit) {
    // do NOT push; keep filtered window without adding
    hits.set(key, filtered);
    return true;
  }
  filtered.push(now);
  hits.set(key, filtered);
  return false;
}

export function _resetRateLimitForTests(): void {
  hits.clear();
}

// Expose for inspection if needed
export function _getHitsForTests(): Map<string, number[]> {
  return hits;
}
