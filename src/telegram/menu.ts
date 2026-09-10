import { logger } from '../observability/logger';
import { getBotToken } from './sendMessage';

export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help', description: 'Admin console — all commands' },
  { command: 'status', description: 'Worker health, DB & pipeline' },
  { command: 'balance', description: 'Available & current + last TX' },
  { command: 'history', description: 'Range Lagos DD/MM or YYYY-MM-DD' },
  { command: 'search', description: 'Full-text AI search' },
  { command: 'verify', description: 'Verify transaction (image/PDF/text)' },
  { command: 'summary', description: '24h/7d counts & sums' },
];

export async function registerMenuIfConfigured(): Promise<void> {
  const token = getBotToken();
  if (!token) {
    logger.debug('menu registration skipped — no TELEGRAM_BOT_TOKEN');
    return;
  }
  const api = `https://api.telegram.org/bot${token}`;

  // 1) setMyCommands — defines what typing "/" shows
  try {
    const r = await fetch(`${api}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: COMMANDS, scope: { type: 'all_private_chats' } }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { description?: string };
      logger.warn({ status: r.status, description: j.description }, 'setMyCommands failed');
    } else {
      logger.info('setMyCommands ok — 7 commands');
    }
  } catch (e) {
    logger.warn({ err: e }, 'setMyCommands error — boot continues');
  }

  // 2) setChatMenuButton — makes the blue Menu button open that list (global)
  try {
    const r2 = await fetch(`${api}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'commands' } }),
    });
    if (!r2.ok) {
      const j = (await r2.json().catch(() => ({}))) as { description?: string };
      logger.warn({ status: r2.status, description: j.description }, 'setChatMenuButton failed');
    } else {
      logger.info('setChatMenuButton ok — type:commands global');
    }
  } catch (e) {
    logger.warn({ err: e }, 'setChatMenuButton error — boot continues');
  }

  // Health: log what Telegram thinks is set
  try {
    const info = (await fetch(`${api}/getMyCommands`).then((x) => x.json())) as { result?: unknown[] };
    logger.info({ commands: (info.result as unknown[])?.length ?? 0 }, 'getMyCommands health');
  } catch {}
}
