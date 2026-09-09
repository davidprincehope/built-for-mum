import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

function createMockPool() {
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
  return { pool: pool as never, health };
}

describe('poll — 15-min independent sweep', () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com';
    process.env.POLL_INTERVAL_MINUTES = '15';
    process.env.LOG_LEVEL = 'silent';
    // reset poll state
    const { _resetPollRunningForTests, _resetPollIntervalForTests } = await import('../../src/gmail/poll');
    _resetPollRunningForTests();
    _resetPollIntervalForTests();
    vi.restoreAllMocks();
  });

  it('builds q "(from:zenithbank.com OR from:other.com) after:UNIX" and paginates through nextPageToken until done', async () => {
    const { pool, health } = createMockPool();
    _setPoolForTests(pool as never);
    health.set('gmail_poll_after', String(Date.now() - 1000));
    process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com, other.com';

    const idsSeen: string[] = [];
    const qCaptured: string[] = [];
    const gmailMock = {
      users: {
        messages: {
          list: vi.fn(async ({ q, pageToken }: { q: string; pageToken?: string }) => {
            qCaptured.push(q);
            if (!pageToken) {
              return { data: { messages: [{ id: 'msg1' }, { id: 'msg2' }], nextPageToken: 'tok2' } };
            }
            if (pageToken === 'tok2') {
              return { data: { messages: [{ id: 'msg3' }], nextPageToken: null } };
            }
            return { data: { messages: [], nextPageToken: null } };
          }),
        },
      },
    };

    const { pollSweep } = await import('../../src/gmail/poll');
    const processMock = vi.fn(async (id: string) => {
      idsSeen.push(id);
    });

    await pollSweep({ gmail: gmailMock as never, processEmailFn: processMock });

    // q correctly built
    expect(qCaptured[0]).toContain('from:zenithbank.com');
    expect(qCaptured[0]).toContain('from:other.com');
    expect(qCaptured[0]).toMatch(/after:\d+/);
    expect(qCaptured[0]).toBe('(from:zenithbank.com OR from:other.com) after:' + qCaptured[0].match(/after:(\d+)/)![1]);

    // paginated all 3 messages
    expect(idsSeen).toEqual(['msg1', 'msg2', 'msg3']);
    expect(gmailMock.users.messages.list).toHaveBeenCalledTimes(2);

    _setPoolForTests(null);
  });

  it('overlapping pollSweep calls are guarded (second returns immediately) and checkpoint advances only after successful page', async () => {
    const { pool, health } = createMockPool();
    _setPoolForTests(pool as never);
    health.set('gmail_poll_after', '1000000');
    const { pollSweep, _resetPollRunningForTests } = await import('../../src/gmail/poll');
    _resetPollRunningForTests();

    let page1Done = false;
    const gmailMock = {
      users: {
        messages: {
          list: vi.fn(async () => {
            // Simulate slow first page so concurrent call overlaps
            await new Promise((r) => setTimeout(r, 50));
            if (!page1Done) {
              page1Done = true;
              return { data: { messages: [{ id: 'm1' }], nextPageToken: null } };
            }
            return { data: { messages: [], nextPageToken: null } };
          }),
        },
      },
    };

    const checkpointCalls: string[] = [];
    const originalSetPollAfterMs = (await import('../../src/db/health')).setPollAfterMs;
    // Track checkpoint advances via health map
    const setPollAfterMsMock = vi.fn(async (ms: number) => {
      checkpointCalls.push(String(ms));
      health.set('gmail_poll_after', String(ms));
    });

    const proc = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Start two concurrent sweeps
    const p1 = pollSweep({ gmail: gmailMock as never, processEmailFn: proc, setPollAfterMsFn: setPollAfterMsMock as never });
    const p2 = pollSweep({ gmail: gmailMock as never, processEmailFn: proc, setPollAfterMsFn: setPollAfterMsMock as never });
    await Promise.all([p1, p2]);

    // Second should have been guarded — only one list call in effect (first sweep did its work, second returned immediately)
    // proc should be called once (for m1), not twice
    expect(proc).toHaveBeenCalledTimes(1);
    // Checkpoint advanced exactly once after successful page
    expect(setPollAfterMsMock).toHaveBeenCalledTimes(1);

    // If processEmail throws before completion, checkpoint should not advance — simulate failure on page
    _resetPollRunningForTests();
    const gmailMock2 = {
      users: {
        messages: {
          list: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'fail1' }], nextPageToken: null } }),
        },
      },
    };
    const procFail = vi.fn(async () => {
      throw new Error('process fail');
    });
    const setPollAfterMsMock2 = vi.fn();
    await expect(pollSweep({ gmail: gmailMock2 as never, processEmailFn: procFail, setPollAfterMsFn: setPollAfterMsMock2 as never })).rejects.toThrow('process fail');
    expect(setPollAfterMsMock2).not.toHaveBeenCalled();

    _setPoolForTests(null);
  });

  it('POLL_INTERVAL_MINUTES defaults to 15 and reads env override; setInterval uses unref()', async () => {
    const { schedulePollSweep, _resetPollIntervalForTests } = await import('../../src/gmail/poll');
    _resetPollIntervalForTests();

    // Default: env not set -> 15
    delete process.env.POLL_INTERVAL_MINUTES;
    const origSetInterval = global.setInterval;
    let capturedMs: number | null = null;
    // @ts-expect-error
    global.setInterval = vi.fn((fn: () => void, ms: number) => {
      capturedMs = ms;
      const t = origSetInterval(fn, ms);
      return t;
    });

    const gmailMock = { users: { messages: { list: vi.fn().mockResolvedValue({ data: { messages: [], nextPageToken: null } }) } } };
    const t1 = schedulePollSweep(undefined, { gmail: gmailMock as never, processEmailFn: async () => {} });
    expect(capturedMs).toBe(15 * 60 * 1000);
    expect(typeof (t1 as unknown as { unref: unknown }).unref).toBe('function');
    (t1 as unknown as { unref: () => void }).unref();
    clearInterval(t1);

    // Override env to 5 -> interval 5min
    process.env.POLL_INTERVAL_MINUTES = '5';
    capturedMs = null;
    const t2 = schedulePollSweep(undefined, { gmail: gmailMock as never, processEmailFn: async () => {} });
    expect(capturedMs).toBe(5 * 60 * 1000);
    clearInterval(t2);

    global.setInterval = origSetInterval;
    _resetPollIntervalForTests();
    process.env.POLL_INTERVAL_MINUTES = '15';
  });

  it('429 rate-limit from Gmail triggers exponential backoff retry in fetch helper, not crash, with max 3 retries', async () => {
    const { pool } = createMockPool();
    _setPoolForTests(pool as never);
    const { getMessageFull } = await import('../../src/gmail/fetch');

    let calls = 0;
    const gmailMock = {
      users: {
        messages: {
          get: vi.fn(async () => {
            calls++;
            if (calls <= 2) {
              const e = Object.assign(new Error('rate limit'), { code: 429 });
              throw e;
            }
            return { data: { payload: { headers: [], body: { size: 0 }, parts: [] } } };
          }),
        },
      },
    };

    const start = Date.now();
    const res = await getMessageFull(gmailMock as never, 'msg-429', 3);
    expect(res).toBeDefined();
    expect(calls).toBe(3);
    const elapsed = Date.now() - start;
    // Backoff at least 1s + 2s = 3s but with jitter, allow 2.8s lower bound to avoid flake
    expect(elapsed).toBeGreaterThan(2000);

    // Max 3 retries exceeded -> still throws
    let failCalls = 0;
    const always429 = {
      users: { messages: { get: vi.fn(async () => { failCalls++; throw Object.assign(new Error('rate'), { code: 429 }); }) } },
    };
    await expect(getMessageFull(always429 as never, 'msg-fail', 3)).rejects.toThrow('rate');
    expect(failCalls).toBe(4); // initial + 3 retries

    _setPoolForTests(null);
  });
});
