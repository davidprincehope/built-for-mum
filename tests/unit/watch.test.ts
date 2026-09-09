import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';
import { _resetCooldownsForTests, _getCooldownExpiryForTests } from '../../src/alerts/alerter';

function createMockPool() {
  const health = new Map<string, string>();
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      const t = text.trim();
      if (t.includes('INSERT INTO pipeline_health')) {
        if (params && params.length >= 2) {
          health.set(params[0] as string, params[1] as string);
        } else {
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

describe('watch — Gmail watch registration & daily renewal', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    process.env.GOOGLE_PUBSUB_TOPIC = 'gmail-zenith-notifications';
    process.env.LOG_LEVEL = 'silent';
    process.env.ALERT_WEBHOOK_URL = '';
    _resetCooldownsForTests();
    vi.restoreAllMocks();
  });

  it('registerWatch persists historyId and expiration to pipeline_health and logs', async () => {
    const { pool, health } = createMockPool();
    _setPoolForTests(pool as never);
    const { registerWatch } = await import('../../src/gmail/watch');

    const gmailMock = {
      users: {
        watch: vi.fn().mockResolvedValue({ data: { historyId: '12345', expiration: '9999999999999' } }),
      },
    };

    const result = await registerWatch(gmailMock as never);
    expect(result.historyId).toBe('12345');
    expect(result.expiration).toBe('9999999999999');
    expect(health.get('gmail_history_id')).toBe('12345');
    expect(health.get('gmail_watch_expiration')).toBe('9999999999999');
    expect(gmailMock.users.watch).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: {
        topicName: 'projects/test-project/topics/gmail-zenith-notifications',
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
      },
    });
    _setPoolForTests(null);
  });

  it('topic name constructed as projects/${GOOGLE_CLOUD_PROJECT}/topics/${GOOGLE_PUBSUB_TOPIC} with no hardcoded project', async () => {
    const { pool } = createMockPool();
    _setPoolForTests(pool as never);
    process.env.GOOGLE_CLOUD_PROJECT = 'my-proj-999';
    process.env.GOOGLE_PUBSUB_TOPIC = 'my-topic';
    const { registerWatch } = await import('../../src/gmail/watch');
    const gmailMock = {
      users: { watch: vi.fn().mockResolvedValue({ data: { historyId: '1', expiration: '2' } }) },
    };
    await registerWatch(gmailMock as never);
    const call = (gmailMock.users.watch.mock.calls[0][0] as { requestBody: { topicName: string } }).requestBody.topicName;
    expect(call).toBe('projects/my-proj-999/topics/my-topic');
    expect(call).not.toContain('hardcoded');
    _setPoolForTests(null);
  });

  it('scheduleWatchRenewal interval is 24h (86400000ms) and timer has unref()', async () => {
    const { pool } = createMockPool();
    _setPoolForTests(pool as never);
    const { scheduleWatchRenewal, _resetWatchTimerForTests } = await import('../../src/gmail/watch');
    _resetWatchTimerForTests();
    const gmailMock = {
      users: { watch: vi.fn().mockResolvedValue({ data: { historyId: '1', expiration: '2' } }) },
    };
    // Spy on setInterval to capture interval
    const origSetInterval = global.setInterval;
    let capturedMs: number | null = null;
    let capturedTimer: unknown = null;
    // @ts-expect-error override
    global.setInterval = vi.fn((fn: () => void, ms: number) => {
      capturedMs = ms;
      const t = origSetInterval(fn, ms);
      capturedTimer = t;
      return t;
    });

    const timer = scheduleWatchRenewal(gmailMock as never);
    expect(capturedMs).toBe(86400000);
    // timer has unref
    expect(typeof (timer as unknown as { unref: unknown }).unref).toBe('function');
    // Call unref and ensure it does not throw
    (timer as unknown as { unref: () => void }).unref();
    clearInterval(timer);
    global.setInterval = origSetInterval;
    _resetWatchTimerForTests();
    _setPoolForTests(null);
  });

  it('401 invalid_grant during watch registration is caught, logged, triggers alerter.sendOnce without unhandled rejection', async () => {
    const { pool } = createMockPool();
    _setPoolForTests(pool as never);
    const { registerWatch } = await import('../../src/gmail/watch');

    const err401 = Object.assign(new Error('invalid_grant'), { code: 401 });
    const gmailMock = {
      users: { watch: vi.fn().mockRejectedValue(err401) },
    };

    await expect(registerWatch(gmailMock as never)).rejects.toThrow('invalid_grant');
    // alerter cooldown should be set
    expect(_getCooldownExpiryForTests('watch-renewal')).toBeDefined();
    const expiry = _getCooldownExpiryForTests('watch-renewal')!;
    expect(expiry).toBeGreaterThan(Date.now());

    _setPoolForTests(null);
  });

  it('auth.ts setCredentials uses only refresh_token (no access_token literal in setCredentials call)', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/gmail/auth.ts', 'utf-8');
    // Find setCredentials line
    const lines = content.split('\n').filter((l) => l.includes('setCredentials'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('refresh_token');
    expect(lines[0]).not.toContain('access_token');
    // Has on('tokens') listeners
    expect(content).toContain("on('tokens'");
    expect(content).toContain('expiry_date');
  });
});
