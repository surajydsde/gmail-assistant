import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { CONFIG } from './config.js';
import { prisma } from './db.js';
import { getOAuth2Client, syncGmailEmails } from './gmail.js';
import {
  createOAuthState,
  setOAuthStateCookie,
  verifyOAuthState,
  clearOAuthStateCookie,
  createSession,
  getCurrentUser,
  requireAuth,
  logout
} from './auth.js';
import { initializeScheduler } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// OAuth Initiation
app.get('/auth/url', (req, res) => {
  try {
    if (!CONFIG.google.clientId || !CONFIG.google.clientSecret || !CONFIG.google.redirectUri) {
      return res.status(500).json({ error: 'GOOGLE_OAUTH_NOT_CONFIGURED' });
    }

    const oauth2Client = getOAuth2Client();
    const state = createOAuthState();

    setOAuthStateCookie(res, state);

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: CONFIG.google.scopes
    });

    res.json({ url });
  } catch (err) {
    console.error('[OAUTH] Failed to create authorization URL:', err);
    res.status(500).json({ error: 'OAUTH_URL_ERROR' });
  }
});

// OAuth Callback Handler
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Google authorization failed: ${error}`);
  }

  if (!code) {
    return res.status(400).send('Authorization code missing.');
  }

  if (!verifyOAuthState(req, state)) {
    return res.status(400).send('Invalid OAuth state. Please restart Gmail connection.');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    // Gmail's profile endpoint gives us the Google account that authorized the app.
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress?.toLowerCase();

    if (!email) {
      throw new Error('Google account email could not be determined.');
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: { authToken: true }
    });

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email }
    });

    // Google may omit refresh_token on subsequent authorizations.
    const refreshToken =
      tokens.refresh_token || existingUser?.authToken?.refreshToken;

    if (!refreshToken) {
      throw new Error(
        'No refresh token was returned by Google. Reconnect Gmail and grant offline access.'
      );
    }

    await prisma.authToken.upsert({
      where: { userId: user.id },
      update: {
        accessToken: tokens.access_token,
        refreshToken,
        scope: tokens.scope || '',
        tokenType: tokens.token_type || 'Bearer',
        expiryDate: BigInt(tokens.expiry_date || Date.now())
      },
      create: {
        userId: user.id,
        accessToken: tokens.access_token,
        refreshToken,
        scope: tokens.scope || '',
        tokenType: tokens.token_type || 'Bearer',
        expiryDate: BigInt(tokens.expiry_date || Date.now())
      }
    });

    // Create a browser session for this specific user.
    await createSession(res, user.id);
    clearOAuthStateCookie(res);

    // First sync for this account.
    await syncGmailEmails(user.id);

    res.redirect('/');
  } catch (err) {
    console.error('[OAUTH] Callback failure:', err);
    res.status(500).send('Authentication failure: ' + err.message);
  }
});

// Authentication Status Endpoint
app.get('/api/status', async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.json({
        authenticated: false,
        lastSyncAt: null
      });
    }

    const syncState = await prisma.syncState.findUnique({
      where: { userId: user.id }
    });

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture
      },
      lastSyncAt: syncState?.lastSyncAt || null
    });
  } catch (err) {
    console.error('[AUTH] Status check failed:', err);
    res.status(500).json({ error: 'STATUS_CHECK_ERROR' });
  }
});

// Logout
app.post('/auth/logout', async (req, res) => {
  try {
    await logout(req, res);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Logout failed:', err);
    res.status(500).json({ error: 'LOGOUT_ERROR' });
  }
});

// Trigger Manual Sync
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const result = await syncGmailEmails(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    }

    console.error('[SYNC] Manual sync failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Executive Dashboard Metrics
app.get('/api/metrics', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [total, unread, actionRequired, highPriority] = await Promise.all([
      prisma.email.count({
        where: { userId }
      }),
      prisma.email.count({
        where: { userId, isUnread: true }
      }),
      prisma.email.count({
        where: {
          userId,
          isActionRequired: true,
          isReviewed: false
        }
      }),
      prisma.email.count({
        where: {
          userId,
          priorityScore: { gte: 70 },
          isReviewed: false
        }
      })
    ]);

    res.json({ total, unread, actionRequired, highPriority });
  } catch (err) {
    console.error('[API] Metrics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Email Query Endpoint (Filters, Sorting, Search)
app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const { category, priority, search, actionOnly } = req.query;
    const userId = req.user.id;

    const where = { userId };

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
    console.error('[API] Email query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark Email as Reviewed
app.patch('/api/emails/:id/review', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { isReviewed } = req.body;

    const email = await prisma.email.findFirst({
      where: {
        id,
        userId: req.user.id
      }
    });

    if (!email) {
      return res.status(404).json({ error: 'EMAIL_NOT_FOUND' });
    }

    const updated = await prisma.email.update({
      where: { id },
      data: { isReviewed: Boolean(isReviewed) }
    });

    res.json(updated);
  } catch (err) {
    console.error('[API] Review update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start Server & Scheduler
app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`[HTTP] Executive Dashboard server listening on port ${CONFIG.port}`);
  initializeScheduler();
});
