import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import quotedPrintable from 'quoted-printable';
import { _setPoolForTests } from '../../src/db/pool';
import { processEmail } from '../../src/worker';
import { _resetStalenessStateForTests, checkStaleness } from '../../src/observability/staleness';
import { _resetCooldownsForTests } from '../../src/alerts/alerter';
import { fixtures, htmlFixtures } from '../fixtures/zenith-samples';

function buildBodyB64(html: string) {
  const qp = quotedPrintable.encode(html);
  const b64 = Buffer.from(qp, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeGmailMock(opts: { messageId: string; from: string; subject: string; authResults: string; html: string }) {
  const bodyB64 = buildBodyB64(opts.html);
  return {
    users: { messages: { get: async () => ({ data: { id: opts.messageId, payload: { headers: [
      { name: 'From', value: opts.from },
      { name: 'Subject', value: opts.subject },
      { name: 'Authentication-Results', value: opts.authResults },
    ], body: { size: 0 }, parts: [{ mimeType: 'text/html', body: { data: bodyB64, size: bodyB64.length } }] } } }) } },
  };
}

function createMockPoolWithHeartbeat(initialHeartbeat: string | null) {
  const transactions = new Map<string, unknown>();
  const suspicious = new Map<string, unknown>();
  let heartbeat = initialHeartbeat;
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT value FROM pipeline_health')) {
        if (heartbeat === null) return { rows: [], rowCount: 0 };
        return { rows: [{ value: heartbeat }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO pipeline_health') && text.includes('last_zenith')) {
        if (params && params.length >= 2) heartbeat = params[1] as string;
        else heartbeat = new Date().toISOString();
        if (!heartbeat) heartbeat = new Date().toISOString();
        // normalize to ISO if now() literal
        if (text.includes('now()') && (!params || params.length < 2)) heartbeat = new Date().toISOString();
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO pipeline_health')) {
        const key = params?.[0] as string;
        const val = params?.[1] as string;
        if (key === 'last_zenith_email_processed_at') heartbeat = val;
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO transactions')) {
        const id = params?.[10] as string;
        if (transactions.has(id)) return { rowCount: 0, rows: [] };
        transactions.set(id, { email_message_id: id });
        return { rowCount: 1, rows: [{ id: '1' }] };
      }
      if (text.includes('INSERT INTO suspicious_emails')) {
        const id = params?.[0] as string;
        if (suspicious.has(id)) return { rowCount: 0, rows: [] };
        suspicious.set(id, { email_message_id: id });
        return { rowCount: 1, rows: [{ id: 's1' }] };
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
  return { pool: pool as never, transactions, suspicious, getHeartbeat: () => heartbeat, setHeartbeat: (v: string | null) => { heartbeat = v; } };
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';
  process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com';
  process.env.LOG_LEVEL = 'silent';
  process.env.BUSINESS_HOURS_TIMEZONE = 'Africa/Lagos';
  process.env.BUSINESS_HOURS_START = '07:00';
  process.env.BUSINESS_HOURS_END = '21:00';
  process.env.STALENESS_THRESHOLD_MINUTES = '60';
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/webhook';
  process.env.ALERT_FALLBACK_WEBHOOK_URL = '';
  _resetStalenessStateForTests();
  _resetCooldownsForTests();
});

afterEach(() => {
  _setPoolForTests(null);
  _resetStalenessStateForTests();
  _resetCooldownsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('monitoring T-6.x — staleness + distinct spoof vs drift', () => {
  it('T-6.1 staleness fires exactly once until new email arrives (not spamming)', async () => {
    vi.useFakeTimers();
    const nowLagos10 = new Date('2026-09-09T09:00:00.000Z'); // 10:00 WAT
    vi.setSystemTime(nowLagos10);
    const ninetyAgo = new Date(nowLagos10.getTime() - 90 * 60 * 1000).toISOString();
    const { pool, getHeartbeat, setHeartbeat } = createMockPoolWithHeartbeat(ninetyAgo);
    _setPoolForTests(pool);

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const r1 = await checkStaleness();
    expect(r1).toBe('stale');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const r2 = await checkStaleness();
    expect(r2).toBe('stale');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // not spamming

    // Simulate new email arrives — processCredit resets heartbeat to now
    const fix = fixtures.creditCipCr;
    const gmailMock = makeGmailMock({
      messageId: 'mon-new-001',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=s1; spf=pass',
      html: fix.html,
    });
    // processEmail will update heartbeat via pipeline_health insert now()
    const beforeHb = getHeartbeat();
    await processEmail('mon-new-001', { gmail: gmailMock as never });
    // After insert, heartbeat should be at or near nowLagos10 (mock sets to now ISO via now() literal)
    // Our mock sets heartbeat to Date().toISOString() which is frozen time nowLagos10 due to fake timers
    const afterHb = getHeartbeat();
    expect(afterHb).not.toBe(beforeHb);

    // Subsequent staleness check should be ok (within threshold)
    const r3 = await checkStaleness();
    expect(r3).toBe('ok');
    // No additional alert
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('T-6.2 new email after staleness resets heartbeat and next check passes', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-09T09:00:00.000Z');
    vi.setSystemTime(now);
    const ninetyAgo = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
    const { pool } = createMockPoolWithHeartbeat(ninetyAgo);
    _setPoolForTests(pool);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));

    const rStale = await checkStaleness();
    expect(rStale).toBe('stale');

    // Advance time + insert new credit 30m after stale point
    vi.setSystemTime(new Date(now.getTime() + 5 * 60 * 1000));
    const fix = fixtures.nip;
    const gmailMock = makeGmailMock({
      messageId: 'mon-reset-002',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=s1; spf=pass',
      html: fix.html,
    });
    await processEmail('mon-reset-002', { gmail: gmailMock as never });
    const rOk = await checkStaleness();
    expect(rOk).toBe('ok');
  });

  it('T-6.3 Zenith verified but unparsable batch alerts Zenith format drift not generic error', async () => {
    const { pool } = createMockPoolWithHeartbeat(new Date().toISOString());
    _setPoolForTests(pool);

    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      bodies.push(JSON.parse(opts.body as string).text);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    _resetCooldownsForTests();

    // Missing Description row → ParseFailure field table
    const truncatedHtml = '<html><body><table><tr><td>Account Number</td><td>999****999</td></tr></table></body></html>';
    const gmailMock = makeGmailMock({
      messageId: 'mon-drift-003',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=s1; spf=pass',
      html: truncatedHtml,
    });
    const res = await processEmail('mon-drift-003', { gmail: gmailMock as never });
    expect(res).toBe('validation_failed');
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain('Zenith format drift');
    expect(bodies[0]).toContain('email_message_id=mon-drift-003');
  });

  it('T-6.4 spoofed email alerts possible spoof + row in suspicious_emails not transactions', async () => {
    const { pool, transactions, suspicious } = (() => {
      const tx = new Map<string, unknown>();
      const sus = new Map<string, unknown>();
      const pool: unknown = {
        query: async (text: string, params?: unknown[]) => {
          if (text.includes('SELECT value FROM pipeline_health')) return { rows: [{ value: new Date().toISOString() }], rowCount: 1 };
          if (text.includes('INSERT INTO suspicious_emails')) {
            sus.set(params?.[0] as string, {});
            return { rowCount: 1, rows: [{ id: 's' }] };
          }
          if (text.includes('INSERT INTO transactions')) {
            tx.set(params?.[10] as string, {});
            return { rowCount: 1, rows: [{ id: '1' }] };
          }
          if (text.includes('INSERT INTO pipeline_health')) return { rowCount: 1, rows: [] };
          return { rows: [], rowCount: 0 };
        },
        connect: async () => ({
          query: async (t: string, p?: unknown[]) => (pool as { query: (t: string, p?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> }).query(t, p),
          release: () => {},
        }),
        on: () => {}, end: async () => {},
      };
      return { pool: pool as never, transactions: tx, suspicious: sus };
    })();
    _setPoolForTests(pool);

    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      bodies.push(JSON.parse(opts.body as string).text);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    _resetCooldownsForTests();

    const fix = fixtures.creditCipCr;
    const gmailMock = makeGmailMock({
      messageId: 'mon-spoof-004',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=attacker.com header.s=s1; spf=pass',
      html: fix.html,
    });
    const res = await processEmail('mon-spoof-004', { gmail: gmailMock as never });
    expect(res).toBe('suspicious');
    expect(suspicious.has('mon-spoof-004')).toBe(true);
    expect(transactions.has('mon-spoof-004')).toBe(false);
    expect(bodies[0]).toContain('Possible spoof');
    expect(bodies[0]).toContain('email_message_id=mon-spoof-004');
    expect(bodies[0]).not.toContain('Zenith format drift');
  });

  it('every processEmail stage emits pino JSON with email_message_id per D-14 (spy correlation)', async () => {
    const fix = fixtures.creditCipCr;
    const { pool } = createMockPoolWithHeartbeat(new Date().toISOString());
    _setPoolForTests(pool);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));

    const loggerMod = await import('../../src/observability/logger');
    const childSpy = vi.spyOn(loggerMod, 'createChildLogger');

    const gmailMock = makeGmailMock({
      messageId: 'mon-log-005',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=s1; spf=pass',
      html: fix.html,
    });
    await processEmail('mon-log-005', { gmail: gmailMock as never });
    expect(childSpy).toHaveBeenCalled();
    const bindings = (childSpy.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(bindings).toMatchObject({ email_message_id: 'mon-log-005' });
  });
});
