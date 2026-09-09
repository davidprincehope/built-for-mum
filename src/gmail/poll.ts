/**
 * Independent 15-min poll sweep — safety net regardless of push health (D-02/D-04).
 * Paginated messages.list with after: cursor, overlap guard, checkpoint per page.
 */

import { logger } from '../observability/logger';
import { getPollAfterMs, setPollAfterMs, setPollAfter } from '../db/health';

let pollRunning = false;

export interface PollGmailClient {
  users: {
    messages: {
      list: (params: {
        userId: string;
        q?: string;
        pageToken?: string;
        maxResults?: number;
      }) => Promise<{ data: { messages?: Array<{ id?: string | null }>; nextPageToken?: string | null } }>;
    };
  };
}

export interface PollDeps {
  gmail?: PollGmailClient;
  processEmailFn?: (id: string) => Promise<unknown>;
  getPollAfterMsFn?: typeof getPollAfterMs;
  setPollAfterMsFn?: typeof setPollAfterMs;
}

function buildQuery(afterSec: number): string {
  const raw = process.env.ZENITH_SENDER_DOMAINS ?? 'zenithbank.com';
  const domains = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromClauses = domains.map((d) => `from:${d}`);
  // Gmail q syntax: "(from:a OR from:b) after:UNIX"
  const joined = fromClauses.join(' OR ');
  return `(${joined}) after:${afterSec}`;
}

/**
 * Poll sweep — runs independently of push health.
 * Guarded against overlapping runs, paginated, checkpoint per page.
 */
export async function pollSweep(deps: PollDeps = {}): Promise<void> {
  if (pollRunning) {
    logger.debug('pollSweep skipped — already running');
    return;
  }
  pollRunning = true;

  try {
    // Determine after cursor: gmail_poll_after or 7 days ago
    const getAfter = deps.getPollAfterMsFn ?? getPollAfterMs;
    const setAfter = deps.setPollAfterMsFn ?? setPollAfterMs;

    let afterMs = await getAfter();
    if (afterMs === null) {
      afterMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    }
    const afterSec = Math.floor(afterMs / 1000);
    const q = buildQuery(afterSec);

    logger.info({ q, afterSec }, 'pollSweep start');

    let gmail: PollGmailClient;
    if (deps.gmail) {
      gmail = deps.gmail;
    } else {
      const { getGmailClient } = await import('./auth');
      gmail = getGmailClient() as unknown as PollGmailClient;
    }

    const processEmailFn = deps.processEmailFn ?? (async (id: string) => {
      const { processEmail } = await import('../worker');
      return processEmail(id);
    });

    let pageToken: string | undefined;
    let totalProcessed = 0;

    do {
      // Retry wrapper for 429 on messages.list
      let data: { messages?: Array<{ id?: string | null }>; nextPageToken?: string | null };
      let attempts = 0;
      const maxRetries = 3;
      while (true) {
        try {
          const res = await gmail.users.messages.list({
            userId: 'me',
            q,
            pageToken,
            maxResults: 50,
          });
          data = res.data;
          break;
        } catch (err: unknown) {
          const e = err as { code?: number; status?: number };
          const code = e?.code ?? e?.status;
          if (code === 429 && attempts < maxRetries) {
            const backoff = Math.pow(2, attempts) * 1000 + Math.random() * 500;
            logger.warn({ attempt: attempts, backoff }, 'poll messages.list 429 — backing off');
            await new Promise((r) => setTimeout(r, backoff));
            attempts++;
            continue;
          }
          throw err;
        }
      }

      const messages = data!.messages ?? [];
      for (const m of messages) {
        if (!m.id) continue;
        await processEmailFn(m.id);
        totalProcessed++;
      }

      pageToken = data!.nextPageToken ?? undefined;

      // Advance checkpoint only after successful page (per plan)
      if (messages.length > 0) {
        await setAfter(Date.now());
        logger.debug({ pageToken: pageToken ?? 'done', count: messages.length }, 'poll page checkpoint advanced');
      }
    } while (pageToken);

    logger.info({ totalProcessed, q }, 'pollSweep done');
  } catch (err) {
    logger.error({ err }, 'pollSweep failed');
    throw err;
  } finally {
    pollRunning = false;
  }
}

export function _isPollRunningForTests(): boolean {
  return pollRunning;
}

export function _resetPollRunningForTests(): void {
  pollRunning = false;
}

export function _buildQueryForTests(afterSec: number): string {
  return buildQuery(afterSec);
}

let pollIntervalHandle: NodeJS.Timeout | null = null;

export function schedulePollSweep(intervalMinutes?: number, deps?: PollDeps): NodeJS.Timeout {
  if (pollIntervalHandle) clearInterval(pollIntervalHandle);

  // Default 15 per D-04, reads env validated by env.ts
  const minutes = intervalMinutes ?? Number(process.env.POLL_INTERVAL_MINUTES ?? 15) ?? 15;
  const intervalMs = minutes * 60 * 1000;

  const timer = setInterval(() => {
    pollSweep(deps).catch((err) => logger.error({ err }, 'scheduled pollSweep failed'));
  }, intervalMs);

  if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
    (timer as NodeJS.Timeout & { unref: () => void }).unref();
  }

  pollIntervalHandle = timer;
  return timer;
}

export function _resetPollIntervalForTests(): void {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
}
