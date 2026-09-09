import { createChildLogger, logger } from './observability/logger';
import { fetchMessage } from './gmail/fetch';
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

  // 1) Fetch
  const msg = await fetchMessage(gmailClient!, messageId);
  child.debug({ subject: msg.subject, from: msg.from }, 'fetched message headers');

  // Candidate filter before authenticity per RESEARCH: check From domain ∈ ZENITH_SENDER_DOMAINS
  const envDomainsRaw = process.env.ZENITH_SENDER_DOMAINS ?? 'zenithbank.com';
  const domains = envDomainsRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const fromDomain = getSenderDomain(msg.from);

  if (fromDomain && !domains.includes(fromDomain)) {
    child.debug({ fromDomain, domains }, 'non-zenith candidate — ignored');
    return 'ignored';
  }

  if (!fromDomain) {
    const fromLower = (msg.from ?? '').toLowerCase();
    const isZenith = domains.some((d) => fromLower.includes(d));
    if (!isZenith) {
      child.debug('missing/unknown From domain — ignored');
      return 'ignored';
    }
  }

  // 2) Authenticity (DKIM-only clause-bound)
  const auth = verifyAuthenticity(msg.authResults);
  child.info({ auth_pass: auth.pass, auth_domain: auth.domain, auth_reason: auth.reason }, 'auth check');

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
    child.warn({ reason, authResult }, 'routed to suspicious_emails');
    return 'suspicious';
  }

  // 3) Decode (strict)
  if (!msg.bodyB64) {
    child.warn('missing bodyB64 — validation_failed');
    return 'validation_failed';
  }

  let html: string;
  try {
    html = decodeStrict(msg.bodyB64!);
  } catch (e) {
    child.error({ err: e }, 'strict decode failed');
    // Per D-09 strictness, treat as validation_failed (format drift) not crash — would be alerted in caller
    // But per plan, decodeStrict throws strict-decode; we rethrow to allow caller/integration to catch as validation_failed
    // For processEmail contract, return validation_failed for decode failures if not to crash pipeline
    // However spec says D-09 strict throws with no fallback; processEmail should treat as validation_failed and alert
    // We return validation_failed here to avoid unhandled exception killing worker loop
    child.warn({ err: e }, 'decode failure — validation_failed (format drift)');
    return 'validation_failed';
  }
  child.debug({ html_len: html.length }, 'decoded html');

  // 4) Parse — hardened per-field parser (throws ParseFailure on missing required)
  let parsed: ReturnType<typeof parseZenithEmail>;
  let kvFallback: Record<string, string> = {};
  try {
    parsed = parseZenithEmail(html);
    kvFallback = parsed.rawTable;
  } catch (e) {
    if (e instanceof ParseFailure) {
      child.warn({ err: e, field: e.field }, 'parse failure — validation_failed (format drift)');
      return 'validation_failed';
    }
    // Try fallback to lenient parseZenithFields for classification before failing
    try {
      kvFallback = parseZenithFields(html);
    } catch {}
    child.warn({ err: e }, 'parse failure — validation_failed');
    return 'validation_failed';
  }
  child.debug({ parsed }, 'parsed fields');

  // 5) Classify — credit only (D-06)
  const credit = isCreditTransaction(msg.subject, parsed.transactionType);
  if (!credit) {
    child.debug({ subject: msg.subject, transactionType: parsed.transactionType }, 'non-credit transaction — ignored (D-06)');
    return 'ignored';
  }

  // 6) Sender extraction via sender.ts (four families + UNKNOWN lenient-safe per D-10)
  const senderRes = extractSender(parsed.description);
  if (senderRes.family === 'UNKNOWN') {
    child.warn({ email_message_id: messageId, description: parsed.description }, 'unknown description family — lenient store raw as sender (D-10)');
  }
  const senderName = senderRes.senderName || parsed.description.split('/')[0]?.trim() || 'UNKNOWN';

  // Preserve masked account handling: sender_account stays masked as-is (D-08)
  // If senderRes provides senderAccount (future), use it; otherwise use accountNumber from parser

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

  // Override sender_account if extractor provided one (e.g., future NIP account extraction)
  if (senderRes.senderAccount) {
    (validationInput as Record<string, unknown>).sender_account = senderRes.senderAccount;
  }

  // 7) Validate via zod
  let validated: ReturnType<typeof validateTransaction>;
  try {
    validated = validateTransaction(validationInput as Record<string, unknown>);
  } catch (e) {
    child.warn({ err: e, validationInput }, 'validation failed — validation_failed (format drift per FR-1.10)');
    return 'validation_failed';
  }

  // 8) Atomic insert + heartbeat (ON CONFLICT DO NOTHING handles dedup)
  const result = await insertTransactionAtomically({
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

  child.info({ result, senderFamily: senderRes.family }, 'processEmail done');
  return result === 'inserted' ? 'inserted' : 'duplicate';
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
  getGmailClient();
  logger.info('gmail client ok');

  logger.info('worker ready — timers/poll/push wired in later plans');
}
