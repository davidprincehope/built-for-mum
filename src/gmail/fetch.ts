export function base64UrlToBase64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad) b += '='.repeat(4 - pad);
  return b;
}

export interface GmailMessageHeaders {
  headers: Record<string, string>;
  subject: string;
  from: string;
  authResults: string;
  bodyB64: string | null;
  rawPayload: unknown;
}

function extractBodyB64(payload: Record<string, unknown> | undefined | null): string | null {
  if (!payload) return null;
  const body = payload.body as Record<string, unknown> | undefined;
  if (body?.data && typeof body.data === 'string') return body.data as string;
  const parts = payload.parts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const mime = (part.mimeType as string) ?? '';
      const pbody = part.body as Record<string, unknown> | undefined;
      if (mime.includes('text/html') && pbody?.data && typeof pbody.data === 'string') {
        return pbody.data as string;
      }
    }
    for (const part of parts) {
      const pbody = part.body as Record<string, unknown> | undefined;
      if (pbody?.data && typeof pbody.data === 'string') return pbody.data as string;
      const nested = part.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(nested)) {
        for (const np of nested) {
          const nb = np.body as Record<string, unknown> | undefined;
          if (nb?.data && typeof nb.data === 'string') return nb.data as string;
        }
      }
    }
  }
  return null;
}

export async function fetchMessage(
  gmail: { users: { messages: { get: (p: Record<string, unknown>) => Promise<{ data: unknown }> } } },
  messageId: string,
): Promise<GmailMessageHeaders> {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const d = data as Record<string, unknown>;
  const payload = d.payload as Record<string, unknown> | undefined;
  const headersArr = (payload?.headers as Array<{ name: string; value: string }>) ?? [];

  const headers: Record<string, string> = {};
  for (const h of headersArr) {
    if (h.name) headers[h.name.toLowerCase()] = h.value ?? '';
  }

  const bodyB64 = extractBodyB64(payload);

  return {
    headers,
    subject: headers['subject'] ?? '',
    from: headers['from'] ?? '',
    authResults: headers['authentication-results'] ?? headers['authentication_results'] ?? '',
    bodyB64,
    rawPayload: data,
  };
}

/**
 * Fetch full message with exponential backoff on 429 rate-limit.
 * Retries up to 3 times with jitter. Used by poll and processEmail paths.
 */
export async function getMessageFull(
  gmail: { users: { messages: { get: (p: Record<string, unknown>) => Promise<{ data: unknown }> } } },
  messageId: string,
  maxRetries = 3,
): Promise<GmailMessageHeaders> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchMessage(gmail, messageId);
    } catch (err: unknown) {
      const e = err as { code?: number; status?: number; response?: { status?: number } };
      const status = e?.code ?? e?.status ?? e?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoffMs));
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// For testing jitter control
export function _sleepForTests(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
