import dotenv from 'dotenv';
dotenv.config();
import { getGmailClient } from '../src/gmail/auth';
async function main() {
  const gmail = getGmailClient();
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? 'example-project';
  const topic = process.env.GOOGLE_PUBSUB_TOPIC ?? 'gmail-zenith-notifications';
  const topicName = `projects/${project}/topics/${topic}`;
  console.log('Attempting gmail.users.watch with topic:', topicName);
  try {
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' },
    });
    console.log('SUCCESS: watch registered');
    console.log('historyId:', res.data.historyId);
    console.log('expiration:', res.data.expiration, new Date(Number(res.data.expiration)).toISOString());
  } catch (e:any) {
    console.error('FAILED:', e.message);
    if (e.response?.data) console.error('Response:', JSON.stringify(e.response.data, null, 2));
    if (e.code) console.error('Code:', e.code);
    process.exit(1);
  }
}
main();
