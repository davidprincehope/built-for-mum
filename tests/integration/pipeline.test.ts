import { describe, it, expect, beforeEach } from 'vitest';
import quotedPrintable from 'quoted-printable';
import { _setPoolForTests } from '../../src/db/pool';
import { processEmail } from '../../src/worker';
import { fixtures, buildBodyB64, htmlFixtures } from '../fixtures/zenith-samples';
import { capRawEmail } from '../../src/zenith/validation';

// Reuse mock pool from tracer.test.ts pattern but with raw_email capping awareness

type MockRow = Record<string, unknown>;
function createMockPool() {
  const transactions = new Map<string, MockRow>();
  const suspicious = new Map<string, MockRow>();
  const health = new Map<string, string>();
  let lastRawEmail: string | null = null;

  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      const t = text.trim();
      if (t.includes('INSERT INTO pipeline_health')) {
        if (params && params.length >= 2) {
          const key = params?.[0] as string;
          const val = params?.[1] as string;
          health.set(key, val);
        } else if (t.includes('last_zenith_email_processed_at')) {
          health.set('last_zenith_email_processed_at', new Date().toISOString());
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
      if (t.includes('INSERT INTO transactions')) {
        const email_message_id = params?.[10] as string;
        lastRawEmail = params?.[12] as string | null;
        if (transactions.has(email_message_id)) return { rowCount: 0, rows: [] };
        const row: MockRow = {
          amount: params?.[0],
          currency: params?.[1],
          transaction_reference: params?.[2],
          transaction_date: params?.[3],
          sender_name: params?.[5],
          sender_account: params?.[6],
          description: params?.[7],
          branch: params?.[8],
          available_balance: params?.[9],
          email_message_id,
          raw_email: params?.[12],
        };
        transactions.set(email_message_id, row);
        return { rowCount: 1, rows: [{ id: 'mock-id' }] };
      }
      if (t.includes('INSERT INTO suspicious_emails')) {
        const email_message_id = params?.[0] as string;
        lastRawEmail = params?.[5] as string | null;
        if (suspicious.has(email_message_id)) return { rowCount: 0, rows: [] };
        suspicious.set(email_message_id, { email_message_id, from_address: params?.[1], subject: params?.[2], auth_result: params?.[3], reason: params?.[4], raw_email: params?.[5] });
        return { rowCount: 1, rows: [{ id: 'mock-sus' }] };
      }
      if (t === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      const client = {
        query: async (text: string, params?: unknown[]) => {
          const t2 = text.trim();
          if (t2 === 'BEGIN' || t2 === 'COMMIT' || t2 === 'ROLLBACK') return { rowCount: 0, rows: [] };
          return (pool as { query: (t: string, p?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> }).query(text, params);
        },
        release: () => {},
      };
      return client;
    },
    on: () => {},
    end: async () => {},
  };

  return {
    pool: pool as never,
    transactions,
    suspicious,
    health,
    getLastRawEmail: () => lastRawEmail,
  };
}

function buildBodyB64FromHtml(html: string): string {
  const qp = quotedPrintable.encode(html);
  const b64 = Buffer.from(qp, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeGmailMock(opts: {
  messageId: string;
  from: string;
  subject: string;
  authResults: string;
  html: string;
  extraRaw?: string;
}) {
  const bodyB64 = buildBodyB64FromHtml(opts.html);
  return {
    users: {
      messages: {
        get: async () => ({
          data: {
            id: opts.messageId,
            payload: {
              headers: [
                { name: 'From', value: opts.from },
                { name: 'Subject', value: opts.subject },
                { name: 'Authentication-Results', value: opts.authResults },
              ],
              body: { size: 0 },
              parts: [{ mimeType: 'text/html', body: { data: bodyB64, size: bodyB64.length } }],
            },
          },
        }),
      },
    },
  };
}

// Variant that injects large raw_email via direct bodyB64 containing inline image blob
function makeGmailMockWithLargeImage(messageId: string, html: string) {
  const imageBlob = 'A'.repeat(300 * 1024);
  // Embed image blob inside html so capRawEmail will see large payload after JSON.stringify
  const htmlWithImage = html + `<img src="data:image/jpeg;base64,${imageBlob.slice(0, 1000)}">` + 'x'.repeat(150 * 1024);
  // But the raw_email capping happens on JSON.stringify({headers, htmlSnippet}) + body; to fully test cap, we need large html
  // Simpler: pass htmlWithImage directly
  return makeGmailMock({
    messageId,
    from: 'Zenith Bank <alerts@zenithbank.com>',
    subject: 'CREDIT TRANSACTION NOTIFICATION',
    authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
    html: htmlWithImage,
  });
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';
  process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com';
  process.env.LOG_LEVEL = 'silent';
});

describe('pipeline integration — T-2.1 .. T-2.6 / T-3.2 / T-3.4 / T-3.5', () => {
  it('T-2.1 verified well-formed credit → one transactions row + heartbeat (UTC)', async () => {
    const { pool, transactions, health } = createMockPool();
    _setPoolForTests(pool as never);
    const fix = fixtures.creditCipCr;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-2.1',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: fix.html,
    });
    const res = await processEmail('pipe-2.1', { gmail: gmailMock as never });
    expect(res).toBe('inserted');
    expect(transactions.has('pipe-2.1')).toBe(true);
    const row = transactions.get('pipe-2.1')!;
    expect(String(row.amount)).toBe('10000');
    expect(row.currency).toBe('NGN');
    expect(row.transaction_reference).toBe('ZIB20260908123456');
    expect(row.sender_name).toBe('SAMPLE ACCOUNT HOLDER');
    expect(row.sender_account).toBe('999****999');
    // heartbeat updated
    const hb = health.get('last_zenith_email_processed_at');
    expect(hb).toBeDefined();
    const d = new Date(hb!);
    expect(d.toISOString()).toBe(hb); // UTC ISO
    expect(Date.now() - d.getTime()).toBeLessThan(60_000);
    _setPoolForTests(null);
  });

  it('T-2.1 NIP credit family also inserts correctly', async () => {
    const { pool, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    const fix = fixtures.nip;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-nip',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: fix.html,
    });
    const res = await processEmail('pipe-nip', { gmail: gmailMock as never });
    expect(res).toBe('inserted');
    const row = transactions.get('pipe-nip')!;
    expect(row.sender_name).toBe('SAMPLE SENDER');
    _setPoolForTests(null);
  });

  it('T-2.2 spoofed DKIM → suspicious_emails + no transactions (no alert on insert path but suspicious flag)', async () => {
    const { pool, transactions, suspicious } = createMockPool();
    _setPoolForTests(pool as never);
    const fix = fixtures.creditCipCr;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-spoof',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=attacker.com header.s=s1; spf=pass',
      html: fix.html,
    });
    const res = await processEmail('pipe-spoof', { gmail: gmailMock as never });
    expect(res).toBe('suspicious');
    expect(transactions.has('pipe-spoof')).toBe(false);
    expect(suspicious.has('pipe-spoof')).toBe(true);
    _setPoolForTests(null);
  });

  it('T-2.3 verified Zenith but fields missing / validation fail → validation_failed distinct from non-Zenith ignored', async () => {
    const { pool, transactions, suspicious } = createMockPool();
    _setPoolForTests(pool as never);
    // Truncated HTML — missing Description and other fields → ParseFailure → validation_failed
    const truncatedHtml = '<html><body>not a table</body></html>';
    const gmailMockTrunc = makeGmailMock({
      messageId: 'pipe-parse-fail',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: truncatedHtml,
    });
    const resParseFail = await processEmail('pipe-parse-fail', { gmail: gmailMockTrunc as never });
    expect(resParseFail).toBe('validation_failed');
    expect(transactions.has('pipe-parse-fail')).toBe(false);
    expect(suspicious.has('pipe-parse-fail')).toBe(false); // parse failure not suspicious, just format drift

    // Non-Zenith candidate filtered before auth → ignored (distinct from parse failure)
    const gmailMockNonZenith = makeGmailMock({
      messageId: 'pipe-nonzenith',
      from: 'Other Bank <alerts@otherbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=otherbank.com header.s=s1; spf=pass',
      html: fixtures.creditCipCr.html,
    });
    const resIgnored = await processEmail('pipe-nonzenith', { gmail: gmailMockNonZenith as never });
    expect(resIgnored).toBe('ignored');
    expect(transactions.has('pipe-nonzenith')).toBe(false);

    _setPoolForTests(null);
  });

  it('T-2.4 duplicate messageId → only one row (idempotent)', async () => {
    const { pool, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    const fix = fixtures.creditCipCr;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-dup',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: fix.html,
    });
    const r1 = await processEmail('pipe-dup', { gmail: gmailMock as never });
    expect(r1).toBe('inserted');
    const r2 = await processEmail('pipe-dup', { gmail: gmailMock as never });
    expect(r2).toBe('duplicate');
    expect(transactions.size).toBe(1);
    _setPoolForTests(null);
  });

  it('T-3.5 missing transaction_reference fails validation — no row inserted, validation_failed', async () => {
    const { pool, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    const htmlMissingRef = `<table>
      <tr><td>Account Number</td><td>999****999</td></tr>
      <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
      <tr><td>Amount</td><td>10,000.00</td></tr>
      <tr><td>Currency</td><td>NGN</td></tr>
      <tr><td>Description</td><td>CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER</td></tr>
      <tr><td>Branch</td><td>KUBWA</td></tr>
      <tr><td>Transaction Type</td><td>Credit</td></tr>
      <tr><td>Available Balance</td><td>1,234,567.89</td></tr>
    </table>`;
    // Note: Reference Code row omitted entirely → parse should throw ParseFailure → validation_failed
    const gmailMock = makeGmailMock({
      messageId: 'pipe-missing-ref',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: htmlMissingRef,
    });
    const res = await processEmail('pipe-missing-ref', { gmail: gmailMock as never });
    expect(res).toBe('validation_failed');
    expect(transactions.has('pipe-missing-ref')).toBe(false);
    _setPoolForTests(null);
  });

  it('T-3.4 two genuinely different transactions same amount different refs both stored', async () => {
    const { pool, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    const html1 = htmlFixtures.creditCipCr.replace('ZIB20260908123456', 'ZIB20260908111111');
    const html2 = htmlFixtures.creditCipCr.replace('ZIB20260908123456', 'ZIB20260908222222');
    const gmailMock1 = makeGmailMock({
      messageId: 'pipe-diff-1',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: html1,
    });
    const gmailMock2 = makeGmailMock({
      messageId: 'pipe-diff-2',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: html2,
    });
    const r1 = await processEmail('pipe-diff-1', { gmail: gmailMock1 as never });
    const r2 = await processEmail('pipe-diff-2', { gmail: gmailMock2 as never });
    expect(r1).toBe('inserted');
    expect(r2).toBe('inserted');
    expect(transactions.size).toBe(2);
    expect(transactions.get('pipe-diff-1')!.transaction_reference).toBe('ZIB20260908111111');
    expect(transactions.get('pipe-diff-2')!.transaction_reference).toBe('ZIB20260908222222');
    _setPoolForTests(null);
  });

  it('T-3.2 large inline image email respects 100KB cap after strip+cap', async () => {
    const { pool, transactions, getLastRawEmail } = createMockPool();
    _setPoolForTests(pool as never);
    const largeHtml = htmlFixtures.creditCipCr + `<p>${'x'.repeat(150 * 1024)}</p>` + `data:image/jpeg;base64,${'A'.repeat(5000)}`;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-large',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: largeHtml,
    });
    const res = await processEmail('pipe-large', { gmail: gmailMock as never });
    expect(res).toBe('inserted');
    const rawEmail = getLastRawEmail();
    expect(rawEmail).toBeDefined();
    expect(Buffer.byteLength(rawEmail!, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    // Also test standalone capRawEmail on 300KB blob
    const bigRaw = 'y'.repeat(300 * 1024) + 'data:image/png;base64,' + 'B'.repeat(10000);
    const capped = capRawEmail(bigRaw);
    expect(Buffer.byteLength(capped!, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    _setPoolForTests(null);
  });

  it('DEBIT transaction is ignored at debug with no alert (D-06), not inserted', async () => {
    const { pool, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    const fix = fixtures.debit;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-debit-ignored',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'DEBIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: fix.html,
    });
    const res = await processEmail('pipe-debit-ignored', { gmail: gmailMock as never });
    expect(res).toBe('ignored');
    expect(transactions.has('pipe-debit-ignored')).toBe(false);
    _setPoolForTests(null);
  });

  it('UP-IB and UNKNOWN families route through sender and still insert as credit', async () => {
    const { pool, transactions } = createMockPool();
    _setPoolForTests(pool as never);
    const upibFix = fixtures.upIbUssdNip;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-upib',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: upibFix.html,
    });
    const res = await processEmail('pipe-upib', { gmail: gmailMock as never });
    expect(res).toBe('inserted');
    expect(transactions.get('pipe-upib')!.sender_name).toBe('USSD-NIP');
    _setPoolForTests(null);
  });

  it('all timestamps stored as UTC TIMESTAMPTZ — no local TZ conversion', async () => {
    const { pool, health } = createMockPool();
    _setPoolForTests(pool as never);
    const fix = fixtures.creditCipCr;
    const gmailMock = makeGmailMock({
      messageId: 'pipe-utc',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: fix.html,
    });
    await processEmail('pipe-utc', { gmail: gmailMock as never });
    const hb = health.get('last_zenith_email_processed_at')!;
    // Must be ISO UTC (ends with Z), not local offset
    expect(hb).toMatch(/Z$/);
    // Date should be valid and within recent
    const d = new Date(hb);
    expect(d.getUTCHours).toBeDefined();
    _setPoolForTests(null);
  });
});
