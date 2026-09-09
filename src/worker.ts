import { createChildLogger, logger } from './observability/logger';
import { fetchMessage, getMessageFull } from './gmail/fetch';
import { verifyAuthenticity } from './zenith/authenticity';
import { decodeStrict } from './zenith/decode';
import { parseZenithEmail, parseZenithFields, ParseFailure } from './zenith/parser';
import { isCreditTransaction } from './zenith/classifier';
import { extractSender } from './zenith/sender';
import { buildValidationInput, validateTransaction } from './zenith/validation';
import { insertTransactionAtomically } from './db/transactions';
import { insertSuspicious } from './db/suspicious';
import { getPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { suspicious as alerterSuspicious, parseFailure as alerterParseFailure } from './alerts/alerter';

function getSenderDomain(fromHeader: string): string {
  const m = fromHeader.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? m[1].toLowerCase() : '';
}

type ProcessResult = 'inserted' | 'duplicate' | 'suspicious' | 'ignored' | 'validation_failed';

export interface ProcessEmailDeps {
  gmail?: { users: { messages: { get: (p: Record<string, unknown>) => Promise<{ data: unknown }> } } };
  pool?: ReturnType<typeof getPool>;
  logger?: typeof logger;
}

export async function processEmail(messageId: string, deps: ProcessEmailDeps = {}): Promise<ProcessResult> {
  const child = createChildLogger({ email_message_id: messageId });
  child.info('processEmail start');

  let gmailClient: typeof deps.gmail;
  if (deps.gmail) {
    gmailClient = deps.gmail;
  } else {
    try {
      const { getGmailClient } = await import('./gmail/auth');
      gmailClient = getGmailClient() as unknown as typeof deps.gmail;
    } catch (e) {
      child.error({ err: e }, 'gmail auth failed');
      throw e;
    }
  }

  // 1) Fetch with 429 backoff retry (NFR-1.1) via getMessageFull wrapper; fallback to direct fetchMessage if not retryable shape
  let msg: Awaited<ReturnType<typeof fetchMessage>>;
  try {
    msg = await getMessageFull(gmailClient as Parameters<typeof getMessageFull>[0], messageId);
  } catch (e) {
    // getMessageFull already retried 429 up to 3 times; if still failing, rethrow
    throw e;
  }
  child.debug({ subject: msg.subject, from: msg.from }, 'fetched message headers');
  child.info({ stage: 'received', subject: msg.subject, from: msg.from }, 'stage received');

  // Candidate filter before authenticity per RESEARCH: check From domain ∈ ZENITH_SENDER_DOMAINS
  const envDomainsRaw = process.env.ZENITH_SENDER_DOMAINS ?? 'zenithbank.com';
  const domains = envDomainsRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const fromDomain = getSenderDomain(msg.from);

  if (fromDomain && !domains.includes(fromDomain)) {
    child.debug({ fromDomain, domains }, 'non-zenith candidate — ignored');
    child.info({ stage: 'auth', result: 'ignored_non_zenith' }, 'stage auth ignored non-zenith');
    return 'ignored';
  }

  if (!fromDomain) {
    const fromLower = (msg.from ?? '').toLowerCase();
    const isZenith = domains.some((d) => fromLower.includes(d));
    if (!isZenith) {
      child.debug('missing/unknown From domain — ignored');
      child.info({ stage: 'auth', result: 'ignored_no_domain' }, 'stage auth ignored');
      return 'ignored';
    }
  }

  // 2) Authenticity (DKIM-only clause-bound)
  const auth = verifyAuthenticity(msg.authResults);
  child.info({ stage: 'auth', auth_pass: auth.pass, auth_domain: auth.domain, auth_reason: auth.reason }, 'stage auth check');

  if (!auth.pass) {
    const reason = auth.reason;
    const authResult = msg.authResults || '(missing)';
    await insertSuspicious({
      email_message_id: messageId,
      from_address: msg.from,
      subject: msg.subject || null,
      auth_result: authResult,
      reason,
      raw_email: JSON.stringify({ headers: msg.headers, bodyB64: msg.bodyB64 }),
    });
    child.warn({ stage: 'auth', reason, authResult }, 'routed to suspicious_emails');
    try {
      await alerterSuspicious({ messageId, from: msg.from, reason, authResult });
    } catch (e) {
      child.error({ err: e }, 'alerter suspicious failed');
    }
    return 'suspicious';
  }

  // 3) Decode (strict)
  if (!msg.bodyB64) {
    child.warn({ stage: 'parse', reason: 'missing bodyB64' }, 'missing bodyB64 — validation_failed');
    try {
      await alerterParseFailure({ messageId, field: 'bodyB64', rawSubject: msg.subject ?? '' });
    } catch {}
    return 'validation_failed';
  }

  let html: string;
  try {
    html = decodeStrict(msg.bodyB64!);
  } catch (e) {
    child.error({ stage: 'parse', err: e }, 'strict decode failed');
    child.warn({ stage: 'parse', err: e }, 'decode failure — validation_failed (format drift)');
    try {
      await alerterParseFailure({ messageId, field: 'decode', rawSubject: msg.subject ?? '' });
    } catch {}
    return 'validation_failed';
  }
  child.debug({ html_len: html.length }, 'decoded html');
  child.info({ stage: 'parse', html_len: html.length }, 'stage parse decoded');

  // 4) Parse — hardened per-field parser (throws ParseFailure on missing required)
  let parsed: ReturnType<typeof parseZenithEmail>;
  try {
    parsed = parseZenithEmail(html);
  } catch (e) {
    if (e instanceof ParseFailure) {
      child.warn({ stage: 'parse', err: e, field: e.field }, 'parse failure — validation_failed (format drift)');
      try {
        await alerterParseFailure({ messageId, field: e.field, rawSubject: msg.subject ?? '' });
      } catch {}
      return 'validation_failed';
    }
    try {
      parseZenithFields(html);
    } catch {}
    child.warn({ stage: 'parse', err: e }, 'parse failure — validation_failed');
    try {
      await alerterParseFailure({ messageId, field: 'unknown', rawSubject: msg.subject ?? '' });
    } catch {}
    return 'validation_failed';
  }
  child.debug({ parsed }, 'parsed fields');
  child.info({ stage: 'parse', reference: parsed.referenceCode, transactionType: parsed.transactionType }, 'stage parse ok');

  // 5) Classify — credit only (D-06)
  const credit = isCreditTransaction(msg.subject, parsed.transactionType);
  if (!credit) {
    child.debug({ subject: msg.subject, transactionType: parsed.transactionType }, 'non-credit transaction — ignored (D-06)');
    child.info({ stage: 'validation', result: 'ignored_non_credit' }, 'stage validation ignored non-credit');
    return 'ignored';
  }

  // 6) Sender extraction via sender.ts (four families + UNKNOWN lenient-safe per D-10)
  const senderRes = extractSender(parsed.description);
  if (senderRes.family === 'UNKNOWN') {
    child.warn({ email_message_id: messageId, description: parsed.description }, 'unknown description family — lenient store raw as sender (D-10)');
  }
  const senderName = senderRes.senderName || parsed.description.split('/')[0]?.trim() || 'UNKNOWN';

  const validationInput = buildValidationInput({
    fields: {
      amount: parsed.amountStr,
      currency: parsed.currency,
      'reference code': parsed.referenceCode,
      'date of transaction': parsed.transactionDateStr,
      description: parsed.description,
      branch: parsed.branch,
      'account number': parsed.accountNumber,
      'available balance': parsed.availableBalanceStr,
    },
    emailMessageId: messageId,
    emailAuthResult: msg.authResults,
    senderName,
  });

  if (senderRes.senderAccount) {
    (validationInput as Record<string, unknown>).sender_account = senderRes.senderAccount;
  }

  // 7) Validate via zod
  let validated: ReturnType<typeof validateTransaction>;
  try {
    validated = validateTransaction(validationInput as Record<string, unknown>);
  } catch (e) {
    child.warn({ stage: 'validation', err: e, validationInput }, 'validation failed — validation_failed (format drift per FR-1.10)');
    const field = (e as { issues?: Array<{ path?: unknown[] }> })?.issues?.[0]?.path?.[0] ? String((e as { issues: Array<{ path: unknown[] }> }).issues[0].path[0]) : 'validation';
    try {
      await alerterParseFailure({ messageId, field, rawSubject: msg.subject ?? '' });
    } catch {}
    return 'validation_failed';
  }
  child.info({ stage: 'validation', reference: validated.transaction_reference }, 'stage validation ok');

  child.info({ stage: 'dedup', email_message_id: messageId }, 'stage dedup check');
  // 8) Atomic insert + heartbeat (ON CONFLICT DO NOTHING handles dedup)
  let result: Awaited<ReturnType<typeof insertTransactionAtomically>>;
  try {
    result = await insertTransactionAtomically({
      amount: validated.amount,
      currency: validated.currency,
      transaction_reference: validated.transaction_reference,
      transaction_date: validated.transaction_date,
      transaction_time: validated.transaction_time as string | null,
      sender_name: validated.sender_name,
      sender_account: validated.sender_account,
      description: validated.description,
      branch: validated.branch,
      available_balance: validated.available_balance as number | null,
      email_message_id: validated.email_message_id,
      email_auth_result: validated.email_auth_result,
      raw_email: JSON.stringify({ headers: msg.headers, subject: msg.subject, htmlSnippet: html.slice(0, 2000) }),
    });
  } catch (e) {
    child.error({ stage: 'insert', err: e }, 'stage insert failed');
    throw e;
  }

  child.info({ stage: 'insert', result, senderFamily: senderRes.family, reference: validated.transaction_reference }, 'stage insert done');
  child.info({ result, senderFamily: senderRes.family }, 'processEmail done');
  return result === 'inserted' ? 'inserted' : 'duplicate';
}

// --- Worker lifecycle ---

let httpServer: import('http').Server | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let stalenessTimer: NodeJS.Timeout | null = null;

export function _resetWorkerStateForTests(): void {
  if (httpServer) {
    try { httpServer.close(); } catch {}
    httpServer = null;
  }
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (stalenessTimer) { clearInterval(stalenessTimer); stalenessTimer = null; }
}

function createHttpServer(): import('http').Server {
  const http = require('http') as typeof import('http');
  const server = http.createServer(async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url.startsWith('/gmail/pubsub')) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      await new Promise<void>((resolve) => req.on('end', resolve));
      let json: unknown;
      try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
      const { handlePubSubPush } = await import('./gmail/push-handler');
      const pushReq = { body: json as { message?: { data?: string } } };
      const simpleRes = {
        status: (code: number) => ({
          send: (b: string) => { res.statusCode = code; res.end(b); },
          json: (b: unknown) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); },
        }),
        send: (b: string) => { res.end(b); },
      } as unknown as import('./gmail/push-handler').PushResponse;
      await handlePubSubPush(pushReq as import('./gmail/push-handler').PushRequest, simpleRes);
      if (!res.writableEnded) { res.statusCode = 200; res.end('OK'); }
      return;
    }
    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return server;
}

