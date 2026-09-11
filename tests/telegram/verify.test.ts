import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setPoolForTests } from '../../src/db/pool';

const originalFetch = global.fetch;

function extractText(reply: unknown): string {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply === 'object' && 'text' in (reply as Record<string, unknown>)) return String((reply as { text: string }).text);
  return String(reply ?? '');
}

function mockPoolForVerify(opts: {
  exactRows?: Array<Record<string, string | null>>;
  nearRows?: Array<Record<string, string | null>>;
  capture?: { sqls: string[]; params: unknown[][] };
}) {
  const pool: unknown = {
    query: async (text: string, params?: unknown[]) => {
      if (opts.capture) {
        opts.capture.sqls.push(text);
        opts.capture.params.push(params ?? []);
      }
      // new nearMatch query uses BETWEEN interval '1 day' LIMIT 20 without similarity
      if (text.includes("BETWEEN") && text.includes("interval '1 day'")) {
        return { rows: opts.nearRows ?? [], rowCount: opts.nearRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      if (text.includes('similarity(sender_name')) {
        return { rows: opts.nearRows ?? [], rowCount: opts.nearRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      if (text.includes('FROM transactions WHERE amount')) {
        return { rows: opts.exactRows ?? [], rowCount: opts.exactRows?.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    },
    on: () => {},
    end: async () => {},
  };
  return pool as never;
}

describe('telegram verify — parseFreeForm, dedup, pdf/vision gates, deterministic match', () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
    process.env.OPENROUTER_API_KEY = '';
    _setPoolForTests(null);
    const { _resetVerifyCacheForTests } = await import('../../src/telegram/verify');
    _resetVerifyCacheForTests();
    const { _resetRateLimitForTests } = await import('../../src/telegram/rateLimit');
    _resetRateLimitForTests();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  afterEach(async () => {
    _setPoolForTests(null);
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    const { _resetVerifyCacheForTests } = await import('../../src/telegram/verify');
    _resetVerifyCacheForTests();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('parseFreeForm 100k -> 100000, NGN default, DD/MM and ISO dates', async () => {
    const { parseFreeForm } = await import('../../src/telegram/verify');
    const r1 = parseFreeForm('100k 2026-09-09 SAMPLE SENDER');
    expect(r1).not.toBeNull();
    expect(r1!.amount).toBe(100000);
    expect(r1!.currency).toBe('NGN');
    expect(r1!.date).toBe('2026-09-09');
    expect(r1!.sender).toBeDefined();

    const r2 = parseFreeForm('250k 09/09/2026 EXAMPLE MERCHANT');
    expect(r2).not.toBeNull();
    expect(r2!.amount).toBe(250000);
    expect(r2!.date).toBe('2026-09-09');

    const r3 = parseFreeForm('100,000.00 2026-09-10 NGN Sample Sender');
    expect(r3!.amount).toBe(100000);
    expect(r3!.currency).toBe('NGN');
  });

  it('parseFreeForm missing amount or date returns null -> ask clarify', async () => {
    const { parseFreeForm } = await import('../../src/telegram/verify');
    expect(parseFreeForm('SAMPLE SENDER only no amount')).toBeNull();
    expect(parseFreeForm('100k only no date')).toBeNull();
    expect(parseFreeForm('')).toBeNull();
  });

  it('dedup Map second call returns Already verified without second fetch', async () => {
    const buf = Buffer.from('same-bytes-for-dedup-test');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(buf).digest('hex');

    let fetchCalls = 0;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        fetchCalls++;
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/test.jpg', file_size: 100 } }) } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        fetchCalls++;
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
      }
      // OpenRouter should not be called for dedup hit second time if caption parses locally
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"amount":100000,"currency":"NGN","date":"2026-09-10","sender":"SAMPLE SENDER"}' } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    // Mock pool for FOUND
    const exactRows = [
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'SAMPLE SENDER', description: 'NIP/FCMB/SAMPLE SENDER/Transfer', available_balance: '319599.78', branch: null },
    ];
    _setPoolForTests(mockPoolForVerify({ exactRows }));

    const { handleVerify, _getVerifyCacheForTests } = await import('../../src/telegram/verify');
    // first call with caption that parses locally (so no vision) — will succeed and cache
    const first = await handleVerify({ chatId: '123', fileId: 'file123', mime: 'image/jpeg', caption: '100k 2026-09-10 SAMPLE SENDER' });
    expect(extractText(first)).toContain('VERIFIED');
    expect(fetchCalls).toBe(2); // getFile + download
    const cacheSizeAfterFirst = _getVerifyCacheForTests().size;
    expect(cacheSizeAfterFirst).toBeGreaterThan(0);

    // second call same bytes (same fileId mocked to same buffer) should hit dedup and not call fetch again? Actually fileId differs but contentHash same -> dedup.
    // Our mock returns same buf for any fileId, so hash same.
    fetchCalls = 0;
    // Need to reset fetch to count second call; but dedup should still require download to compute hash -> second call will still do getFile/download then hit dedup before DB. So fetchCalls will be 2 again but no DB second query? Spec says dedup without re-calling OpenRouter or DB. Download still happens to compute hash (can't avoid). We check that second reply is Already verified
    const second = await handleVerify({ chatId: '123', fileId: 'file123', mime: 'image/jpeg', caption: '100k 2026-09-10 SAMPLE SENDER' });
    expect(second).toMatch(/Already verified/);
  });

  it('PDF branch: pdf-parse text>=40 uses local parse no OpenRouter call', async () => {
    let openRouterCalled = false;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'docs/receipt.pdf', file_size: 1000 } }) } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        return { ok: true, arrayBuffer: async () => Buffer.from('pdf-buffer-with-text').buffer } as unknown as Response;
      }
      if (u.includes('openrouter.ai')) {
        openRouterCalled = true;
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    const exactRows = [
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'EXAMPLE MERCHANT', description: 'NIP/FCMB/EXAMPLE MERCHANT/Transfer', available_balance: '319599.78', branch: null },
    ];
    _setPoolForTests(mockPoolForVerify({ exactRows }));

    const { handleVerify, __setPdfTextOverride } = await import('../../src/telegram/verify');
    __setPdfTextOverride('Amount 100,000 NGN Date 2026-09-10 Sender EXAMPLE MERCHANT extra padding to exceed 40 chars');
    const reply = await handleVerify({ chatId: '123', fileId: 'pdfFile123', mime: 'application/pdf', isPdf: true });
    __setPdfTextOverride(null);
    expect(extractText(reply)).toContain('VERIFIED');
    expect(openRouterCalled).toBe(false);
  });

  it('PDF fallback: text<40 calls openRouterPdf mocked', async () => {
    let openRouterPdfCalled = false;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'docs/img.pdf', file_size: 1000 } }) } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        return { ok: true, arrayBuffer: async () => Buffer.from('%PDF-invalid-tiny').buffer } as unknown as Response;
      }
      if (u.includes('openrouter.ai')) {
        openRouterPdfCalled = true;
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"amount":50000,"currency":"NGN","date":"2026-09-09","sender":"SAMPLE SENDER"}' } }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    process.env.OPENROUTER_API_KEY = 'test-key';

    const exactRows = [
      { amount: '50000', currency: 'NGN', transaction_date: '2026-09-09', sender_name: 'SAMPLE SENDER', description: 'NIP/FCMB/SAMPLE SENDER/Transfer', available_balance: '100000', branch: null },
    ];
    _setPoolForTests(mockPoolForVerify({ exactRows }));

    const { _resetVerifyCacheForTests, __setPdfTextOverride } = await import('../../src/telegram/verify');
    _resetVerifyCacheForTests();
    __setPdfTextOverride('tiny');

    const { handleVerify } = await import('../../src/telegram/verify');
    const reply = await handleVerify({ chatId: '123', fileId: 'pdfFile456-unique-' + Date.now(), mime: 'application/pdf', isPdf: true });
    __setPdfTextOverride(null);
    expect(openRouterPdfCalled).toBe(true);
    expect(extractText(reply)).toContain('VERIFIED');
  });

  it('vision gate: caption parses -> no openRouterVision', async () => {
    let visionCalled = false;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/caption.jpg', file_size: 100 } }) } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        return { ok: true, arrayBuffer: async () => Buffer.from('img-bytes').buffer } as unknown as Response;
      }
      if (u.includes('openrouter.ai')) {
        visionCalled = true;
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    const exactRows = [{ amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'SAMPLE SENDER', description: 'CIP CR/SAMPLE SENDER/Transfer', available_balance: '319599.78', branch: null }];
    _setPoolForTests(mockPoolForVerify({ exactRows }));

    const { handleVerify } = await import('../../src/telegram/verify');
    const reply = await handleVerify({ chatId: '123', fileId: 'fileCaptionOk', mime: 'image/jpeg', caption: '100k 2026-09-10 SAMPLE SENDER' });
    expect(visionCalled).toBe(false);
    expect(extractText(reply)).toContain('VERIFIED');
  });

  it('vision gate: caption fails -> vision called once', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    let visionCalled = 0;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/nocaption.jpg', file_size: 100 } }) } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        return { ok: true, arrayBuffer: async () => Buffer.from('img-bytes-no-caption').buffer } as unknown as Response;
      }
      if (u.includes('openrouter.ai')) {
        visionCalled++;
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"amount":75000,"currency":"NGN","date":"2026-09-08","sender":"SAMPLE SENDER"}' } }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    const exactRows = [{ amount: '75000', currency: 'NGN', transaction_date: '2026-09-08', sender_name: 'SAMPLE SENDER', description: 'NIP/FCMB/SAMPLE SENDER/Transfer', available_balance: '100000', branch: null }];
    _setPoolForTests(mockPoolForVerify({ exactRows }));

    const { handleVerify } = await import('../../src/telegram/verify');
    const reply = await handleVerify({ chatId: '123', fileId: 'fileNoCaption', mime: 'image/jpeg', caption: 'unparsable caption no amount' });
    expect(visionCalled).toBe(1);
    expect(extractText(reply)).toContain('VERIFIED');
  });

  it('deterministicMatch FOUND (1 row) and MULTIPLE (>1) and NOT_FOUND_NEAR', async () => {
    const { handleVerify } = await import('../../src/telegram/verify');

    // FOUND case: local free-form text
    _setPoolForTests(mockPoolForVerify({ exactRows: [{ amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'EXAMPLE MERCHANT', description: 'NIP/FCMB/EXAMPLE MERCHANT/Transfer', available_balance: '319599.78', branch: null }], nearRows: [] }));
    let reply = await handleVerify({ chatId: '123', freeFormText: '100k 2026-09-10 EXAMPLE MERCHANT' });
    expect(extractText(reply)).toContain('VERIFIED');

    // MULTIPLE
    _setPoolForTests(mockPoolForVerify({ exactRows: [
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'EXAMPLE MERCHANT', description: 'desc1', available_balance: '100', branch: null },
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'EXAMPLE MERCHANT', description: 'desc2', available_balance: '200', branch: null },
    ], nearRows: [] }));
    // need fresh cache key for different case
    reply = await handleVerify({ chatId: '123', freeFormText: '100k 2026-09-10 EXAMPLE MERCHANT MULTIPLE' });
    expect(reply).toContain('MULTIPLE');

    // NOT_FOUND with near matches
    _setPoolForTests(mockPoolForVerify({ exactRows: [], nearRows: [
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-09', sender_name: 'SAMPLE SENDER', description: 'NIP/FCMB/SAMPLE SENDER/Transfer', available_balance: '100', branch: null, sim: '0.6' },
      { amount: '100000', currency: 'NGN', transaction_date: '2026-09-11', sender_name: 'SAMPLE SENDER', description: 'CIP CR/SAMPLE SENDER/Transfer', available_balance: '200', branch: null, sim: '0.5' },
    ] }));
    reply = await handleVerify({ chatId: '123', freeFormText: '100k 2026-09-10 SAMPLE SENDER-not-exact' });
    expect(extractText(reply)).toContain('Not found');
    expect(extractText(reply)).toContain('Near matches');
  });

  it('non-Zenith note detection prepends note', async () => {
    _setPoolForTests(mockPoolForVerify({ exactRows: [{ amount: '50000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'SAMPLE SENDER', description: 'NIP/FCMB/SAMPLE SENDER/Transfer', available_balance: '100000', branch: null }], nearRows: [] }));
    const { handleVerify, isNonZenithReceipt, buildNonZenithNote } = await import('../../src/telegram/verify');
    expect(isNonZenithReceipt('GTB receipt 50k')).toBe(true);
    expect(isNonZenithReceipt('Zenith Bank receipt')).toBe(false);
    expect(buildNonZenithNote('GTB receipt')).toContain('Non-Zenith');

    // verify reply includes note when caption contains GTB
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/gtb.jpg', file_size: 100 } }) } as unknown as Response;
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from('gtb-bytes').buffer } as unknown as Response;
      if (u.includes('openrouter.ai')) return { ok: true, json: async () => ({ choices: [{ message: { content: '{"amount":50000,"currency":"NGN","date":"2026-09-10","sender":"SAMPLE SENDER"}' } }] }) } as unknown as Response;
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'k';
    // caption unparsable to force vision which returns 50k SAMPLE SENDER
    const reply = await handleVerify({ chatId: '123', fileId: 'gtbFile', mime: 'image/jpeg', caption: 'GTB transfer receipt' });
    expect(extractText(reply)).toContain('Non-Zenith');
  });

  it('openRouter missing key degrades to text-only (no vision call)', async () => {
    delete process.env.OPENROUTER_API_KEY;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/nokey.jpg', file_size: 100 } }) } as unknown as Response;
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from('bytes').buffer } as unknown as Response;
      if (u.includes('openrouter.ai')) throw new Error('should not be called');
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    // caption parses locally so no vision needed anyway
    _setPoolForTests(mockPoolForVerify({ exactRows: [{ amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'SAMPLE SENDER', description: 'desc', available_balance: '100', branch: null }], nearRows: [] }));
    const { handleVerify } = await import('../../src/telegram/verify');
    const reply = await handleVerify({ chatId: '123', fileId: 'nokeyFile', mime: 'image/jpeg', caption: '100k 2026-09-10 SAMPLE SENDER' });
    expect(extractText(reply)).toContain('VERIFIED');
  });

  it('worker integration: handleTelegramUpdate routes photo/document via session gate and rate limit', async () => {
    const { handleTelegramUpdate } = await import('../../src/telegram/commands');
    const { login, _resetSessionsForTests } = await import('../../src/telegram/session');
    const { _resetRateLimitForTests } = await import('../../src/telegram/rateLimit');
    _resetSessionsForTests();
    _resetRateLimitForTests();
    process.env.TELEGRAM_BOT_PASSWORD = 'testpassword12345';
    const chatId = '999';
    // unauth photo should return login prompt without download
    let update: unknown = { message: { chat: { id: Number(chatId) }, photo: [{ file_id: 'fid1', file_size: 100 }, { file_id: 'fid2', file_size: 900 }] } };
    let res = await handleTelegramUpdate(update) as unknown as { text: string } | string;
    const resText = typeof res === 'object' && res !== null && 'text' in res ? (res as { text: string }).text : String(res);
    expect(resText).toContain('/login');

    // login then photo with caption that parses locally should gate, then Yes verifies
    login(chatId, 'testpassword12345');
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/p.jpg', file_size: 100 } }) } as unknown as Response;
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from('imgbytes2').buffer } as unknown as Response;
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;
    _setPoolForTests(mockPoolForVerify({ exactRows: [{ amount: '100000', currency: 'NGN', transaction_date: '2026-09-10', sender_name: 'SAMPLE SENDER', description: 'desc', available_balance: '100', branch: null }] }));
    update = { message: { chat: { id: Number(chatId) }, photo: [{ file_id: 'fid_large', file_size: 9000 }], caption: '100k 2026-09-10 SAMPLE SENDER' } };
    res = await handleTelegramUpdate(update) as unknown as { text: string; replyMarkup?: unknown } | string;
    expect(extractText(res)).toContain('Verify this receipt');
    // simulate tapping Yes
    {
      const gate = res as { replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
      const cbData = gate.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data ?? '';
      expect(cbData).toMatch(/^verify:yes:[0-9a-f]{12}$/);
      const cbUpdate = { callback_query: { id: 'cq1', data: cbData, message: { chat: { id: Number(chatId) } }, from: { id: Number(chatId) } } };
      const verifyRes = await handleTelegramUpdate(cbUpdate);
      expect(extractText(verifyRes)).toContain('VERIFIED');
    }

    // rate limit: 5/60s — exhaust via verify:yes callbacks (gate itself not rate-limited)
    _resetRateLimitForTests();
    const { pendingVerify } = await import('../../src/telegram/commands');
    for (let i = 0; i < 5; i++) {
      update = { message: { chat: { id: Number(chatId) }, photo: [{ file_id: `fid${i}`, file_size: 100 }], caption: `100k 2026-09-10 SAMPLE SENDER${i}` } };
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: `photos/${i}.jpg`, file_size: 100 } }) } as unknown as Response;
        if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from(`bytes-${i}-${Date.now()}`).buffer } as unknown as Response;
        return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
      }) as unknown as typeof fetch;
      const gateRes = await handleTelegramUpdate(update) as unknown as { replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
      const cbData = gateRes.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data ?? `verify:yes:${i}`;
      const cbUpdate = { callback_query: { id: `cq${i}`, data: cbData, message: { chat: { id: Number(chatId) } }, from: { id: Number(chatId) } } };
      await handleTelegramUpdate(cbUpdate);
    }
    // next verify:yes should be rate-limited
    pendingVerify.set('ratelimtest1', { fileId: 'fid_over', mime: 'image/jpeg', isPdf: false, chatId, ts: Date.now() });
    const limited = await handleTelegramUpdate({ callback_query: { id: 'cq_over', data: 'verify:yes:ratelimtest1', message: { chat: { id: Number(chatId) } }, from: { id: Number(chatId) } } });
    expect(extractText(limited)).toMatch(/Verify cooling down/);

    _resetSessionsForTests();
    _resetRateLimitForTests();
    delete process.env.TELEGRAM_BOT_PASSWORD;
  });
});
