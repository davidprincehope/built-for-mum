import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN! });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  console.log('Listing recent Zenith emails...');
  const domains = (process.env.ZENITH_SENDER_DOMAINS ?? 'zenithbank.com').split(',').map(s=>s.trim());
  const q = `(${domains.map(d=>`from:${d}`).join(' OR ')}) newer_than:7d`;
  console.log('Query:', q);
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
  console.log('Found:', list.data.messages?.length ?? 0, 'messages');
  if (!list.data.messages?.length) { console.log('No Zenith messages in last 7d'); return; }
  for (const m of list.data.messages!) {
    console.log('\n--- Message', m.id, '---');
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' });
    const headers = msg.data.payload?.headers ?? [];
    const subj = headers.find(h=>h.name?.toLowerCase()==='subject')?.value;
    const from = headers.find(h=>h.name?.toLowerCase()==='from')?.value;
    const auth = headers.find(h=>h.name?.toLowerCase()==='authentication-results')?.value?.substring(0,200);
    console.log('Subject:', subj);
    console.log('From:', from);
    console.log('Auth-Results snippet:', auth);
    console.log('Snippet:', msg.data.snippet?.substring(0,200));
    // Try to decode body for latest only
    if (m === list.data.messages![0]) {
      const payload = msg.data.payload;
      let bodyData: string | undefined;
      if (payload?.parts) {
        const htmlPart = payload.parts.find(p=>p.mimeType==='text/html') ?? payload.parts[0];
        bodyData = htmlPart?.body?.data ?? undefined;
      } else {
        bodyData = payload?.body?.data ?? undefined;
      }
      if (bodyData) {
        const normalized = bodyData.replace(/-/g,'+').replace(/_/g,'/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const qp = Buffer.from(padded, 'base64').toString('utf-8');
        console.log('\nDecoded QP snippet (first 500 chars):');
        console.log(qp.substring(0,500));
      }
    }
  }
}
main().catch(e=>{ console.error('Error:', e.message, e.code, e.response?.data); process.exit(1); });
