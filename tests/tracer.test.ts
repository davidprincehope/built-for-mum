import { describe, it, expect, beforeEach } from 'vitest';
import quotedPrintable from 'quoted-printable';
import { verifyAuthenticity } from '../src/zenith/authenticity';
import { decodeStrict, base64UrlToBase64 } from '../src/zenith/decode';
import { _setPoolForTests } from '../src/db/pool';
import { processEmail } from '../src/worker';
import * as loggerMod from '../src/observability/logger';

// ---- in-memory mock pool ----
type MockRow = Record<string, unknown>;
function createMockPool() {
  const transactions = new Map<string, MockRow>();
  const suspicious = new Map<string, MockRow>();
  const health = new Map<string, string>();

  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      const t = text.trim();
      if (t.includes('INSERT INTO pipeline_health')) {
        // tracer atomic path uses literal now() with no params; health helper uses params (key, value)
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
        };
        transactions.set(email_message_id, row);
        return { rowCount: 1, rows: [{ id: 'mock-id' }] };
      }
      if (t.includes('INSERT INTO suspicious_emails')) {
        const email_message_id = params?.[0] as string;
        if (suspicious.has(email_message_id)) return { rowCount: 0, rows: [] };
        suspicious.set(email_message_id, { email_message_id, from_address: params?.[1], subject: params?.[2], auth_result: params?.[3], reason: params?.[4] });
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

  return { pool: pool as never, transactions, suspicious, health };
}

function buildBodyB64(html: string): string {
  const qp = quotedPrintable.encode(html);
  const b64 = Buffer.from(qp, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const fullCreditHtml = `<table>
  <tr><td>Account Number</td><td>999****999</td></tr>
  <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
  <tr><td>Amount</td><td>10,000.00</td></tr>
  <tr><td>Currency</td><td>NGN</td></tr>
  <tr><td>Description</td><td>CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER</td></tr>
  <tr><td>Reference Code</td><td>ZIB20260908123456</td></tr>
  <tr><td>Branch</td><td>KUBWA</td></tr>
  <tr><td>Transaction Type</td><td>Credit</td></tr>
  <tr><td>Available Balance</td><td>1,234,567.89</td></tr>
</table>`;

function makeGmailMock(opts: {
  messageId: string;
  from: string;
  subject: string;
  authResults: string;
  html: string;
}) {
  const bodyB64 = buildBodyB64(opts.html);
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
              parts: [
                {
                  mimeType: 'text/html',
                  body: { data: bodyB64, size: bodyB64.length },
                },
              ],
            },
          },
        }),
      },
    },
  };
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';
  process.env.ZENITH_SENDER_DOMAINS = 'zenithbank.com';
  process.env.LOG_LEVEL = 'silent';
});

describe('tracer: end-to-end CREDIT TRANSACTION NOTIFICATION', () => {
  it('inserts one correct CREDIT row and heartbeat, dedup on replay', async () => {
    const { pool, transactions, health } = createMockPool();
    _setPoolForTests(pool as never);

    // Verify logger child bindings via spy — prove correlation key threading (no patching of read-only export)
    const spy = vi.spyOn(loggerMod, 'createChildLogger');
    const gmailMock = makeGmailMock({
      messageId: 'tracer-001',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      html: fullCreditHtml,
    });

    const result1 = await processEmail('tracer-001', { gmail: gmailMock as never });
    expect(result1).toBe('inserted');

    const row = transactions.get('tracer-001')!;
    expect(row).toBeDefined();
    expect(String(row.amount)).toBe('10000');
    expect(row.currency).toBe('NGN');
    expect(row.transaction_reference).toBe('ZIB20260908123456');
    expect(row.sender_name).toBe('SAMPLE ACCOUNT HOLDER');
    expect(row.sender_account).toBe('999****999');
    expect(row.branch).toBe('KUBWA');

    const hb = health.get('last_zenith_email_processed_at');
    expect(hb).toBeDefined();
    const ageMs = Date.now() - new Date(hb!).getTime();
    expect(ageMs).toBeLessThan(60_000);

    const result2 = await processEmail('tracer-001', { gmail: gmailMock as never });
    expect(result2).toBe('duplicate');
    expect(transactions.size).toBe(1);

    // All processEmail calls should have created a child logger bound to email_message_id
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect((call[0] as Record<string, unknown>).email_message_id).toBe('tracer-001');
    }
    spy.mockRestore();
    _setPoolForTests(null);
  });

  it('routes attacker DKIM domain to suspicious_emails not transactions', async () => {
    const { pool, transactions, suspicious } = createMockPool();
    _setPoolForTests(pool as never);

    const gmailMock = makeGmailMock({
      messageId: 'tracer-attacker',
      from: 'Zenith Bank <alerts@zenithbank.com>',
      subject: 'CREDIT TRANSACTION NOTIFICATION',
      authResults: 'mx.google.com; dkim=pass header.d=attacker.com header.s=s1; spf=pass',
      html: fullCreditHtml,
    });

    const result = await processEmail('tracer-attacker', { gmail: gmailMock as never });
    expect(result).toBe('suspicious');
    expect(transactions.has('tracer-attacker')).toBe(false);
    expect(suspicious.has('tracer-attacker')).toBe(true);
    _setPoolForTests(null);
  });

  it('verifyAuthenticity rejects attacker domain fixture', () => {
    const r = verifyAuthenticity('mx.google.com; dkim=pass header.d=attacker.com header.s=s1; spf=pass');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/mismatch|d!=/i);
  });

  it('verifyAuthenticity clause-bound: attacker pass + zenith fail vs zenith pass', () => {
    const headerFail = 'mx.google.com; dkim=pass header.d=attacker.com; dkim=fail header.d=zenithbank.com';
    expect(verifyAuthenticity(headerFail).pass).toBe(false);
    const headerPass = 'mx.google.com; dkim=fail header.d=attacker.com; dkim=pass header.d=zenithbank.com';
    expect(verifyAuthenticity(headerPass).pass).toBe(true);
  });

  it('decodeStrict throws on non-base64 input (no silent fallback) per D-09', () => {
    expect(() => decodeStrict('!!!not-base64!!!')).toThrow(/strict-decode: base64 fail/);
    expect(() => decodeStrict('')).toThrow(/base64 fail/);
  });

  it('decodeStrict round-trips the fixture B64->QP->HTML', () => {
    const b64 = buildBodyB64(fullCreditHtml);
    const decoded = decodeStrict(b64);
    expect(decoded).toContain('Account Number');
    expect(decoded).toContain('999****999');
    expect(decoded).toContain('SAMPLE ACCOUNT HOLDER');
  });

  it('base64Url normalization converts -_ to +/ and pads', () => {
    expect(base64UrlToBase64('YWJj')).toBe('YWJj');
    expect(base64UrlToBase64('YWJjZA')).toBe('YWJjZA==');
    expect(base64UrlToBase64('ab-_')).toBe('ab+/');
  });
});
