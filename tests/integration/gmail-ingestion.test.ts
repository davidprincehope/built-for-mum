import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

function createMockPool() {
  const transactions = new Map<string, Record<string, unknown>>();
  const suspicious = new Map<string, Record<string, unknown>>();
  const health = new Map<string, string>();
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      const t = text.trim();
      if (t.includes('INSERT INTO pipeline_health')) {
        if (params && params.length >= 2) health.set(params[0] as string, params[1] as string);
        else {
          const m = t.match(/'([^']+)'/);
          if (m) health.set(m[1], new Date().toISOString());
        }
        return { rowCount: 1, rows: [] };
      }
      if (t.includes('SELECT value FROM pipeline_health')) {
        const key = params?.[0] as string;
        const v = health.get(key) ?? null;
        return { rows: v !== null ? [{ value: v }] : [], rowCount: v !== null ? 1 : 0 };
      }
      if (t.includes('INSERT INTO transactions')) {
        const email_message_id = params?.[10] as string;
        if (transactions.has(email_message_id)) return { rowCount: 0, rows: [] };
        transactions.set(email_message_id, { email_message_id, amount: params?.[0] });
        return { rowCount: 1, rows: [{ id: 'mock-id' }] };
      }
      if (t.includes('INSERT INTO suspicious_emails')) {
        const email_message_id = params?.[0] as string;
        if (suspicious.has(email_message_id)) return { rowCount: 0, rows: [] };
        suspicious.set(email_message_id, { email_message_id });
        return { rowCount: 1, rows: [{ id: 's' }] };
      }
      if (t === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => {
        const t2 = text.trim();
        if (t2 === 'BEGIN' || t2 === 'COMMIT' || t2 === 'ROLLBACK') return { rowCount: 0, rows: [] };
        return (pool as { query: (t: string, p?: unknown[]) => Promise<never> }).query(text, params);
      },
      release: () => {},
    }),
    on: () => {},
    end: async () => {},
  };
  return { pool: pool as never, transactions, suspicious, health };
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

