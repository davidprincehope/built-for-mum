import dotenv from 'dotenv';
dotenv.config();
// Set DATABASE_URL in the environment before running this script.
import { getGmailClient } from '../src/gmail/auth';
import { verifyAuthenticity } from '../src/zenith/authenticity';
import { decodeStrict } from '../src/zenith/decode';
import { parseZenithEmail } from '../src/zenith/parser';
import { isCreditTransaction } from '../src/zenith/classifier';
import { extractSender } from '../src/zenith/sender';
import { validateTransaction, buildValidationInput } from '../src/zenith/validation';
import { getPool } from '../src/db/pool';

async function processOne(messageId: string): Promise<string> {
  const gmail = getGmailClient();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name!.toLowerCase(), h.value!]));
  const auth = verifyAuthenticity(headers['authentication-results'] ?? '');
  if (!auth.pass) return 'auth_fail';
  const payload: any = msg.data.payload;
  function findHtml(part: any): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === 'text/html' && part.body?.data) return part.body.data;
    if (part.parts) for (const p of part.parts) { const r=findHtml(p); if(r) return r; }
    return undefined;
  }
  let bodyData = findHtml(payload) ?? payload?.body?.data;
  if (!bodyData) return 'no_body';
  let html: string;
  try { html = decodeStrict(bodyData); } catch { return 'decode_fail'; }
  if (!isCreditTransaction(headers['subject'] ?? '')) return 'not_credit';
  let parsed: any;
  try { parsed = parseZenithEmail(html); } catch { return 'parse_fail'; }
  const sender = extractSender(parsed.description);
  const input = buildValidationInput({
    fields: { ...parsed.rawTable, 'amount': parsed.amountStr, 'currency': parsed.currency, 'reference code': parsed.referenceCode, 'date of transaction': parsed.transactionDateStr, 'account number': parsed.accountNumber, 'available balance': parsed.availableBalanceStr, 'description': parsed.description, 'branch': parsed.branch },
    emailMessageId: messageId, emailAuthResult: auth.reason, senderName: sender.senderName,
  });
  let validated: any;
  try { validated = validateTransaction(input); } catch { return 'validation_fail'; }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `INSERT INTO transactions (amount,currency,transaction_reference,transaction_date,transaction_time,sender_name,sender_account,description,branch,available_balance,bank,email_message_id,email_auth_result,raw_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Zenith Bank',$11,$12,$13)
       ON CONFLICT (email_message_id) DO NOTHING RETURNING id`,
      [validated.amount, validated.currency, validated.transaction_reference, validated.transaction_date, validated.transaction_time ?? null, validated.sender_name, validated.sender_account, validated.description, validated.branch, validated.available_balance ?? null, messageId, auth.reason, JSON.stringify({headers, htmlSnippet: html.slice(0,2000)})]
    );
    if (res.rowCount===0) { await client.query('ROLLBACK'); return 'duplicate'; }
    await client.query(`INSERT INTO pipeline_health (key, value, updated_at) VALUES ('last_zenith_email_processed_at', now(), now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`);
    await client.query('COMMIT');
    return 'inserted';
  } catch { await client.query('ROLLBACK'); return 'insert_fail'; }
  finally { client.release(); }
}

async function backfill() {
  const gmail = getGmailClient();
  const q = '(from:zenithbank.com) after:2026/01/01';
  console.log('Backfill query:', q);
  let pageToken: string | undefined;
  let total = 0, inserted = 0, dup = 0, skipped = 0;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    const msgs = list.data.messages ?? [];
    console.log(`Fetched page ${total} + ${msgs.length} (nextToken ${!!list.data.nextPageToken})`);
    for (const m of msgs) {
      total++;
      const res = await processOne(m.id!);
      if (res==='inserted') inserted++;
      else if (res==='duplicate') dup++;
      else skipped++;
      if (total % 20 === 0) console.log(`Progress: total ${total}, inserted ${inserted}, dup ${dup}, skipped ${skipped} (${res} for ${m.id})`);
      await new Promise(r=>setTimeout(r, 200));
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);
  console.log(`Backfill done: total ${total}, inserted ${inserted}, dup ${dup}, skipped ${skipped}`);
  const pool = getPool();
  const check = await pool.query("SELECT transaction_date, COUNT(*) FROM transactions GROUP BY transaction_date ORDER BY transaction_date");
  console.log('Distribution:');
  check.rows.forEach(r=> console.log(r.transaction_date, r.count));
  await pool.end();
}
backfill().catch(e=>{console.error(e); process.exit(1)});
