import { logger } from '../observability/logger';

type CooldownEntry = number; // epoch ms when cooldown expires
const cooldowns = new Map<string, CooldownEntry>();

/**
 * Send alert once per cooldown window. Logs via pino; if ALERT_WEBHOOK_URL is set,
 * POSTs to Telegram bot webhook. Failures are logged but never throw.
 * Fire-and-forget is intentional — alerting must not crash ingestion.
 */
export async function sendOnce(key: string, text: string, cooldownMs: number): Promise<void> {
  const now = Date.now();
  const expires = cooldowns.get(key);
  if (expires !== undefined && now < expires) {
    logger.debug({ key, cooldownMs, remainingMs: expires - now }, 'alert suppressed by cooldown');
    return;
  }
  cooldowns.set(key, now + cooldownMs);
  logger.warn({ alertKey: key }, text);

  const webhook = process.env.ALERT_WEBHOOK_URL;
  if (!webhook) return;
  try {
    // Telegram sendMessage expects {chat_id, text} but webhook URL may already encode chat; send generic JSON
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, key }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, key }, 'alert webhook non-2xx');
    }
  } catch (err) {
    logger.error({ err, key }, 'alert webhook failed');
  }
}

export function _resetCooldownsForTests(): void {
  cooldowns.clear();
}

export function _getCooldownExpiryForTests(key: string): number | undefined {
  return cooldowns.get(key);
}
