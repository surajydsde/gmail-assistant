import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { prisma } from './db.js';
import { getOAuth2Client, getAuthenticatedClient, syncGmailEmails } from './gmail.js';
import { initializeScheduler } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// OAuth Initiation
app.get('/auth/url', (req, res) => {
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: CONFIG.google.scopes
  });
  res.json({ url });
});

// OAuth Callback Handler
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code missing.');

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    await prisma.authToken.upsert({
      where: { id: 1 },
      update: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope,
        tokenType: tokens.token_type,
        expiryDate: BigInt(tokens.expiry_date)
      },
      create: {
        id: 1,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope,
        tokenType: tokens.token_type,
        expiryDate: BigInt(tokens.expiry_date)
      }
    });

    // Execute first synchronization immediately
    await syncGmailEmails();

    res.redirect('/');
  } catch (err) {
    console.error('OAuth Callback failure:', err);
    res.status(500).send('Authentication failure: ' + err.message);
  }
});

// Authentication Status Endpoint
app.get('/api/status', async (req, res) => {
  const auth = await getAuthenticatedClient();
  const syncState = await prisma.syncState.findUnique({ where: { id: 1 } });
  res.json({
    authenticated: !!auth,
    lastSyncAt: syncState ? syncState.lastSyncAt : null
  });
});

// Trigger Manual Sync
app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncGmailEmails();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Executive Dashboard Metrics
app.get('/api/metrics', async (req, res) => {
  try {
    const [total, unread, actionRequired, highPriority] = await Promise.all([
      prisma.email.count(),
      prisma.email.count({ where: { isUnread: true } }),
      prisma.email.count({ where: { isActionRequired: true, isReviewed: false } }),
      prisma.email.count({ where: { priorityScore: { gte: 70 }, isReviewed: false } })
    ]);

    res.json({ total, unread, actionRequired, highPriority });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email Query Endpoint (Filters, Sorting, Search)
app.get('/api/emails', async (req, res) => {
  try {
    const { category, priority, search, actionOnly } = req.query;

    const where = {};

    if (category && category !== 'ALL') {
      where.category = category;
    }

    if (actionOnly === 'true') {
      where.isActionRequired = true;
    }

    if (priority === 'HIGH') {
      where.priorityScore = { gte: 70 };
    } else if (priority === 'MEDIUM') {
      where.priorityScore = { gte: 40, lt: 70 };
    } else if (priority === 'LOW') {
      where.priorityScore = { lt: 40 };
    }

    if (search && search.trim() !== '') {
      where.OR = [
        { subject: { contains: search } },
        { sender: { contains: search } },
        { snippet: { contains: search } }
      ];
    }

    const emails = await prisma.email.findMany({
      where,
      orderBy: [{ priorityScore: 'desc' }, { receivedAt: 'desc' }],
      take: 100
    });

    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark Email as Reviewed
app.patch('/api/emails/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { isReviewed } = req.body;
    const updated = await prisma.email.update({
      where: { id },
      data: { isReviewed: Boolean(isReviewed) }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server & Scheduler
app.listen(CONFIG.port, () => {
  console.log(`[HTTP] Executive Dashboard server listening on http://localhost:${CONFIG.port}`);
  initializeScheduler();
});
