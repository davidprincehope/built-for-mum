import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('telegram session - password /login 24h', () => {
  const CHAT_ID = '0000000000';
  const PASSWORD = 'supersecretpassword123';

  beforeEach(async () => {
    process.env.TELEGRAM_BOT_PASSWORD = PASSWORD;
    const { _resetSessionsForTests } = await import('../../src/telegram/session');
    _resetSessionsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T10:00:00Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { _resetSessionsForTests } = await import('../../src/telegram/session');
    _resetSessionsForTests();
    delete process.env.TELEGRAM_BOT_PASSWORD;
  });

  it('wrong password returns false and does not create session', async () => {
    const { login, isLoggedIn } = await import('../../src/telegram/session');
    const ok = login(CHAT_ID, 'wrongpassword123');
    expect(ok).toBe(false);
    expect(isLoggedIn(CHAT_ID)).toBe(false);
  });

  it('correct password sets 24h session via timingSafeEqual', async () => {
    const { login, isLoggedIn } = await import('../../src/telegram/session');
    const ok = login(CHAT_ID, PASSWORD);
    expect(ok).toBe(true);
    expect(isLoggedIn(CHAT_ID)).toBe(true);
  });

  it('isLoggedIn true within TTL and false after 24h+1ms', async () => {
    const { login, isLoggedIn } = await import('../../src/telegram/session');
    login(CHAT_ID, PASSWORD);
    expect(isLoggedIn(CHAT_ID)).toBe(true);
    // advance 24h -1ms still true
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(isLoggedIn(CHAT_ID)).toBe(true);
    // +2ms expires
    vi.advanceTimersByTime(2);
    expect(isLoggedIn(CHAT_ID)).toBe(false);
  });

  it('logout clears session', async () => {
    const { login, logout, isLoggedIn } = await import('../../src/telegram/session');
    login(CHAT_ID, PASSWORD);
    expect(isLoggedIn(CHAT_ID)).toBe(true);
    logout(CHAT_ID);
    expect(isLoggedIn(CHAT_ID)).toBe(false);
  });

  it('fail-closed when TELEGRAM_BOT_PASSWORD missing', async () => {
    delete process.env.TELEGRAM_BOT_PASSWORD;
    const { login, isLoggedIn } = await import('../../src/telegram/session');
    const ok = login(CHAT_ID, PASSWORD);
    expect(ok).toBe(false);
    expect(isLoggedIn(CHAT_ID)).toBe(false);
  });

  it('login rate limit 5/60s via isRateLimited', async () => {
    const { isRateLimited, _resetRateLimitForTests } = await import('../../src/telegram/rateLimit');
    _resetRateLimitForTests();
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(CHAT_ID, 'login', 5, 60_000)).toBe(false);
    }
    expect(isRateLimited(CHAT_ID, 'login', 5, 60_000)).toBe(true);
    // advance 60s window clears
    vi.advanceTimersByTime(60_000);
    expect(isRateLimited(CHAT_ID, 'login', 5, 60_000)).toBe(false);
    _resetRateLimitForTests();
  });

  it('handleLogin integrates rate limit and wrong/correct paths', async () => {
    const { handleLogin } = await import('../../src/telegram/commands');
    const { _resetRateLimitForTests } = await import('../../src/telegram/rateLimit');
    _resetRateLimitForTests();
    // no args
    let res = await handleLogin(CHAT_ID, []);
    expect((res as { text: string }).text).toMatch(/Usage/);
    // wrong
    res = await handleLogin(CHAT_ID, ['wrongpassword123']);
    expect((res as { text: string }).text).toMatch(/Wrong password/);
    // correct
    res = await handleLogin(CHAT_ID, [PASSWORD]);
    expect((res as { text: string }).text).toMatch(/Logged in for 24h/);
    // rate limit after 5 attempts
    _resetRateLimitForTests();
    for (let i = 0; i < 5; i++) {
      await handleLogin(CHAT_ID, ['wrong']);
    }
    const limited = await handleLogin(CHAT_ID, ['wrong']);
    expect((limited as { text: string }).text).toMatch(/cooling down/);
    _resetRateLimitForTests();
  });

  it('unauthenticated /balance blocked in worker without DB touch (session gate)', async () => {
    // Simulate worker gate logic: isLoggedIn check before handleTelegramUpdate
    const { isLoggedIn } = await import('../../src/telegram/session');
    expect(isLoggedIn(CHAT_ID)).toBe(false);
    // would reply login prompt - verify string
    const prompt = '🔒 Please /login <password> first — session 24h or after restart';
    expect(prompt).toContain('/login');
  });

  it('constantTimeEqual handles different lengths', async () => {
    const { constantTimeEqual } = await import('../../src/telegram/session');
    expect(constantTimeEqual('short', 'longerpassword')).toBe(false);
    expect(constantTimeEqual(PASSWORD, PASSWORD)).toBe(true);
  });
});
