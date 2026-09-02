import { google } from 'googleapis';
import { CONFIG } from './config.js';
import { prisma } from './db.js';
import { analyzeEmail } from './analyzer.js';

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    CONFIG.google.clientId,
    CONFIG.google.clientSecret,
    CONFIG.google.redirectUri
  );
}

export async function getAuthenticatedClient(userId) {
  const tokenRecord = await prisma.authToken.findUnique({
    where: { userId }
  });

  if (!tokenRecord) return null;

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tokenRecord.accessToken,
    refresh_token: tokenRecord.refreshToken,
    scope: tokenRecord.scope,
    token_type: tokenRecord.tokenType,
    expiry_date: Number(tokenRecord.expiryDate)
  });

  oauth2Client.on('tokens', async (tokens) => {
    try {
      await prisma.authToken.update({
        where: { userId },
        data: {
          ...(tokens.access_token && { accessToken: tokens.access_token }),
          ...(tokens.expiry_date && { expiryDate: BigInt(tokens.expiry_date) }),
          ...(tokens.refresh_token && { refreshToken: tokens.refresh_token })
        }
      });
    } catch (err) {
      console.error(`[GMAIL] Failed to persist refreshed token for user ${userId}:`, err);
    }
  });

  return oauth2Client;
}

export async function getGmailAccount(userId) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) return null;

  const gmail = google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });

  return {
    emailAddress: profile.data.emailAddress
  };
}

function parseEmailHeaders(headers = []) {
  const findHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const subject = findHeader('Subject') || '(No Subject)';
  const from = findHeader('From') || 'Unknown Sender';
  const dateStr = findHeader('Date');
  const receivedAt = dateStr ? new Date(dateStr) : new Date();

  const emailMatch = from.match(/<([^>]+)>/);
  const senderEmail = emailMatch ? emailMatch[1] : from;
  const sender = from.replace(/<[^>]+>/, '').trim() || senderEmail;

  return { subject, sender, senderEmail, receivedAt };
}

function extractBody(payload) {
  let body = '';
  if (!payload) return '';

  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        body += Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.parts) {
        body += extractBody(part);
      }
    }
  } else if (payload.body && payload.body.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  return body.trim();
}

export async function syncGmailEmails(userId) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('NOT_AUTHENTICATED');

  const gmail = google.gmail({ version: 'v1', auth });

  let syncState = await prisma.syncState.findUnique({
    where: { userId }
  });

  if (!syncState) {
    syncState = await prisma.syncState.create({
      data: {
        userId,
        lastSyncAt: new Date(Date.now() - 24 * 60 * 60 * 1000)
      }
    });
  }

  const lastSyncEpochSec = Math.floor(
    new Date(syncState.lastSyncAt).getTime() / 1000
  );

  const q = `after:${lastSyncEpochSec}`;

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 50
  });

  const messages = listRes.data.messages || [];
  let processedCount = 0;

  for (const msgRef of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msgRef.id,
      format: 'full'
    });

    const msg = detail.data;
    const { subject, sender, senderEmail, receivedAt } =
      parseEmailHeaders(msg.payload?.headers);

    const bodyPreview = extractBody(msg.payload).slice(0, 1000);
    const isUnread = msg.labelIds
      ? msg.labelIds.includes('UNREAD')
      : false;

    const analysis = analyzeEmail({
      subject,
      sender,
      body: bodyPreview,
      snippet: msg.snippet || ''
    });

    await prisma.email.upsert({
      where: {
        userId_gmailMessageId: {
          userId,
          gmailMessageId: msg.id
        }
      },
      update: {
        isUnread,
        snippet: msg.snippet || '',
        updatedAt: new Date()
      },
      create: {
        gmailMessageId: msg.id,
        userId,
        threadId: msg.threadId,
        sender,
        senderEmail,
        subject,
        snippet: msg.snippet || '',
        bodyPreview,
        receivedAt,
        isUnread,
        isActionRequired: analysis.isActionRequired,
        priorityScore: analysis.priorityScore,
        category: analysis.category,
        summary: analysis.summary
      }
    });

    processedCount++;
  }

  const lastSyncAt = new Date();

  await prisma.syncState.update({
    where: { userId },
    data: { lastSyncAt }
  });

  return { processed: processedCount, lastSyncAt };
}
