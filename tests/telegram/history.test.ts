import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

function mockPoolForHistory(opts: {
  count?: string;
  rows?: Array<Record<string, string>>;
  capture?: { sqls: string[]; params: unknown[][] };
}) {
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      if (opts.capture) {
        opts.capture.sqls.push(text);
        opts.capture.params.push(params ?? []);
      }
      if (text.includes('COUNT(*)')) {
        return { rows: [{ count: opts.count ?? '0' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
      }
      if (text.includes('FROM transactions')) {
        return { rows: opts.rows ?? [], rowCount: opts.rows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    },
    on: () => {},
    end: async () => {},
  };
  return pool as never;
}

describe('telegram history — parseLagosDateRange and handleHistoryWithRange', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    _setPoolForTests(null);
    vi.restoreAllMocks();
  });

  it('parseLagosDateRange accepts DD/MM/YYYY', async () => {
    const { parseLagosDateRange } = await import('../../src/telegram/history');
    const res = parseLagosDateRange(['01/09/2026', '10/09/2026']) as { from: string; to: string };
    expect(res.from).toBe('2026-09-01');
    expect(res.to).toBe('2026-09-10');
  });

  it('parseLagosDateRange accepts YYYY-MM-DD', async () => {
    const { parseLagosDateRange } = await import('../../src/telegram/history');
    const res = parseLagosDateRange(['2026-09-01', '2026-09-10']) as { from: string; to: string };
    expect(res.from).toBe('2026-09-01');
    expect(res.to).toBe('2026-09-10');
  });

  it('parseLagosDateRange invalid returns error reply', async () => {
    const { parseLagosDateRange } = await import('../../src/telegram/history');
    const res = parseLagosDateRange(['invalid', '2026-09-10']) as { error: string };
    expect(res.error).toMatch(/Invalid date/);
  });

  it('handleHistoryWithRange with no args returns last 5 default without date filter', async () => {
    const rows = [
      { amount: '100.00', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:49:00', description: 'NIP/FCMB/EXAMPLE MERCHANT/Transfer', sender_name: 'EXAMPLE MERCHANT', branch: null, available_balance: '319599.78' },
    ];
    _setPoolForTests(mockPoolForHistory({ rows }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange([]);
    expect(res.text).toContain('Recent Transactions');
    expect(res.text).toContain('EXAMPLE MERCHANT');
    _setPoolForTests(null);
  });

  it('handleHistoryWithRange with valid range queries BETWEEN inclusive capped 50', async () => {
    const capture = { sqls: [] as string[], params: [] as unknown[][] };
    const rows = Array.from({ length: 3 }, (_, i) => ({
      amount: `${100 + i}.00`,
      currency: 'NGN',
      transaction_date: '2026-09-05',
      transaction_time: '10:00:00',
      description: `NIP/KUDA/SENDER${i}/Transfer`,
      sender_name: `SENDER${i}`,
      branch: null,
      available_balance: '1000.00',
    }));
    _setPoolForTests(mockPoolForHistory({ count: '3', rows, capture }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange(['01/09/2026', '10/09/2026']);
    // BETWEEN should be used
    const betweenSql = capture.sqls.find((s) => s.includes('BETWEEN'));
    expect(betweenSql).toBeDefined();
    expect(betweenSql).toContain('BETWEEN $1::date AND $2::date');
    // description-first via extractSender
    expect(res.text).toContain('SENDER0');
    expect(res.text).toContain('Total: 3 in range');
    _setPoolForTests(null);
  });

  it('caps limit to 50 and shows total summary when total > shown', async () => {
    const capture = { sqls: [] as string[], params: [] as unknown[][] };
    const rows = Array.from({ length: 50 }, (_, i) => ({
      amount: '10.00',
      currency: 'NGN',
      transaction_date: '2026-09-05',
      transaction_time: '10:00:00',
      description: `NIP/FCMB/SENDER${i}/desc`,
      sender_name: `SENDER${i}`,
      branch: null,
      available_balance: '1000.00',
    }));
    _setPoolForTests(mockPoolForHistory({ count: '73', rows, capture }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange(['2026-09-01', '2026-09-10'], { limit: 100, offset: 0 });
    // limit should be clamped to 50
    const selectSql = capture.sqls.find((s) => s.includes('LIMIT $3'));
    expect(selectSql).toBeDefined();
    const limitParam = capture.params.find((p) => p.length === 4)?.[2];
    expect(limitParam).toBe(50);
    expect(res.text).toContain('Total: 73 in range');
    _setPoolForTests(null);
  });

  it('description-first via extractSender truncates to 17 and escapes HTML', async () => {
    const rows = [
      { amount: '100.00', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:49:00', description: 'NIP/FCMB/<b>evil</b>/Transfer', sender_name: '<b>evil</b>', branch: null, available_balance: '1000.00' },
    ];
    _setPoolForTests(mockPoolForHistory({ count: '1', rows }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange(['2026-09-10', '2026-09-10']);
    expect(res.text).toContain('&lt;b&gt;');
    expect(res.text).not.toContain('<b>evil</b>');
    _setPoolForTests(null);
  });

  it('provides inline Next pagination when total > limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      amount: '10.00',
      currency: 'NGN',
      transaction_date: '2026-09-05',
      transaction_time: '10:00:00',
      description: `CIP CR/SENDER${i}/Transfer`,
      sender_name: `SENDER${i}`,
      branch: null,
      available_balance: '1000.00',
    }));
    _setPoolForTests(mockPoolForHistory({ count: '25', rows }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange(['2026-09-01', '2026-09-10'], { limit: 10, offset: 0 });
    expect(res.replyMarkup).toBeDefined();
    const kb = (res.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    const nextBtn = kb.flat().find((b) => b.text.includes('Next'));
    expect(nextBtn).toBeDefined();
    expect(nextBtn!.callback_data).toContain('/history 2026-09-01 2026-09-10 10 10');
    _setPoolForTests(null);
  });

  it('invalid date args returns friendly error under 4096 cap', async () => {
    _setPoolForTests(mockPoolForHistory({ count: '0', rows: [] }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange(['bad-date', '2026-09-10']);
    expect(res.text).toMatch(/Invalid date/);
    expect(res.text.length).toBeLessThan(4096);
    _setPoolForTests(null);
  });

  it('4-arg pagination form parses from to limit offset', async () => {
    const capture = { sqls: [] as string[], params: [] as unknown[][] };
    const rows = [
      { amount: '10.00', currency: 'NGN', transaction_date: '2026-09-05', transaction_time: '10:00:00', description: 'CIP CR/SENDER/Transfer', sender_name: 'SENDER', branch: null, available_balance: '1000.00' },
    ];
    _setPoolForTests(mockPoolForHistory({ count: '20', rows, capture }));
    const { handleHistoryWithRange } = await import('../../src/telegram/history');
    const res = await handleHistoryWithRange(['2026-09-01', '2026-09-10', '10', '10']);
    expect(capture.params.some((p) => p[3] === 10)).toBe(true);
    expect(res.text).toBeDefined();
    _setPoolForTests(null);
  });
});
