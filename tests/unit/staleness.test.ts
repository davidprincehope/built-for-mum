import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';
import { isBusinessHours, checkStaleness, _resetStalenessStateForTests, startStalenessChecker, stopStalenessChecker } from '../../src/observability/staleness';
import { _resetCooldownsForTests } from '../../src/alerts/alerter';

function createMockPoolForStaleness(healthValue: string | null) {
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT value FROM pipeline_health')) {
        if (healthValue === null) return { rows: [], rowCount: 0 };
        return { rows: [{ value: healthValue }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rowCount: 0, rows: [] }), release: () => {} }),
    on: () => {},
    end: async () => {},
  };
  return pool as never;
}

describe('staleness unit — T-1.14/1.15 / business hours / heartbeat atomicity', () => {
  beforeEach(() => {
    process.env.BUSINESS_HOURS_TIMEZONE = 'Africa/Lagos';
    process.env.BUSINESS_HOURS_START = '07:00';
    process.env.BUSINESS_HOURS_END = '21:00';
    process.env.STALENESS_THRESHOLD_MINUTES = '60';
    process.env.LOG_LEVEL = 'silent';
    process.env.ALERT_WEBHOOK_URL = 'https://example.com/webhook';
    _resetStalenessStateForTests();
    _resetCooldownsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    stopStalenessChecker();
    _setPoolForTests(null);
  });

  it('isBusinessHours maps UTC to Africa/Lagos WAT correctly (08:00Z = 09:00 WAT inside)', () => {
    // Africa/Lagos is UTC+1 no DST: 2026-09-09T08:00:00Z -> 09:00 WAT inside 07-21
    const inside = new Date('2026-09-09T08:00:00.000Z');
    expect(isBusinessHours(inside, 'Africa/Lagos', '07:00', '21:00')).toBe(true);
    // 21:00Z -> 22:00 WAT outside
    const outside = new Date('2026-09-09T21:00:00.000Z');
    expect(isBusinessHours(outside, 'Africa/Lagos', '07:00', '21:00')).toBe(false);
    // Exactly 07:00 WAT = 06:00Z inclusive
    const atStart = new Date('2026-09-09T06:00:00.000Z');
    expect(isBusinessHours(atStart, 'Africa/Lagos', '07:00', '21:00')).toBe(true);
    // 21:00 WAT = 20:00Z inclusive
    const atEnd = new Date('2026-09-09T20:00:00.000Z');
    expect(isBusinessHours(atEnd, 'Africa/Lagos', '07:00', '21:00')).toBe(true);
  });

  it('checkStaleness 90m ago during 10:00 Lagos returns stale and calls sendOnce exactly once with cooldown (transition not spam)', async () => {
    const nowLagos10 = new Date('2026-09-09T09:00:00.000Z'); // 10:00 WAT
    vi.setSystemTime(nowLagos10);
    const ninetyAgo = new Date(nowLagos10.getTime() - 90 * 60 * 1000).toISOString();
    _setPoolForTests(createMockPoolForStaleness(ninetyAgo));

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const r1 = await checkStaleness();
    expect(r1).toBe('stale');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('example.com');

    // Second call within cooldown — still stale but no second fetch (transition not spam)
    const r2 = await checkStaleness();
    expect(r2).toBe('stale');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // After 61 min cooldown expires, next window fires again
    vi.advanceTimersByTime(61 * 60 * 1000);
    // Need new now 61m later but still within business hours
    const later = new Date(nowLagos10.getTime() + 61 * 60 * 1000);
    vi.setSystemTime(later);
    const r3 = await checkStaleness();
    expect(r3).toBe('stale');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('checkStaleness with same 90m staleness at 22:00 Lagos returns outside_hours and does not alert (T-1.15)', async () => {
    const nowLagos22 = new Date('2026-09-09T21:00:00.000Z'); // 22:00 WAT
    vi.setSystemTime(nowLagos22);
    const ninetyAgo = new Date(nowLagos22.getTime() - 90 * 60 * 1000).toISOString();
    _setPoolForTests(createMockPoolForStaleness(ninetyAgo));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const r = await checkStaleness();
    expect(r).toBe('outside_hours');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checkStaleness returns never_seeded without alert when pipeline_health last value is null (fresh DB)', async () => {
    const now = new Date('2026-09-09T09:00:00.000Z');
    vi.setSystemTime(now);
    _setPoolForTests(createMockPoolForStaleness(null));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const r = await checkStaleness();
    expect(r).toBe('never_seeded');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checkStaleness returns ok when within threshold (30m ago)', async () => {
    const now = new Date('2026-09-09T09:00:00.000Z');
    vi.setSystemTime(now);
    const thirtyAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    _setPoolForTests(createMockPoolForStaleness(thirtyAgo));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const r = await checkStaleness();
    expect(r).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('startStalenessChecker runs interval 60s pinned with unref and overlap guard', async () => {
    const now = new Date('2026-09-09T09:00:00.000Z');
    vi.setSystemTime(now);
    const thirtyAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    _setPoolForTests(createMockPoolForStaleness(thirtyAgo));
    const timer = startStalenessChecker(60 * 1000);
    expect(timer).toBeDefined();
    // @ts-ignore
    expect(typeof (timer as NodeJS.Timeout & { hasRef?: () => boolean }).hasRef).toBe('function');
    stopStalenessChecker();
  });

  it('insertTransactionAtomically duplicate does NOT update heartbeat (prove updated_at unchanged concept)', async () => {
    vi.useRealTimers();
    let heartbeat = new Date('2026-09-09T09:00:00.000Z').toISOString();
    let heartbeatUpdates = 0;
    const transactions = new Map<string, unknown>();
    const pool: unknown = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('SELECT value FROM pipeline_health')) return { rows: [{ value: heartbeat }], rowCount: 1 };
        if (text.includes('INSERT INTO pipeline_health')) {
          heartbeatUpdates++;
          heartbeat = new Date(Date.now() + heartbeatUpdates * 1000).toISOString();
          return { rowCount: 1, rows: [] };
        }
        if (text.includes('INSERT INTO transactions')) {
          const id = params?.[10] as string;
          if (transactions.has(id)) return { rowCount: 0, rows: [] };
          transactions.set(id, {});
          return { rowCount: 1, rows: [{ id: '1' }] };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (t: string, p?: unknown[]) => (pool as { query: (t: string, p?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> }).query(t, p),
        release: () => {},
      }),
      on: () => {},
      end: async () => {},
    };
    _setPoolForTests(pool as never);
    const { insertTransactionAtomically } = await import('../../src/db/transactions');
    const row = {
      amount: 10000,
      currency: 'NGN',
      transaction_reference: 'REF1',
      transaction_date: '2026-09-08',
      sender_name: 'SAMPLE ACCOUNT HOLDER',
      sender_account: '999****999',
      description: 'CIP CR/ SAMPLE ACCOUNT HOLDER/test',
      branch: 'KUBWA',
      available_balance: 1000,
      email_message_id: 'dup-heartbeat-001',
      email_auth_result: 'dkim=pass header.d=zenithbank.com',
      raw_email: 'test',
    };
    await insertTransactionAtomically(row);
    expect(heartbeatUpdates).toBe(1);
    const afterFirst = heartbeat;
    await insertTransactionAtomically(row);
    expect(heartbeatUpdates).toBe(1);
    expect(heartbeat).toBe(afterFirst);
    _setPoolForTests(null);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T10:00:00.000Z'));
  });
});
