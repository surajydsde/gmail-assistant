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

export async function getAuthenticatedClient() {
  const tokenRecord = await prisma.authToken.findUnique({ where: { id: 1 } });
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
    await prisma.authToken.update({
      where: { id: 1 },
      data: {
        accessToken: tokens.access_token,
        expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : undefined,
        ...(tokens.refresh_token && { refreshToken: tokens.refresh_token })
      }
    });
  });

  return oauth2Client;
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

export async function syncGmailEmails() {
  const auth = await getAuthenticatedClient();
  if (!auth) throw new Error('NOT_AUTHENTICATED');

  const gmail = google.gmail({ version: 'v1', auth });

  // Read sync state
  let syncState = await prisma.syncState.findUnique({ where: { id: 1 } });
  if (!syncState) {
    syncState = await prisma.syncState.create({
      data: { id: 1, lastSyncAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Default 24h back
    });
  }

  // Construct query to only fetch newer messages
  const lastSyncEpochSec = Math.floor(new Date(syncState.lastSyncAt).getTime() / 1000);
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
    const { subject, sender, senderEmail, receivedAt } = parseEmailHeaders(msg.payload.headers);
    const bodyPreview = extractBody(msg.payload).slice(0, 1000);
    const isUnread = msg.labelIds ? msg.labelIds.includes('UNREAD') : false;

    const analysis = analyzeEmail({
      subject,
      sender,
      body: bodyPreview,
      snippet: msg.snippet || ''
    });

    await prisma.email.upsert({
      where: { id: msg.id },
      update: {
        isUnread,
        snippet: msg.snippet || '',
        updatedAt: new Date()
      },
      create: {
        id: msg.id,
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

  await prisma.syncState.update({
    where: { id: 1 },
    data: { lastSyncAt: new Date() }
  });

  return { processed: processedCount, lastSyncAt: new Date() };
}
