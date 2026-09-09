/**
 * History cursor helper — wraps Gmail history.list with pagination.
 * Anti-pattern warning: never use Pub/Sub notification's historyId as startHistoryId.
 * Always use stored lastHistoryId (gmail_history_id) and diff against newHistoryId.
 */

import { logger } from '../observability/logger';

export interface HistoryGmailClient {
  users: {
    history: {
      list: (params: {
        userId: string;
        startHistoryId: string;
        historyTypes?: string[];
        pageToken?: string;
        maxResults?: number;
      }) => Promise<{ data: { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string | null } }> }>; nextPageToken?: string | null; historyId?: string | null } }>;
    };
  };
}

/**
 * Fetch messageIds added since lastHistoryId via history.list pagination.
 * Returns empty array if no history. Throws on 404 (caller handles fallback).
 */
export async function fetchHistorySince(
  lastHistoryId: string,
  gmailClient?: HistoryGmailClient,
): Promise<string[]> {
  let gmail: HistoryGmailClient;
  if (gmailClient) {
    gmail = gmailClient;
  } else {
    const { getGmailClient } = await import('./auth');
    gmail = getGmailClient() as unknown as HistoryGmailClient;
  }

  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: lastHistoryId,
      historyTypes: ['messageAdded'],
      pageToken,
    });

    for (const h of data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) ids.push(m.message.id);
      }
    }

    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  logger.debug({ lastHistoryId, count: ids.length }, 'fetchHistorySince done');
  return ids;
}
