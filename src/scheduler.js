import cron from 'node-cron';
import { syncGmailEmails } from './gmail.js';
import { prisma } from './db.js';

export function initializeScheduler() {
  console.log('[SCHEDULER] Initializing 3-hour Gmail synchronization task...');

  // Runs at minute 0 of every 3rd hour (e.g., 00:00, 03:00, 06:00, etc.)
  cron.schedule('0 */3 * * *', async () => {
    console.log(`[SCHEDULER] Triggering execution at ${new Date().toISOString()}`);

    try {
      const users = await prisma.user.findMany({
        where: {
          authToken: {
            isNot: null
          }
        },
        select: { id: true, email: true }
      });

      console.log(`[SCHEDULER] Found ${users.length} authenticated user(s).`);

      for (const user of users) {
        try {
          const result = await syncGmailEmails(user.id);
          console.log(
            `[SCHEDULER] ${user.email}: ${result.processed} emails ingested.`
          );
        } catch (err) {
          if (err.message === 'NOT_AUTHENTICATED') {
            console.warn(
              `[SCHEDULER] ${user.email}: Gmail account is not authenticated.`
            );
          } else {
            console.error(
              `[SCHEDULER] ${user.email}: synchronization error:`,
              err
            );
          }
        }
      }
    } catch (err) {
      console.error('[SCHEDULER] Failed to load users:', err);
    }
  });
}
