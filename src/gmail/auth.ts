import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../observability/logger';

let _oauth2: OAuth2Client | null = null;
let _gmail: ReturnType<typeof google.gmail> | null = null;

export function getOAuth2Client(): OAuth2Client {
  if (_oauth2) return _oauth2;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN — check env');
  }

  _oauth2 = new OAuth2Client(clientId, clientSecret);
  // D-01: only refresh_token, no access_token persistence
  _oauth2.setCredentials({ refresh_token: refreshToken });

  _oauth2.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      logger.warn('New refresh_token issued — manual rotation required');
    }
    logger.debug({ expiry_date: tokens.expiry_date }, 'gmail tokens refreshed');
  });

  return _oauth2;
}

export function getGmailClient() {
  if (_gmail) return _gmail;
  const auth = getOAuth2Client();
  _gmail = google.gmail({ version: 'v1', auth });
  return _gmail;
}

// Ergonomic singleton exports
export const oauth2: OAuth2Client = new Proxy({} as OAuth2Client, {
  get(_t, prop) {
    const c = getOAuth2Client() as unknown as Record<string, unknown>;
    const v = c[prop as string];
    if (typeof v === 'function') return (v as (...a: unknown[]) => unknown).bind(c);
    return v;
  },
});

export const gmail = new Proxy({} as ReturnType<typeof google.gmail>, {
  get(_t, prop) {
    const g = getGmailClient() as unknown as Record<string, unknown>;
    const v = g[prop as string];
    if (typeof v === 'function') return (v as (...a: unknown[]) => unknown).bind(g);
    return v;
  },
});

// For tests
export function _resetAuthForTests(): void {
  _oauth2 = null;
  _gmail = null;
}
