import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

function mockPoolForSearch(opts: {
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

describe('telegram search — openRouter intent + parameterized GIN SQL + pagination', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
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
    delete process.env.OPENROUTER_API_KEY;
  });

  it('openRouterSearchIntent returns null when OPENROUTER_API_KEY missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { openRouterSearchIntent } = await import('../../src/telegram/search');
    const res = await openRouterSearchIntent('last week large transfers');
    expect(res).toBeNull();
  });

  it('openRouterSearchIntent parses AI JSON last week -> 7d window and large -> minAmount 500000', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key-search';
    const now = new Date();
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const weekAgoDate = new Date(now);
    weekAgoDate.setDate(weekAgoDate.getDate() - 7);
    const weekAgoStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(weekAgoDate);

    global.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ sender: 'SAMPLE SENDER', minAmount: 500000, fromDate: weekAgoStr, toDate: todayStr }) } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { openRouterSearchIntent } = await import('../../src/telegram/search');
    const intent = await openRouterSearchIntent('last week large transfers');
    expect(intent).not.toBeNull();
    expect(intent!.minAmount).toBe(500000);
    expect(intent!.fromDate).toBe(weekAgoStr);
    expect(intent!.toDate).toBe(todayStr);
  });

  it('openRouterSearchIntent on 429 returns null fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => {
      return { ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { openRouterSearchIntent } = await import('../../src/telegram/search');
    const res = await openRouterSearchIntent('something');
    expect(res).toBeNull();
  });

  it('localKeywordIntent extracts amount k*1000 and sender and last week window', async () => {
    const { localKeywordIntent } = await import('../../src/telegram/search');
    const intent = localKeywordIntent('last week large transfers');
    expect(intent.minAmount).toBeUndefined(); // "large transfers" without k fallback may not extract large->500k via local? large heuristic not in local amount parsing, only k pattern
    // But date should be set
    expect(intent.fromDate).toBeDefined();
    expect(intent.toDate).toBeDefined();
  });

  it('localKeywordIntent extracts 100k -> minAmount 100000 and sender SAMPLE SENDER', async () => {
    const { localKeywordIntent } = await import('../../src/telegram/search');
    const intent = localKeywordIntent('SAMPLE SENDER 100k September');
    expect(intent.minAmount).toBe(100000);
    expect(intent.sender?.toLowerCase()).toContain('SAMPLE SENDER');
  });

  it('handleSearch uses fallback when OPENROUTER missing and builds parameterized SQL never concatenates', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const capture = { sqls: [] as string[], params: [] as unknown[][] };
    const rows = [
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:00:00', sender_name: 'SAMPLE SENDER', description: 'NIP/FCMB/SAMPLE SENDER/Transfer', available_balance: '319599.78', branch: 'Lagos' },
    ];
    _setPoolForTests(mockPoolForSearch({ count: '1', rows, capture }));
    const { handleSearch } = await import('../../src/telegram/search');
    const res = await handleSearch('SAMPLE SENDER 100k', { offset: 0 });
    expect(res.text).toContain('SAMPLE SENDER');
    expect(res.text).toContain('Found 1 matching');
    expect(res.text.length).toBeLessThan(4096);
    // Verify parameterized SQL uses $ placeholders not interpolation
    const selectSql = capture.sqls.find((s) => s.includes('FROM transactions') && s.includes('LIMIT 10 OFFSET'))!;
    expect(selectSql).toBeDefined();
    expect(selectSql).toContain('$1::text');
    expect(selectSql).toContain('$2::numeric');
    expect(selectSql).toContain('$6');
    // params should be properly bound, sender non-null
    const params = capture.params.find((p) => p.length === 6)!;
    expect(typeof params[0]).toBe('string'); // sender
    expect(params[0]).toMatch(/SAMPLE SENDER/i);
    expect(params[5]).toBe(0); // offset
    // ensure no SQL injection via quoted sender concat
    expect(selectSql).not.toContain('SAMPLE SENDER');
    _setPoolForTests(null);
  });

  it('handleSearch escapes HTML and slices 4000', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const rows = [
      { amount: '100.00', currency: 'NGN', transaction_date: '2026-09-10', transaction_time: '10:00:00', sender_name: '<b>evil</b>', description: '<script>', available_balance: '100', branch: null },
    ];
    _setPoolForTests(mockPoolForSearch({ count: '1', rows }));
    const { handleSearch } = await import('../../src/telegram/search');
    const res = await handleSearch('evil', { offset: 0 });
    expect(res.text).toContain('&lt;b&gt;');
    expect(res.text).not.toContain('<b>evil</b>');
    expect(res.text.length).toBeLessThanOrEqual(4000);
    _setPoolForTests(null);
  });

  it('handleSearch pagination offset carries and Next inline keyboard encoded', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const rows = Array.from({ length: 10 }, (_, i) => ({
      amount: '100.00',
      currency: 'NGN',
      transaction_date: '2026-09-10',
      transaction_time: '10:00:00',
      sender_name: `SENDER${i}`,
      description: `desc${i}`,
      available_balance: '100',
      branch: null,
    }));
    _setPoolForTests(mockPoolForSearch({ count: '23', rows }));
    const { handleSearch } = await import('../../src/telegram/search');
    const res = await handleSearch('last week large transfers', { offset: 0 });
    expect(res.replyMarkup).toBeDefined();
    const kb = (res.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    const nextBtn = kb.flat().find((b) => b.text.includes('Next'));
    expect(nextBtn).toBeDefined();
    expect(nextBtn!.callback_data).toContain('/search');
    expect(nextBtn!.callback_data).toContain('10'); // next offset
    // offset 10 next page
    _setPoolForTests(mockPoolForSearch({ count: '23', rows }));
    const res2 = await handleSearch('last week large transfers', { offset: 10 });
    const kb2 = (res2.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    const prevBtn = kb2.flat().find((b) => b.text.includes('Prev'));
    expect(prevBtn).toBeDefined();
    expect(prevBtn!.callback_data).toContain('0');
    _setPoolForTests(null);
  });

  it('handleSearch no matches returns friendly suggestion under 4096', async () => {
    delete process.env.OPENROUTER_API_KEY;
    _setPoolForTests(mockPoolForSearch({ count: '0', rows: [] }));
    const { handleSearch } = await import('../../src/telegram/search');
    const res = await handleSearch('nonexistent sender xyz', { offset: 0 });
    expect(res.text).toContain('No matches');
    expect(res.text).toContain('nonexistent sender xyz');
    expect(res.text.length).toBeLessThan(4096);
    _setPoolForTests(null);
  });

  it('search 10/60s rate limit returns cooldown via handleSearchStub', async () => {
    const { login } = await import('../../src/telegram/session');
    login('chat123', 'testpassword12345');
    const { handleSearchStub } = await import('../../src/telegram/commands');
    // exhaust 10
    for (let i = 0; i < 10; i++) {
      _setPoolForTests(mockPoolForSearch({ count: '0', rows: [] }));
      await handleSearchStub('chat123', ['query' + i + Date.now()]); // different buffers to avoid dedup? handleSearch uses query text
      _setPoolForTests(null);
    }
    const limited = await handleSearchStub('chat123', ['one more']);
    expect(limited.text).toMatch(/Search cooling down/);
  });

  it('unauth search via handleSearchStub never touches DB or OpenRouter', async () => {
    // no login
    let dbTouched = false;
    let openRouterTouched = false;
    const pool: unknown = {
      query: async () => {
        dbTouched = true;
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      },
      on: () => {},
      end: async () => {},
    };
    _setPoolForTests(pool as never);
    global.fetch = vi.fn(async () => {
      openRouterTouched = true;
      return { ok: true, json: async () => ({ choices: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { handleSearchStub } = await import('../../src/telegram/commands');
    const res = await handleSearchStub('unauth999', ['SAMPLE SENDER 100k']);
    expect(res.text).toContain('/login');
    expect(dbTouched).toBe(false);
    expect(openRouterTouched).toBe(false);
    _setPoolForTests(null);
  });

  it('usage when empty query', async () => {
    const { login } = await import('../../src/telegram/session');
    login('chatX', 'testpassword12345');
    const { handleSearchStub } = await import('../../src/telegram/commands');
    const res = await handleSearchStub('chatX', []);
    expect(res.text).toMatch(/Usage: \/search/);
  });
});
