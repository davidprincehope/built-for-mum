/**
 * Pub/Sub push handler — POST /gmail/pubsub
 * Decodes Pub/Sub envelope, drives history.list cursor, converges on processEmail,
 * handles 404 historyId expiry by falling back to poll-style resync, ACKs 200.
 *
 * Auth note: Pub/Sub push authenticity via GCP service account JWT verification will
 * be hardened in Phase 6; Phase 1 trusts Railway private URL + envelope shape check.
 * Only Gmail API fetch via OAuth is trusted for auth decisions — never trust envelope emailAddress.
 */

import { logger } from '../observability/logger';
import { getHealth, setHealth } from '../db/health';

export interface PushHandlerDeps {
  gmail?: {
    users: {
      history: {
        list: (p: Record<string, unknown>) => Promise<{ data: unknown }>;
      };
      messages: {
        list: (p: Record<string, unknown>) => Promise<{ data: unknown }>;
        get: (p: Record<string, unknown>) => Promise<{ data: unknown }>;
      };
    };
  };
  getHealthFn?: typeof getHealth;
  setHealthFn?: typeof setHealth;
  processEmailFn?: (id: string) => Promise<unknown>;
  pollSweepFn?: () => Promise<void>;
}

export interface PushRequest {
  body?: {
    message?: {
      data?: string;
      messageId?: string;
      publishTime?: string;
      attributes?: Record<string, string>;
    };
    subscription?: string;
  };
}

export interface PushResponse {
  status: (code: number) => PushResponse;
  send: (body: string) => void;
  json?: (body: unknown) => void;
}

export async function handlePubSubPush(
  req: PushRequest,
  res: PushResponse,
  deps: PushHandlerDeps = {},
): Promise<void> {
  const b64 = req.body?.message?.data;
  if (!b64) {
    res.status(400).send('missing message.data');
    return;
  }

  let envelope: { emailAddress?: string; historyId?: string };
  try {
    const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
    envelope = JSON.parse(jsonStr) as typeof envelope;
  } catch (err) {
    logger.warn({ err }, 'push handler invalid base64/json envelope');
    res.status(400).send('invalid envelope');
    return;
  }

  const newHistoryId = envelope.historyId ? String(envelope.historyId) : null;
  if (!newHistoryId) {
    logger.warn({ envelope }, 'push envelope missing historyId');
    res.status(400).send('missing historyId');
    return;
  }

  const getHealthFn = deps.getHealthFn ?? getHealth;
  const setHealthFn = deps.setHealthFn ?? setHealth;

  const lastHistoryId = await getHealthFn('gmail_history_id');

  // First run — no cursor yet, just store newHistoryId and ACK to avoid full backfill
  if (!lastHistoryId) {
    await setHealthFn('gmail_history_id', newHistoryId);
    logger.info({ newHistoryId }, 'push first-run: stored historyId without history.list');
    res.status(200).send('OK');
    return;
  }

  // Drives history.list with stored startHistoryId (NOT notification historyId)
  // Per anti-pattern: startHistoryId === lastHistoryId variable
  const startHistoryId = lastHistoryId;

  try {
    // Resolve gmail client lazily if not injected
    let gmail: NonNullable<PushHandlerDeps['gmail']>;
    if (deps.gmail) {
      gmail = deps.gmail;
    } else {
      const { getGmailClient } = await import('./auth');
      gmail = getGmailClient() as unknown as typeof gmail;
    }

    const { fetchHistorySince } = await import('./history');
    // Pass gmail client to avoid re-import inside helper
    const ids = await fetchHistorySince(startHistoryId, gmail as unknown as Parameters<typeof fetchHistorySince>[1]);

    const processEmailFn = deps.processEmailFn ?? (async (id: string) => {
      const { processEmail } = await import('../worker');
      return processEmail(id);
    });

    // Only advance cursor after successful batch
    for (const id of ids) {
      await processEmailFn(id);
    }

    await setHealthFn('gmail_history_id', newHistoryId);
    logger.info({ startHistoryId, newHistoryId, count: ids.length }, 'push batch processed');
    res.status(200).send('OK');
  } catch (err: unknown) {
    const e = err as { code?: number; status?: number; message?: string };
    const code = e?.code ?? e?.status;
    const msg = String(e?.message ?? '');

    if (code === 404 || msg.includes('historyId') || msg.includes('notFound')) {
      logger.warn({ err, startHistoryId, newHistoryId }, 'historyId expired 404 — falling back to poll resync');
      try {
        if (deps.pollSweepFn) {
          await deps.pollSweepFn();
        } else {
          const { pollSweep } = await import('./poll');
          await pollSweep();
        }
        await setHealthFn('gmail_history_id', newHistoryId);
        logger.info({ newHistoryId }, 'push 404 fallback done');
        res.status(200).send('OK');
        return;
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr }, 'push 404 fallback failed');
        res.status(500).send('fallback failed');
        return;
      }
    }

    logger.error({ err, startHistoryId }, 'push handler unexpected error');
    res.status(500).send('internal error');
  }
}

// Express-compatible router factory (optional — worker uses Node http directly if express not installed)
export function createPushRouter(deps?: PushHandlerDeps): {
  handle: (req: PushRequest, res: PushResponse) => Promise<void>;
} {
  return {
    handle: (req, res) => handlePubSubPush(req, res, deps),
  };
}