export async function start(): Promise<void> {
  const { env } = await import('./config/env');
  logger.info({ env: { domains: env.ZENITH_SENDER_DOMAINS } }, 'boot env ok');

  const pool = getPool();
  await pool.query('SELECT 1');
  logger.info('db pool ok');

  await runMigrations();
  logger.info('migrations ok');

  const { getGmailClient } = await import('./gmail/auth');
  try { getGmailClient(); logger.info('gmail client ok'); } catch (e) { logger.warn({ err: e }, 'gmail client init failed — continuing, watch will retry'); }

  // HTTP server for Pub/Sub push
  const port = Number(process.env.PORT ?? env.PORT ?? 3000);
  httpServer = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    httpServer!.listen(port, () => {
      logger.info({ port }, 'http server listening');
      resolve();
    });
    httpServer!.on('error', reject);
  });

  // Watch renewal (24h) — boot register attempt
  try {
    const { registerWatch, scheduleWatchRenewal } = await import('./gmail/watch');
    await registerWatch().catch(async (err) => {
      logger.error({ err }, 'initial gmail watch register failed — will retry on schedule');
      const { sendOnce } = await import('./alerts/alerter');
      await sendOnce('watch-renewal', `Gmail watch initial register failed: ${(err as Error).message}`, 60 * 60 * 1000).catch(() => {});
    });
    watchTimer = scheduleWatchRenewal();
    logger.info('watch renewal scheduled');
  } catch (e) {
    logger.error({ err: e }, 'watch scheduling failed');
  }

  // Poll sweep (15 min) — independent safety net
  try {
    const { schedulePollSweep } = await import('./gmail/poll');
    pollTimer = schedulePollSweep();
    logger.info('poll sweep scheduled');
  } catch (e) {
    logger.error({ err: e }, 'poll scheduling failed');
  }

  // Staleness checker — 60s pinned 07:00-21:00 Africa/Lagos
  try {
    const { startStalenessChecker } = await import('./observability/staleness');
    stalenessTimer = startStalenessChecker(60 * 1000);
    logger.info('staleness checker scheduled 60s');
  } catch (e) {
    logger.error({ err: e }, 'staleness scheduling failed');
  }

  // Graceful shutdown: SIGTERM/SIGINT drains timers + HTTP + pool
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal — draining');
    if (stalenessTimer) { try { const { stopStalenessChecker } = await import('./observability/staleness'); stopStalenessChecker(); } catch {} clearInterval(stalenessTimer); stalenessTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    try { await pool.end(); } catch {}
    logger.info('shutdown complete');
  };

  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
  process.once('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));

  logger.info('worker ready — all timers wired (poll 15m, watch 24h, staleness 60s)');
}
