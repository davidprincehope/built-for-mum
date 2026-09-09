/**
 * Gmail watch registration + daily renewal (D-03).
 *
 * GCP prerequisites (manual, documented here per plan):
 * - Google Cloud Project with Pub/Sub API enabled
 * - Topic e.g. gmail-zenith-notifications with permission for gmail-api-push@system.gserviceaccount.com to publish
 * - Push subscription pointing at Railway worker URL POST /gmail/pubsub
 * Topic name: projects/${GOOGLE_CLOUD_PROJECT}/topics/${GOOGLE_PUBSUB_TOPIC}
 *
 * users.watch expires ~7 days; renewal every 24h gives 6-day buffer (Pitfall 1).
 */

import { logger } from '../observability/logger';
import { setHistoryId, setWatchExpiration } from '../db/health';
import { sendOnce } from '../alerts/alerter';

export interface WatchResult {
  historyId: string;
  expiration: string;
}

type GmailClient = {
  users: {
    watch: (params: {
      userId: string;
      requestBody: { topicName: string; labelIds?: string[]; labelFilterBehavior?: string };
    }) => Promise<{ data: { historyId?: string | null; expiration?: string | null } }>;
  };
};

let watchRenewalTimer: NodeJS.Timeout | null = null;

function getTopicName(): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const topic = process.env.GOOGLE_PUBSUB_TOPIC ?? 'gmail-zenith-notifications';
  if (!project) {
    throw new Error('GOOGLE_CLOUD_PROJECT is required for users.watch topicName');
  }
  // No hardcoded project string — always constructed from env per acceptance criteria
  return `projects/${project}/topics/${topic}`;
}

export async function registerWatch(
  gmailClient?: GmailClient,
): Promise<WatchResult> {
  const topicName = getTopicName();

  // Lazy import to avoid env validation at module-load time; allow injection for tests
  let gmail: GmailClient;
  if (gmailClient) {
    gmail = gmailClient;
  } else {
    const { getGmailClient } = await import('./auth');
    gmail = getGmailClient() as unknown as GmailClient;
  }

  try {
    const { data } = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
      },
    });

    const historyId = data.historyId ?? '';
    const expiration = data.expiration ?? '';

    if (!historyId) {
      throw new Error('users.watch returned empty historyId');
    }

    await setHistoryId(historyId);
    if (expiration) {
      await setWatchExpiration(expiration);
    }

    logger.info({ historyId, expiration, topicName }, 'gmail watch registered');

    return { historyId, expiration };
  } catch (err: unknown) {
    const e = err as { code?: number; status?: number; message?: string; errors?: unknown[] };
    const code = e?.code ?? e?.status;
    // 401 invalid_grant per Pitfall 2 — caught, logged, alerted, not crashed
    if (code === 401 || String(e?.message ?? '').includes('invalid_grant')) {
      logger.error({ err, topicName }, 'gmail watch 401 invalid_grant — refresh token revoked or expired');
      // Fire alert with 1h cooldown; do not throw to caller? Plan says log critical and fire alert but do not crash process
      // For registerWatch itself, we still throw so boot caller can decide; but we also alert here
      await sendOnce('watch-renewal', `Gmail watch 401 invalid_grant: ${e?.message ?? 'unknown'}`, 60 * 60 * 1000);
      throw err;
    }
    throw err;
  }
}

/**
 * Schedule daily renewal. Idempotent: call once at boot. Interval 24h (86400000 ms) with unref().
 */
export function scheduleWatchRenewal(
  gmailClient?: GmailClient,
): NodeJS.Timeout {
  // Clear existing if any (idempotent re-call)
  if (watchRenewalTimer) {
    clearInterval(watchRenewalTimer);
  }

  const intervalMs = 24 * 60 * 60 * 1000; // 86400000
  const timer = setInterval(() => {
    registerWatch(gmailClient).catch((err) => {
      logger.error({ err }, 'watch renewal failed');
      // Cooldown 1h per plan
      sendOnce('watch-renewal', `Gmail watch renewal failed: ${(err as Error).message}`, 60 * 60 * 1000).catch(() => {});
    });
  }, intervalMs);

  // Do not block graceful shutdown
  if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
    (timer as NodeJS.Timeout & { unref: () => void }).unref();
  }

  watchRenewalTimer = timer;
  return timer;
}

export function _resetWatchTimerForTests(): void {
  if (watchRenewalTimer) {
    clearInterval(watchRenewalTimer);
    watchRenewalTimer = null;
  }
}

export function _getWatchTimerForTests(): NodeJS.Timeout | null {
  return watchRenewalTimer;
}
