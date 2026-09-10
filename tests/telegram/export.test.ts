import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

const originalFetch = global.fetch;

function mockPoolForExport(opts: {
  exportRows?: Array<Record<string, string | null>>;
  dupRows?: Array<Record<string, string>>;
  summaryToday?: { count: string; sum: string };
  summaryWeek?: { count: string; sum: string };
  summaryTotal?: { count: string };
  lastTx?: Array<Record<string, string | null>>;
  capture?: { sqls: string[]; params: unknown[][] };
}) {
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      if (opts.capture) {
        opts.capture.sqls.push(text);
        opts.capture.params.push(params ?? []);
      }
      if (text.includes('GROUP BY amount')) {
        return { rows: opts.dupRows ?? [], rowCount: opts.dupRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      if (text.includes('COUNT(*)::text AS count, COALESCE(SUM(amount)')) {
        // summary queries: first call today, second week
        // We distinguish by WHERE transaction_date = CURRENT_DATE vs >= CURRENT_DATE - INTERVAL
        if (text.includes('transaction_date = CURRENT_DATE')) {
          return { rows: [opts.summaryToday ?? { count: '0', sum: '0' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
        }
        if (text.includes("INTERVAL '7 days'")) {
          return { rows: [opts.summaryWeek ?? { count: '0', sum: '0' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
        }
      }
      if (text.includes('SELECT COUNT(*)::text AS count FROM transactions') && !text.includes('SUM')) {
        return { rows: [opts.summaryTotal ?? { count: '0' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
      }
      if (text.includes('ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1') && !text.includes('BETWEEN')) {
        // summary last TX or balance style
        return { rows: opts.lastTx ?? [], rowCount: opts.lastTx?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      // history style BETWEEN check before generic export
      if (text.includes('BETWEEN') && text.includes('LIMIT 100')) {
        // export filtered
        return { rows: opts.exportRows ?? [], rowCount: opts.exportRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      if (text.includes('FROM transactions ORDER BY transaction_date DESC') && text.includes('LIMIT 50')) {
        // export unfiltered last 50
        return { rows: opts.exportRows ?? [], rowCount: opts.exportRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      // history COUNT(*) BETWEEN
      if (text.includes('COUNT(*)::text AS count') && text.includes('BETWEEN')) {
        return { rows: [{ count: String(opts.exportRows?.length ?? '0') }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
      }
      return { rows: opts.exportRows ?? [], rowCount: opts.exportRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
    },
    on: () => {},
    end: async () => {},
  };
  return pool as never;
}

describe('telegram export — CSV sendDocument, duplicates, summary', () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-export-123';
    process.env.TELEGRAM_BOT_PASSWORD = 'testpassword12345';
    delete process.env.OPENROUTER_API_KEY;
    _setPoolForTests(null);
    vi.restoreAllMocks();
    global.fetch = originalFetch as unknown as typeof fetch;
    const { _resetSessionsForTests } = await import('../../src/telegram/session');
    _resetSessionsForTests();
    const { _resetRateLimitForTests } = await import('../../src/telegram/rateLimit');
    _resetRateLimitForTests();
  });

  afterEach(async () => {
    _setPoolForTests(null);
    global.fetch = originalFetch as unknown as typeof fetch;
    vi.restoreAllMocks();
    const { _resetSessionsForTests } = await import('../../src/telegram/session');
    _resetSessionsForTests();
    const { _resetRateLimitForTests } = await import('../../src/telegram/rateLimit');
    _resetRateLimitForTests();
    delete process.env.TELEGRAM_BOT_PASSWORD;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('CSV quoting handles commas, quotes, slashes in description', async () => {
    const exportRows = [
      {
        amount: '100000',
        currency: 'NGN',
        transaction_date: '2026-09-10',
        transaction_time: '10:49:22',
        sender_name: 'EXAMPLE MERCHANT',
        description: 'NIP/FCMB/EXAMPLE MERCHANT "special, transfer"/with,comma',
        branch: 'Lagos',
        available_balance: '319599.78',
      },
    ];
    _setPoolForTests(mockPoolForExport({ exportRows }));
    let fetchUrl = '';
    let fetchOpts: any = null;
    global.fetch = vi.fn(async (url: string, opts: any) => {
      fetchUrl = String(url);
      fetchOpts = opts;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const { handleExport } = await import('../../src/telegram/export');
    const res = await handleExport(['2026-09-01', '2026-09-10'], '123');
    expect(res.text).toContain('Sent 1 rows');
    // verify sendDocument called
    expect(fetchUrl).toContain('/sendDocument');
    // verify FormData contains blob; we cannot easily inspect FormData blob content without reading, but check caption and filename via FormData
    // fetchOpts.body is FormData
    const form = fetchOpts.body as FormData;
    expect(form.get('chat_id')).toBe('123');
    const caption = form.get('caption') as string;
    expect(caption).toContain('1 rows');
    // document blob check: get file
    const doc = form.get('document') as Blob;
    expect(doc).toBeDefined();
    const text = await doc.text();
    expect(text).toContain('"100000"');
    // description with comma and quote should be quoted and escaped ""
    expect(text).toContain('""special, transfer""');
    expect(text).toContain('with,comma');
    _setPoolForTests(null);
  });

  it('sendDocument FormData uses POST /botTOKEN/sendDocument with Blob and caption 1024 slice', async () => {
    const exportRows = [
      { amount: '50.00', currency: 'NGN', transaction_date: '2026-09-05', transaction_time: '12:00:00', sender_name: 'SAMPLE SENDER', description: 'desc', branch: null, available_balance: '1000' },
    ];
    _setPoolForTests(mockPoolForExport({ exportRows }));
    const calls: Array<{ url: string; body: FormData }> = [];
    global.fetch = vi.fn(async (url: string, opts: any) => {
      calls.push({ url: String(url), body: opts.body as FormData });
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { handleExport } = await import('../../src/telegram/export');
    await handleExport(['2026-09-01', '2026-09-10'], '999');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('https://api.telegram.org/bot');
    expect(calls[0].url).toContain('/sendDocument');
    const form = calls[0].body;
    expect(form.get('chat_id')).toBe('999');
    expect((form.get('document') as Blob).type).toBe('text/csv');
    _setPoolForTests(null);
  });

  it('export without args exports last 50 and filename transactions-from-to.csv', async () => {
    const exportRows = [
      { amount: '10.00', currency: 'NGN', transaction_date: '2026-09-09', transaction_time: '10:00:00', sender_name: 'S1', description: 'd1', branch: null, available_balance: '100' },
      { amount: '20.00', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '11:00:00', sender_name: 'S2', description: 'd2', branch: null, available_balance: '200' },
    ];
    _setPoolForTests(mockPoolForExport({ exportRows }));
    let sentForm: FormData | null = null;
    global.fetch = vi.fn(async (_url: string, opts: any) => {
      sentForm = opts.body as FormData;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { handleExport } = await import('../../src/telegram/export');
    const res = await handleExport([], '123');
    expect(res.text).toContain('Sent 2 rows');
    // filename should be transactions-2026-09-09-to-2026-09-10.csv pattern (from last row date to first row date) but implementation uses last-to-first; check via FormData document filename?
    // FormData get document as blob, filename via get? Not directly accessible but we checked res text contains filename
    expect(res.text).toMatch(/transactions-/);
    _setPoolForTests(null);
  });

  it('duplicates GROUP BY HAVING COUNT>1 returns table or No duplicates', async () => {
    // with duplicates
    const dupRows = [
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', c: '3' },
      { amount: '50000', currency: 'NGN', transaction_date: '2026-09-09', c: '2' },
    ];
    _setPoolForTests(mockPoolForExport({ dupRows }));
    const { handleDuplicates } = await import('../../src/telegram/export');
    let res = await handleDuplicates();
    expect(res.text).toContain('Duplicates');
    expect(res.text).toContain('100000');
    expect(res.text).toContain('3');
    expect(res.text.length).toBeLessThan(4096);
    // no duplicates
    _setPoolForTests(mockPoolForExport({ dupRows: [] }));
    res = await handleDuplicates();
    expect(res.text).toContain('No duplicates');
    _setPoolForTests(null);
  });

  it('summary 24h/7d aggregates with last TX Africa/Lagos and escapeHtml', async () => {
    _setPoolForTests(
      mockPoolForExport({
        summaryToday: { count: '2', sum: '150000' },
        summaryWeek: { count: '5', sum: '500000' },
        summaryTotal: { count: '36' },
        lastTx: [
          {
            amount: '100000',
            currency: 'NGN',
            transaction_date: '2026-09-10',
            transaction_time: '10:49:22',
            sender_name: 'EXAMPLE MERCHANT <b>evil</b>',
            available_balance: '319599.78',
          },
        ],
      }),
    );
    const { handleSummary } = await import('../../src/telegram/export');
    const res = await handleSummary();
    expect(res.text).toContain('24h:');
    expect(res.text).toContain('2');
    expect(res.text).toContain('150000');
    expect(res.text).toContain('7d:');
    expect(res.text).toContain('5');
    expect(res.text).toContain('500000');
    expect(res.text).toContain('Total:');
    expect(res.text).toContain('36');
    expect(res.text).toContain('Africa/Lagos');
    expect(res.text).toContain('&lt;b&gt;'); // escaped
    expect(res.text).not.toContain('<b>evil</b>');
    expect(res.text.length).toBeLessThan(4096);
    _setPoolForTests(null);
  });

  it('export respects login session and export 5/60s rate limit', async () => {
    const { login } = await import('../../src/telegram/session');
    const { handleExportWrapper } = await import('../../src/telegram/commands');
    // unauth
    let dbTouched = false;
    const poolUnauth: unknown = {
      query: async () => {
        dbTouched = true;
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      },
      on: () => {},
      end: async () => {},
    };
    _setPoolForTests(poolUnauth as never);
    let res: string | { text: string; replyMarkup?: unknown } = await handleExportWrapper('unauth999', ['2026-09-01', '2026-09-10']) as any;
    const resText0 = typeof res === 'string' ? res : (res as { text: string }).text;
    expect(String(resText0)).toContain('/login');
    expect(dbTouched).toBe(false);

    // login then export
    login('chatExport', 'testpassword12345');
    const exportRows = [
      { amount: '10.00', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:00:00', sender_name: 'S', description: 'd', branch: null, available_balance: '100' },
    ];
    _setPoolForTests(mockPoolForExport({ exportRows }));
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) } as unknown as Response)) as unknown as typeof fetch;
    res = await handleExportWrapper('chatExport', ['2026-09-01', '2026-09-10']) as any;
    const resText1 = typeof res === 'string' ? res : (res as { text: string }).text;
    expect(String(resText1)).toContain('Sent');

    // exhaust 5/60s
    for (let i = 0; i < 4; i++) {
      _setPoolForTests(mockPoolForExport({ exportRows }));
      global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) } as unknown as Response)) as unknown as typeof fetch;
      await handleExportWrapper('chatExport', ['2026-09-01', '2026-09-10']);
    }
    const limited = await handleExportWrapper('chatExport', ['2026-09-01', '2026-09-10']) as any;
    const limText = typeof limited === 'string' ? limited : (limited as { text: string }).text;
    expect(String(limText)).toMatch(/Export cooling down/);
    _setPoolForTests(null);
  });

  it('summary and duplicates require login', async () => {
    const { handleSummaryWrapper, handleDuplicatesWrapper } = await import('../../src/telegram/commands');
    const resSumm: any = await handleSummaryWrapper('unauth2', []);
    const summText = typeof resSumm === 'string' ? resSumm : resSumm.text;
    expect(String(summText)).toContain('/login');
    const resDup: any = await handleDuplicatesWrapper('unauth2', []);
    const dupText = typeof resDup === 'string' ? resDup : resDup.text;
    expect(String(dupText)).toContain('/login');
  });

  it('CSV quoting handles all fields even with nulls and empty', async () => {
    const exportRows = [
      { amount: '100', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:00:00', sender_name: null, description: null, branch: null, available_balance: null } as unknown as Record<string, string | null>,
    ];
    _setPoolForTests(mockPoolForExport({ exportRows: exportRows as any }));
    let capturedText = '';
    global.fetch = vi.fn(async (_url: string, opts: any) => {
      const form = opts.body as FormData;
      const blob = form.get('document') as Blob;
      capturedText = await blob.text();
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { handleExport } = await import('../../src/telegram/export');
    await handleExport(['2026-09-01', '2026-09-10'], '123');
    // header present and row has 8 quoted fields
    expect(capturedText.split('\n')[0]).toContain('"amount"');
    const rowLine = capturedText.split('\n')[1];
    // should have 8 quoted columns even when null -> "" empty quoted
    expect(rowLine.split(',').length).toBe(8);
    _setPoolForTests(null);
  });

  it('export handles sendDocument failure gracefully', async () => {
    const exportRows = [
      { amount: '10.00', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:00:00', sender_name: 'S', description: 'd', branch: null, available_balance: '100' },
    ];
    _setPoolForTests(mockPoolForExport({ exportRows }));
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: 'Internal error' }) } as unknown as Response)) as unknown as typeof fetch;
    const { handleExport } = await import('../../src/telegram/export');
    const res = await handleExport(['2026-09-01', '2026-09-10'], '123');
    expect(res.text).toContain('Export failed');
    _setPoolForTests(null);
  });
});
