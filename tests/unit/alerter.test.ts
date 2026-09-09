import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sendOnce, suspicious, parseFailure, _resetCooldownsForTests, _getCooldownExpiryForTests } from '../../src/alerts/alerter';

describe('alerter unit — Telegram-first cooldown + fallback + distinct prefixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCooldownsForTests();
    process.env.ALERT_WEBHOOK_URL = 'https://api.telegram.org/botTOKEN123/sendMessage';
    process.env.TELEGRAM_CHAT_ID = '999999';
    process.env.ALERT_FALLBACK_WEBHOOK_URL = 'https://example.com/fallback';
    process.env.LOG_LEVEL = 'silent';
    // pino logger writes to stdout; we keep silent level to avoid noise
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetCooldownsForTests();
  });

  it('sendOnce cooldown: second call within 60s suppressed, after 61s fires again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    vi.setSystemTime(new Date('2026-09-09T10:00:00.000Z'));

    await sendOnce('k', 'msg', 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(_getCooldownExpiryForTests('k')).toBeDefined();

    await sendOnce('k', 'msg', 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // suppressed

    vi.advanceTimersByTime(61_000);
    await sendOnce('k', 'msg2', 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Telegram primary fetch posts to api.telegram.org with chat_id and text including email_message_id for suspicious/parseFailure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await suspicious({ messageId: 'mid-001', from: 'attacker@evil.com', reason: 'dkim fail', authResult: 'dkim=fail' });
    expect(fetchMock).toHaveBeenCalled();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.telegram.org');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.chat_id).toBeDefined();
    expect(body.text).toContain('Possible spoof');
    expect(body.text).toContain('mid-001');
    expect(body.text).toContain('email_message_id=mid-001');

    fetchMock.mockClear();
    _resetCooldownsForTests();
    await parseFailure({ messageId: 'mid-002', field: 'referenceCode', rawSubject: 'CREDIT TRANSACTION NOTIFICATION' });
    const [, opts2] = fetchMock.mock.calls[0];
    const body2 = JSON.parse((opts2 as RequestInit).body as string);
    expect(body2.text).toContain('Zenith format drift');
    expect(body2.text).toContain('mid-002');
    expect(body2.text).toContain('email_message_id=mid-002');
  });

  it('when primary fetch throws or returns 500, fallback webhook is attempted once', async () => {
    const primaryFail = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const fallbackSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    // Need to route primary vs fallback by URL; our alerter calls fetch twice — first primary, then fallback
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('api.telegram.org')) return primaryFail(url);
      return fallbackSpy(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendOnce('fallback-test', 'needs fallback', 0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fallbackSpy).toHaveBeenCalledTimes(1);

    // Also test throw path
    _resetCooldownsForTests();
    const throwPrimary = vi.fn().mockRejectedValue(new Error('network down'));
    const fetchMock2 = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('api.telegram.org')) return throwPrimary(url);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });
    vi.stubGlobal('fetch', fetchMock2);
    await sendOnce('throw-fallback', 'throw fallback', 0);
    expect(fetchMock2).toHaveBeenCalledTimes(2);
  });

  it('suspicious() message starts with Possible spoof and parseFailure() with Zenith format drift (T-6.4 distinct)', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      bodies.push(JSON.parse(opts.body as string).text);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    await suspicious({ messageId: 's1', from: 'a@b.com', reason: 'no dkim', authResult: 'missing' });
    _resetCooldownsForTests();
    await parseFailure({ messageId: 'p1', field: 'amount', rawSubject: 'subject' });

    expect(bodies[0].startsWith('Possible spoof')).toBe(true);
    expect(bodies[1].startsWith('Zenith format drift')).toBe(true);
    expect(bodies[0]).not.toBe(bodies[1]);
  });

  it('no alert path uses console.log; all go through pino logger (verified via logger import, not console)', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await sendOnce('nolog', 'test nolog', 0);
    await suspicious({ messageId: 'mid', from: 'x', reason: 'r', authResult: 'a' });
    // parseFailure uses new key so not deduped
    _resetCooldownsForTests();
    await parseFailure({ messageId: 'mid2', field: 'f', rawSubject: 's' });

    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
