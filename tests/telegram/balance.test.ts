import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

function mockPoolForBalance(rows: Array<Record<string, string | null>>) {
  const pool: unknown = {
    query: async (text: string) => {
      if (text.includes('FROM transactions ORDER BY transaction_date DESC')) {
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    },
    on: () => {},
    end: async () => {},
  };
  return pool as never;
}

describe('telegram balance — buildBalanceReply', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    _setPoolForTests(null);
    vi.restoreAllMocks();
  });

  it('returns No transactions when no row', async () => {
    _setPoolForTests(mockPoolForBalance([]));
    const { buildBalanceReply } = await import('../../src/telegram/balance');
    const res = await buildBalanceReply();
    expect(res.text).toMatch(/No transactions yet/);
    _setPoolForTests(null);
  });

  it('formats available, current, and last TX line ordered DESC with escapeHtml', async () => {
    const rows = [
      {
        available_balance: '319599.78',
        current_balance: '319599.78',
        amount: '100.00',
        currency: 'NGN',
        sender_name: 'EXAMPLE MERCHANT',
        transaction_date: '2026-09-10',
        transaction_time: '10:49:22',
        description: 'NIP/FCMB/EXAMPLE MERCHANT/NIP Transfer',
      },
    ];
    _setPoolForTests(mockPoolForBalance(rows));
    const { buildBalanceReply } = await import('../../src/telegram/balance');
    const res = await buildBalanceReply();
    expect(res.text).toContain('Available: 319599.78');
    expect(res.text).toContain('Current: 319599.78');
    expect(res.text).toContain('100.00 NGN from EXAMPLE MERCHANT');
    expect(res.text).toContain('2026-09-10');
    _setPoolForTests(null);
  });

  it('null balances render as em dash not 0', async () => {
    const rows = [
      {
        available_balance: null,
        current_balance: null,
        amount: '50.00',
        currency: 'NGN',
        sender_name: 'SAMPLE SENDER',
        transaction_date: '2026-09-09',
        transaction_time: '12:00:00',
        description: 'CIP CR/SAMPLE SENDER/Transfer',
      },
    ];
    _setPoolForTests(mockPoolForBalance(rows));
    const { buildBalanceReply } = await import('../../src/telegram/balance');
    const res = await buildBalanceReply();
    expect(res.text).toContain('Available: —');
    expect(res.text).toContain('Current: —');
    expect(res.text).not.toContain('Available: 0');
    _setPoolForTests(null);
  });

  it('escapes HTML in sender_name', async () => {
    const rows = [
      {
        available_balance: '100.00',
        current_balance: '100.00',
        amount: '10.00',
        currency: 'NGN',
        sender_name: '<b>evil</b>',
        transaction_date: '2026-09-10',
        transaction_time: '10:00:00',
        description: 'NIP/BANK/<b>evil</b>/desc',
      },
    ];
    _setPoolForTests(mockPoolForBalance(rows));
    const { buildBalanceReply } = await import('../../src/telegram/balance');
    const res = await buildBalanceReply();
    expect(res.text).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(res.text).not.toContain('<b>evil</b>');
    _setPoolForTests(null);
  });

  it('uses ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1', async () => {
    let capturedSql = '';
    const pool: unknown = {
      query: async (text: string) => {
        capturedSql = text;
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      },
      on: () => {},
      end: async () => {},
    };
    _setPoolForTests(pool as never);
    const { buildBalanceReply } = await import('../../src/telegram/balance');
    await buildBalanceReply();
    expect(capturedSql).toContain('ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1');
    _setPoolForTests(null);
  });
});
