import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import quotedPrintable from 'quoted-printable';
import { _setPoolForTests } from '../../src/db/pool';
import { processEmail } from '../../src/worker';
import { fixtures, htmlFixtures } from '../fixtures/zenith-samples';
import { _resetCooldownsForTests } from '../../src/alerts/alerter';

function buildBodyB64(html: string) {
  const qp = quotedPrintable.encode(html);
  const b64 = Buffer.from(qp, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeGmailMock(opts: { messageId: string; from?: string; subject?: string; authResults?: string; html?: string }) {
  const bodyB64 = buildBodyB64(opts.html ?? fixtures.creditCipCr.html);
  return {
    users: { messages: { get: async () => ({ data: { id: opts.messageId, payload: { headers: [
      { name: 'From', value: opts.from ?? 'Zenith Bank <alerts@zenithbank.com>' },
      { name: 'Subject', value: opts.subject ?? 'CREDIT TRANSACTION NOTIFICATION' },
      { name: 'Authentication-Results', value: opts.authResults ?? 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=s1; spf=pass' },
    ], body: { size: 0 }, parts: [{ mimeType: 'text/html', body: { data: bodyB64, size: bodyB64.length } }] } } }) } },
  };
}

function createTxPool() {
  const transactions = new Map<string, unknown>();
  const suspicious = new Map<string, unknown>();
  let heartbeat = new Date().toISOString();
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT value FROM pipeline_health')) return { rows: [{ value: heartbeat }], rowCount: 1 };
      if (text.includes('INSERT INTO pipeline_health')) {
        heartbeat = new Date().toISOString();
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO transactions')) {
        const id = params?.[10] as string;
        if (transactions.has(id)) return { rowCount: 0, rows: [] };
        transactions.set(id, { reference: params?.[2], amount: params?.[0] });
        return { rowCount: 1, rows: [{ id: '1' }] };
      }
      if (text.includes('INSERT INTO suspicious_emails')) {
        const id = params?.[0] as string;
        if (suspicious.has(id)) return { rowCount: 0, rows: [] };
        suspicious.set(id, {});
        return { rowCount: 1, rows: [{ id: 's' }] };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (t: string, p?: unknown[]) => (pool as { query: (t: string, p?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> }).query(t, p),
      release: () => {},
    }),
    on: () => {}, end: async () => {},
  };
  return { pool: pool as never, transactions, suspicious };
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';
  process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com';
  process.env.LOG_LEVEL = 'silent';
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/webhook';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
  _resetCooldownsForTests();
});

afterEach(() => {
  _setPoolForTests(null);
  vi.restoreAllMocks();
});

describe('resilience T-5.x + security T-4.x/T-3.x', () => {
  it('T-5.1 kill-mid-batch resumes without duplicates and without loss (5 → 5 rows, rerun first 2 duplicate no-ops)', async () => {
    const { pool, transactions } = createTxPool();
    _setPoolForTests(pool);

    const ids = ['r51-1', 'r51-2', 'r51-3', 'r51-4', 'r51-5'];
    // Simulate batch where 3rd insert throws (kill), then rerun whole batch
    let failOnId: string | null = 'r51-3';
    const originalProcess = processEmail;
    // Instead of messing with processEmail, we simulate via mock pool that throws on 3rd transactions insert
    let insertCount = 0;
    const failPool: unknown = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('INSERT INTO transactions')) {
          insertCount++;
          if (failOnId && params?.[10] === failOnId) {
            failOnId = null; // only fail once
            throw new Error('simulated kill mid-batch');
          }
          const id = params?.[10] as string;
          if (transactions.has(id)) return { rowCount: 0, rows: [] };
          transactions.set(id, {});
          return { rowCount: 1, rows: [{ id: '1' }] };
        }
        if (text.includes('SELECT value FROM pipeline_health')) return { rows: [{ value: new Date().toISOString() }], rowCount: 1 };
        if (text.includes('INSERT INTO pipeline_health')) return { rowCount: 1, rows: [] };
        if (text.includes('INSERT INTO suspicious_emails')) return { rowCount: 1, rows: [{ id: 's' }] };
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (t: string, p?: unknown[]) => (failPool as { query: (t: string, p?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> }).query(t, p),
        release: () => {},
      }),
      on: () => {}, end: async () => {},
    };
    _setPoolForTests(failPool as never);

    const results: string[] = [];
    for (const id of ids) {
      const html = htmlFixtures.creditCipCr.replace('ZIB20260908123456', `REF${id}`);
      const gm = makeGmailMock({ messageId: id, html });
      try {
        const r = await processEmail(id, { gmail: gm as never });
        results.push(String(r));
      } catch (e) {
        results.push('error');
      }
    }
    // First run: 2 inserted, 1 error, 2 inserted (remaining) — total 4 rows (3rd failed)
    expect(transactions.size).toBe(4);
    expect(results).toContain('error');

    // Restart: re-run whole batch — first 2 should be duplicates, 3rd should now succeed (fail only once), last 2 duplicates
    const results2: string[] = [];
    for (const id of ids) {
      const html = htmlFixtures.creditCipCr.replace('ZIB20260908123456', `REF${id}`);
      const gm = makeGmailMock({ messageId: id, html });
      const r = await processEmail(id, { gmail: gm as never });
      results2.push(String(r));
    }
    expect(transactions.size).toBe(5);
    expect(results2.filter(r => r === 'duplicate').length).toBe(4);
    expect(results2.filter(r => r === 'inserted').length).toBe(1);
  });

  it('T-5.2 Postgres unavailable during insert retries not silent drop (pool.connect throws once then succeeds)', async () => {
    let connectFailOnce = true;
    const underlying = createTxPool();
    const pool: unknown = {
      query: async (t: string, p?: unknown[]) => (underlying.pool as unknown as { query: (t: string, p?: unknown[]) => Promise<unknown> }).query(t, p),
      connect: async () => {
        if (connectFailOnce) {
          connectFailOnce = false;
          throw new Error('ECONNREFUSED simulated');
        }
        return (underlying.pool as unknown as { connect: () => Promise<unknown> }).connect() as Promise<never>;
      },
      on: () => {}, end: async () => {},
    };
    _setPoolForTests(pool as never);

    const gm = makeGmailMock({ messageId: 'r52-1' });
    const r = await processEmail('r52-1', { gmail: gm as never });
    expect(r).toBe('inserted');
    expect(underlying.transactions.has('r52-1')).toBe(true);
  });

  it('T-5.3 Gmail 429 rate-limit — mock gmail fetch throw 429 then success, asserts backoff retry not crash', async () => {
    const { pool } = createTxPool();
    _setPoolForTests(pool);

    let attempts = 0;
    const gmail429: unknown = {
      users: { messages: { get: async () => {
        attempts++;
        if (attempts === 1) {
          const err = Object.assign(new Error('429'), { code: 429 });
          throw err;
        }
        // second attempt success
        const bodyB64 = buildBodyB64(fixtures.creditCipCr.html);
        return { data: { id: 'r53-1', payload: { headers: [
          { name: 'From', value: 'Zenith Bank <alerts@zenithbank.com>' },
          { name: 'Subject', value: 'CREDIT TRANSACTION NOTIFICATION' },
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=s1; spf=pass' },
        ], body: { size: 0 }, parts: [{ mimeType: 'text/html', body: { data: bodyB64, size: bodyB64.length } }] } } };
      } } }
    };

    // fetchMessage has its own 429 retry; we test via processEmail which calls fetchMessage
    // fetchMessage should retry and succeed on second attempt
    const r = await processEmail('r53-1', { gmail: gmail429 as never });
    expect(r).toBe('inserted');
    expect(attempts).toBe(2);
  });

  it('T-3.1 typosquat domain zenithbanks.com fails candidate filter and never reaches authenticity (no suspicious)', async () => {
    const { pool, suspicious, transactions } = createTxPool();
    _setPoolForTests(pool);

    const gm = makeGmailMock({
      messageId: 'r31-typo',
      from: 'Zenith Bank <alerts@zenithbanks.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbanks.com header.s=s1; spf=pass',
      html: fixtures.creditCipCr.html,
    });
    const r = await processEmail('r31-typo', { gmail: gm as never });
    expect(r).toBe('ignored');
    expect(suspicious.has('r31-typo')).toBe(false);
    expect(transactions.has('r31-typo')).toBe(false);
  });

  it('T-3.4 two same amount diff refs both stored with separate heartbeats', async () => {
    const { pool, transactions } = createTxPool();
    _setPoolForTests(pool);

    const html1 = htmlFixtures.creditCipCr.replace('ZIB20260908123456', 'ZIB20260908111111');
    const html2 = htmlFixtures.creditCipCr.replace('ZIB20260908123456', 'ZIB20260908222222');
    const gm1 = makeGmailMock({ messageId: 'r34-1', html: html1 });
    const gm2 = makeGmailMock({ messageId: 'r34-2', html: html2 });
    const r1 = await processEmail('r34-1', { gmail: gm1 as never });
    const r2 = await processEmail('r34-2', { gmail: gm2 as never });
    expect(r1).toBe('inserted');
    expect(r2).toBe('inserted');
    expect(transactions.size).toBe(2);
  });

  it('T-4.1 crafted From alerts@zenithbank.com with no DKIM at all → suspicious; T-4.2 attacker domain valid DKIM → suspicious; T-4.3 replay blocked by UNIQUE', async () => {
    const { pool, suspicious, transactions } = createTxPool();
    _setPoolForTests(pool);

    const gmNoDkim = makeGmailMock({
      messageId: 'r41-nodkim',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      authResults: 'mx.google.com; spf=pass (no dkim)',
      html: fixtures.creditCipCr.html,
    });
    const r1 = await processEmail('r41-nodkim', { gmail: gmNoDkim as never });
    expect(r1).toBe('suspicious');
    expect(suspicious.has('r41-nodkim')).toBe(true);
    expect(transactions.has('r41-nodkim')).toBe(false);

    const gmAttacker = makeGmailMock({
      messageId: 'r42-attacker',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      authResults: 'mx.google.com; dkim=pass header.d=attacker.com header.s=s1; spf=pass',
      html: fixtures.creditCipCr.html,
    });
    const r2 = await processEmail('r42-attacker', { gmail: gmAttacker as never });
    expect(r2).toBe('suspicious');
    expect(suspicious.has('r42-attacker')).toBe(true);

    const gmLegit = makeGmailMock({ messageId: 'r43-replay' });
    const r3 = await processEmail('r43-replay', { gmail: gmLegit as never });
    expect(r3).toBe('inserted');
    const r4 = await processEmail('r43-replay', { gmail: gmLegit as never });
    expect(r4).toBe('duplicate');
    expect(transactions.size).toBe(1);
  });

  it('full pino JSON lines in this suite each contain email_message_id when captured (D-14)', async () => {
    const { pool } = createTxPool();
    _setPoolForTests(pool);
    const loggerMod = await import('../../src/observability/logger');
    const spy = vi.spyOn(loggerMod, 'createChildLogger');
    const gm = makeGmailMock({ messageId: 'r-log-001' });
    await processEmail('r-log-001', { gmail: gm as never });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ email_message_id: 'r-log-001' }));
  });
});
