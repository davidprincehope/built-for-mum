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

const ids = [
  '1a08a34e92ecad15','1a087b8722a3eee4','1a080d7c66ae67f3','1a080b7e86ceffbf','1a07d5c12a516bed','1a07cf0885a74dbd','1a07b468697fd0d9','1a07b1893d4e972e','1a07319e37a91c17','1a072f9b989050fa','1a0721c52857208b','1a071b837bce275f','1a0719fd3735f59b','1a0707a77a446889','1a06ff7a4a735695','1a06f73ee0842ff4','1a06e596e19c8612','1a06d52c8f120e91','1a06cc365f798367','1a06c6e8dc9b1c28','1a06c6b35e383897','1a06bdc1835935fc','1a06bb6fcbb78883','1a06b8b854ad58f7','1a06b2a655bfed65','1a06a505f16bc450','1a0694cbb65d0d9d','1a069348c1c9987c','1a0685d19c80ddc2','1a067b347f35eb8c','1a067aed90711d53','1a066ee02613507a','1a066ea7730845ee','1a066be2e480eddf','1a08a9b1255da4f5','1a08ab8c1158ec18','1a08adc42facf840','1a08b60db1835b99','1a08d2cf9ef15fef','1a0908c204f1426c'
];

async function processOne(messageId: string) {
  const gmail = getGmailClient();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name!.toLowerCase(), h.value!]));
  const auth = verifyAuthenticity(headers['authentication-results'] ?? '');
  if (!auth.pass) { console.log(messageId, 'auth fail'); return 'auth_fail'; }
  const payload: any = msg.data.payload;
  function findHtml(part: any): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === 'text/html' && part.body?.data) return part.body.data;
    if (part.parts) for (const p of part.parts) { const r=findHtml(p); if(r) return r; }
    return undefined;
  }
  let bodyData = findHtml(payload) ?? payload?.body?.data;
  if (!bodyData) { console.log(messageId, 'no body'); return 'no_body'; }
  let html: string;
  try { html = decodeStrict(bodyData); } catch (e:any) { console.log(messageId, 'decode fail', e.message); return 'decode_fail'; }
  if (!isCreditTransaction(headers['subject'] ?? '')) { console.log(messageId, 'not credit'); return 'not_credit'; }
  let parsed: any;
  try { parsed = parseZenithEmail(html); } catch (e:any) { console.log(messageId, 'parse fail', e.message); return 'parse_fail'; }
  const sender = extractSender(parsed.description);
  const input = buildValidationInput({
    fields: { ...parsed.rawTable, 'amount': parsed.amountStr, 'currency': parsed.currency, 'reference code': parsed.referenceCode, 'date of transaction': parsed.transactionDateStr, 'account number': parsed.accountNumber, 'available balance': parsed.availableBalanceStr, 'description': parsed.description, 'branch': parsed.branch },
    emailMessageId: messageId, emailAuthResult: auth.reason, senderName: sender.senderName,
  });
  let validated: any;
  try { validated = validateTransaction(input); } catch (e:any) { console.log(messageId, 'validation fail', e.message); return 'validation_fail'; }
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
    if (res.rowCount===0) { await client.query('ROLLBACK'); console.log(messageId, 'duplicate'); return 'duplicate'; }
    await client.query(`INSERT INTO pipeline_health (key, value, updated_at) VALUES ('last_zenith_email_processed_at', now(), now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`);
    await client.query('COMMIT');
    console.log(messageId, 're-inserted', validated.transaction_date, validated.amount);
    return 'inserted';
  } catch(e:any) { await client.query('ROLLBACK'); console.log(messageId, 'insert fail', e.message); return 'insert_fail'; }
  finally { client.release(); }
}

async function main() {
  console.log('Reverting 40 backdated rows...');
  // First delete the 40 backdated rows
  const poolDel = getPool();
  const del = await poolDel.query("DELETE FROM transactions WHERE transaction_date = '2026-01-01' RETURNING email_message_id");
  console.log('Deleted', del.rowCount, 'rows');
  // Do NOT end poolDel — keep it for re-inserts (pool is singleton, ending would break subsequent getPool)
  // Now re-insert each via Gmail
  let ok=0, fail=0;
  for (const id of ids) {
    // Need new pool for each (since previous pool ended)
    // Re-create pool via getPool() which will create new Pool with same DATABASE_URL
    // But we ended pool, so need to reset
    // Instead, we will not end pool until loop done — redo: create new pool inside processOne
    // For now, just call processOne which will create its own pool via getPool()
    const res = await processOne(id);
    if (res==='inserted') ok++; else fail++;
    await new Promise(r=>setTimeout(r, 300));
  }
  console.log(`Done: ${ok} inserted, ${fail} failed/skipped`);
  // Final check
  const pool2 = getPool();
  const check = await pool2.query("SELECT transaction_date, COUNT(*) FROM transactions GROUP BY transaction_date ORDER BY transaction_date");
  console.log('After revert distribution:');
  check.rows.forEach(r=> console.log(r.transaction_date, r.count));
  await pool2.end();
}
main().catch(e=>{console.error(e); process.exit(1)});
