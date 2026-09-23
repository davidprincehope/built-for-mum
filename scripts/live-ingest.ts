import dotenv from 'dotenv';
dotenv.config();
// Set DATABASE_URL to the intended tunnel target before running this script.

import { getGmailClient } from '../src/gmail/auth';
import { verifyAuthenticity } from '../src/zenith/authenticity';
import { decodeStrict, base64UrlToBase64 } from '../src/zenith/decode';
import { parseZenithEmail } from '../src/zenith/parser';
import { isCreditTransaction } from '../src/zenith/classifier';
import { extractSender } from '../src/zenith/sender';
import { validateTransaction, buildValidationInput } from '../src/zenith/validation';
import { getPool } from '../src/db/pool';
import { logger } from '../src/observability/logger';

async function processOne(messageId: string) {
  const gmail = getGmailClient();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name!.toLowerCase(), h.value!]));
  console.log('Subject:', headers['subject']);
  console.log('From:', headers['from']);
  const authHeader = headers['authentication-results'] ?? '';
  console.log('Auth snippet:', authHeader.substring(0,120));
  const auth = verifyAuthenticity(authHeader);
  console.log('Auth result:', auth);
  if (!auth.pass) {
    console.log('FAIL auth, would go to suspicious_emails');
    return;
  }
  const fromDomain = (headers['from'] ?? '').toLowerCase();
  const zenithDomains = (process.env.ZENITH_SENDER_DOMAINS ?? 'zenithbank.com').split(',').map(s=>s.trim());
  const isCandidate = zenithDomains.some(d => fromDomain.includes(d));
  console.log('Is candidate:', isCandidate);
  if (!isCandidate) { console.log('Not candidate, ignored'); return; }

  // Extract body data
  let bodyData: string | undefined;
  const payload = msg.data.payload;
  function findHtml(part: any): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === 'text/html' && part.body?.data) return part.body.data;
    if (part.parts) for (const p of part.parts) { const r = findHtml(p); if (r) return r; }
    return undefined;
  }
  bodyData = findHtml(payload);
  if (!bodyData) bodyData = (payload?.body?.data as string) ?? undefined;
  if (!bodyData) { console.log('No body data'); return; }
  console.log('Body data length (b64):', bodyData.length);
  let html: string;
  try {
    html = decodeStrict(bodyData);
    console.log('Decoded HTML length:', html.length);
    console.log('HTML snippet:', html.substring(0,400).replace(/\n/g,' '));
  } catch (e:any) { console.log('Decode failed:', e.message); return; }

  // Credit check (subject only first; will re-check after parsing with transactionType)
  const isCredit = isCreditTransaction(headers['subject'] ?? '');
  console.log('Is credit:', isCredit);
  if (!isCredit) { console.log('Not credit, ignored'); return; }

  let parsed: any;
  try {
    parsed = parseZenithEmail(html);
    console.log('Parsed:', parsed);
  } catch (e:any) {
    console.log('Parse failed:', e.message);
    // Debug: dump kv keys
    try {
      const { parseZenithFields } = await import('../src/zenith/parser');
      const kv = parseZenithFields(html);
      console.log('KV keys:', Object.keys(kv));
      console.log('KV dump:', JSON.stringify(kv, null, 2).substring(0,3000));
    } catch (dumpErr) { console.log('dump failed', dumpErr); }
    return;
  }

  // Sender extraction per D-10
  const sender = extractSender(parsed.description);
  console.log('Sender:', sender);
  let validated: any;
  try {
    const input = buildValidationInput({
      fields: {
        ...parsed.rawTable,
        'amount': parsed.amountStr,
        'currency': parsed.currency,
        'reference code': parsed.referenceCode,
        'date of transaction': parsed.transactionDateStr,
        'account number': parsed.accountNumber,
        'available balance': parsed.availableBalanceStr,
        'description': parsed.description,
        'branch': parsed.branch,
      },
      emailMessageId: messageId,
      emailAuthResult: auth.reason,
      senderName: sender.senderName,
    });
    validated = validateTransaction(input);
    console.log('Validated:', validated);
  } catch (e:any) { console.log('Validation failed:', JSON.stringify(e.issues ?? e.message, null, 2)); return; }

  // Insert atomically
  const pool = getPool();
  const rawEmail = html.substring(0, 100*1024); // cap per D-17
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `INSERT INTO transactions (amount,currency,transaction_reference,transaction_date,transaction_time,sender_name,sender_account,description,branch,available_balance,bank,email_message_id,email_auth_result,raw_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Zenith Bank',$11,$12,$13)
       ON CONFLICT (email_message_id) DO NOTHING RETURNING id`,
      [validated.amount, validated.currency, validated.transaction_reference, validated.transaction_date, validated.transaction_time ?? null, validated.sender_name, validated.sender_account, validated.description, validated.branch ?? null, validated.available_balance ?? null, messageId, auth.reason, rawEmail]
    );
    if (res.rowCount === 0) {
      await client.query('ROLLBACK');
      console.log('Duplicate — already exists');
      return;
    }
    await client.query(`INSERT INTO pipeline_health (key, value, updated_at) VALUES ('last_zenith_email_processed_at', now(), now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`);
    await client.query('COMMIT');
    console.log('INSERTED transaction id', res.rows[0].id);
    const check = await pool.query('SELECT amount,currency,transaction_reference,sender_name FROM transactions WHERE email_message_id=$1', [messageId]);
    console.log('DB row:', check.rows[0]);
  } catch (e:any) {
    await client.query('ROLLBACK');
    console.log('Insert failed:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

const id = process.argv[2] ?? '1a08a34e92ecad15';
processOne(id).catch(e=>{ console.error(e); process.exit(1); });
