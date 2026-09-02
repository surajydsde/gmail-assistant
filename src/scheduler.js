import cron from 'node-cron';
import { syncGmailEmails } from './gmail.js';

export function initializeScheduler() {
  console.log('[SCHEDULER] Initializing 3-hour Gmail synchronization task...');
  
  // Runs at minute 0 of every 3rd hour (e.g., 00:00, 03:00, 06:00, etc.)
  cron.schedule('0 */3 * * *', async () => {
    console.log(`[SCHEDULER] Triggering execution at ${new Date().toISOString()}`);
    try {
      const result = await syncGmailEmails();
      console.log(`[SCHEDULER] Sync finished. ${result.processed} emails ingested.`);
    } catch (err) {
      if (err.message === 'NOT_AUTHENTICATED') {
        console.warn('[SCHEDULER] Sync skipped: Gmail account is not authenticated.');
      } else {
        console.error('[SCHEDULER] Synchronization error:', err);
      }
    }
  });
}