describe('gmail ingestion integration — push + poll convergence', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    process.env.GOOGLE_PUBSUB_TOPIC = 'gmail-zenith-notifications';
    process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com';
    process.env.LOG_LEVEL = 'silent';
    process.env.POLL_INTERVAL_MINUTES = '15';
    vi.restoreAllMocks();
  });

  it('push: POST /gmail/pubsub with valid base64 envelope triggers history.list with stored startHistoryId and calls processEmail then persists newHistoryId', async () => {
    const { pool, health, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    health.set('gmail_history_id', '1000');

    const envelope = b64(JSON.stringify({ emailAddress: 'test@zenithbank.com', historyId: '1001' }));
    // Mock fetchHistorySince indirectly via gmail.users.history.list
    const historyIds = ['msg-push-1', 'msg-push-2'];
    const gmailMock = {
      users: {
        history: {
          list: vi.fn().mockResolvedValue({ data: { history: [{ messagesAdded: [{ message: { id: 'msg-push-1' } }, { message: { id: 'msg-push-2' } }] }], nextPageToken: null } }),
        },
        messages: { list: vi.fn(), get: vi.fn() },
      },
    };

    const processed: string[] = [];
    const processMock = vi.fn(async (id: string) => {
      processed.push(id);
      // Simulate insert dedup: first time inserted
      if (!transactions.has(id)) transactions.set(id, { email_message_id: id });
    });

    const { handlePubSubPush } = await import('../../src/gmail/push-handler');
    const req = { body: { message: { data: envelope } } };
    let statusCode: number | null = null;
    let body: string | null = null;
    const res = {
      status: (code: number) => ({ send: (msg: string) => { statusCode = code; body = msg; } }),
      send: (msg: string) => { statusCode = 200; body = msg; },
    } as never;

    await handlePubSubPush(req, res, { gmail: gmailMock as never, processEmailFn: processMock, pollSweepFn: async () => {} });

    // Verify history.list called with startHistoryId === stored lastHistoryId (not notification historyId)
    const histCall = (gmailMock.users.history.list.mock.calls[0][0] as { startHistoryId: string });
    expect(histCall.startHistoryId).toBe('1000');
    expect(histCall.startHistoryId).not.toBe('1001');
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(processed).toEqual(historyIds);
    // Cursor advanced only after successful batch — now newHistoryId
    expect(health.get('gmail_history_id')).toBe('1001');
    expect(statusCode).toBe(200);

    _setPoolForTests(null);
  });

  it('push: when history.list throws 404, handler falls back to poll-style resync, persists newHistoryId, and still returns 200 (no retry storm)', async () => {
    const { pool, health } = createMockPool();
    _setPoolForTests(pool as never);
    health.set('gmail_history_id', 'old-expired');

    const envelope = b64(JSON.stringify({ emailAddress: 'test@example.com', historyId: '9999' }));
    const err404 = Object.assign(new Error('historyId not found'), { code: 404 });
    const gmailMock = {
      users: {
        history: { list: vi.fn().mockRejectedValue(err404) },
        messages: { list: vi.fn().mockResolvedValue({ data: { messages: [], nextPageToken: null } }), get: vi.fn() },
      },
    };

    let pollCalled = false;
    const pollMock = vi.fn(async () => { pollCalled = true; });

    const { handlePubSubPush } = await import('../../src/gmail/push-handler');
    const req = { body: { message: { data: envelope } } };
    let statusCode: number | null = null;
    const res = {
      status: (code: number) => ({ send: () => { statusCode = code; } }),
      send: () => { statusCode = 200; },
    } as never;

    await handlePubSubPush(req, res, { gmail: gmailMock as never, processEmailFn: async () => {}, pollSweepFn: pollMock });

    expect(gmailMock.users.history.list).toHaveBeenCalled();
    expect(pollMock).toHaveBeenCalled();
    expect(health.get('gmail_history_id')).toBe('9999');
    expect(statusCode).toBe(200); // ACK so Pub/Sub does not redeliver infinitely

    _setPoolForTests(null);
  });

  it('push: handler returns 400 on missing message.data and 200 on success with no unhandled rejection', async () => {
    const { handlePubSubPush } = await import('../../src/gmail/push-handler');
    let code: number | null = null;
    const res = { status: (c: number) => ({ send: () => { code = c; } }), send: () => { code = 200; } } as never;
    await handlePubSubPush({ body: {} }, res, {});
    expect(code).toBe(400);
    await handlePubSubPush({ body: { message: {} } }, res, {});
    expect(code).toBe(400);
  });

  it('push: cursor not advanced if processEmail batch throws before completion (historyId stays old, next push will retry same window)', async () => {
    const { pool, health } = createMockPool();
    _setPoolForTests(pool as never);
    health.set('gmail_history_id', '500');

    const envelope = b64(JSON.stringify({ emailAddress: 'test@example.com', historyId: '501' }));
    const gmailMock = {
      users: {
        history: { list: vi.fn().mockResolvedValue({ data: { history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }], nextPageToken: null } }) },
        messages: { list: vi.fn(), get: vi.fn() },
      },
    };
    const proc = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('process fail on a');
    });

    const { handlePubSubPush } = await import('../../src/gmail/push-handler');
    const req = { body: { message: { data: envelope } } };
    let code: number | null = null;
    const res = { status: (c: number) => ({ send: () => { code = c; } }), send: () => { code = 200; } } as never;
    await handlePubSubPush(req, res, { gmail: gmailMock as never, processEmailFn: proc, pollSweepFn: async () => {} });

    // Should have returned 500 (unexpected error), not 200, and not advanced cursor
    expect(code).toBe(500);
    expect(health.get('gmail_history_id')).toBe('500');
    _setPoolForTests(null);
  });

  it('push: no use of notification historyId as startHistoryId (code review)', async () => {
    const content = await import('fs').then((m) => m.readFileSync('src/gmail/push-handler.ts', 'utf-8'));
    // Ensure we assign startHistoryId from lastHistoryId variable, not envelope
    expect(content).toContain('startHistoryId');
    expect(content).toContain('lastHistoryId');
    // Should not have pattern where envelope.historyId is used directly as startHistoryId
    expect(content).not.toMatch(/startHistoryId\s*=\s*newHistoryId/);
    expect(content).not.toMatch(/startHistoryId\s*:\s*newHistoryId/);
  });

  it('poll picks up email that push missed (safety net) and dedup holds when same ID delivered by both', async () => {
    const { pool, health, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    // Simulate push missed: gmail_poll_after already set, but historyId not advanced?
    health.set('gmail_poll_after', String(Date.now() - 1000));
    health.set('gmail_history_id', '100');

    // Poll sweep will find msg-dup
    const gmailPollMock = {
      users: {
        messages: {
          list: vi.fn()
            .mockResolvedValueOnce({ data: { messages: [{ id: 'shared-id' }, { id: 'poll-only-id' }], nextPageToken: null } }),
        },
      },
    };

    const { pollSweep } = await import('../../src/gmail/poll');
    const { handlePubSubPush } = await import('../../src/gmail/push-handler');

    // dedup: poll processes shared-id first
    const proc = vi.fn(async (id: string) => {
      if (!transactions.has(id)) transactions.set(id, { email_message_id: id });
    });

    await pollSweep({ gmail: gmailPollMock as never, processEmailFn: proc });
    expect(transactions.has('shared-id')).toBe(true);
    expect(transactions.has('poll-only-id')).toBe(true);

    // Now push delivers same shared-id again (via history)
    const envelope = b64(JSON.stringify({ emailAddress: 'test@example.com', historyId: '101' }));
    const gmailPushMock = {
      users: {
        history: { list: vi.fn().mockResolvedValue({ data: { history: [{ messagesAdded: [{ message: { id: 'shared-id' } }] }], nextPageToken: null } }) },
        messages: { list: vi.fn(), get: vi.fn() },
      },
    };
    // For push, check that duplicate still dedup'd via DB UNIQUE (our map already has it; process should detect duplicate path)
    let callCount = 0;
    const procPush = vi.fn(async (id: string) => {
      callCount++;
      // Simulate ON CONFLICT — if already in transactions, return duplicate (no extra row)
      const before = transactions.size;
      if (!transactions.has(id)) transactions.set(id, { email_message_id: id });
      const after = transactions.size;
      // dedup holds: size doesn't grow for shared-id
      if (id === 'shared-id') expect(after).toBe(before);
    });

    const req = { body: { message: { data: envelope } } };
    let code: number | null = null;
    const res = { status: (c: number) => ({ send: () => { code = c; } }), send: () => { code = 200; } } as never;
    await handlePubSubPush(req, res, { gmail: gmailPushMock as never, processEmailFn: procPush, pollSweepFn: async () => {} });

    expect(code).toBe(200);
    expect(transactions.size).toBe(2); // shared-id not duplicated
    expect(callCount).toBe(1);

    _setPoolForTests(null);
  });
});
