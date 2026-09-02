import crypto from 'crypto';
import { CONFIG } from './config.js';
import { prisma } from './db.js';

const SESSION_COOKIE = 'gmail_assistant_session';
const OAUTH_STATE_COOKIE = 'gmail_assistant_oauth_state';
const SESSION_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function cookieOptions(maxAge) {
  return [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    ...(isProduction() ? ['Secure'] : []),
    `Max-Age=${maxAge}`
  ].join('; ');
}

function clearCookieOptions() {
  return [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    ...(isProduction() ? ['Secure'] : []),
    `Max-Age=0`
  ].join('; ');
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function signState(nonce) {
  return crypto
    .createHmac('sha256', CONFIG.google.clientSecret)
    .update(nonce)
    .digest('hex');
}

export function createOAuthState() {
  const nonce = crypto.randomBytes(32).toString('hex');
  return `${nonce}.${signState(nonce)}`;
}

export function setOAuthStateCookie(res, state) {
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; ${cookieOptions(600)}`);
}

export function verifyOAuthState(req, state) {
  const cookieState = getCookie(req, OAUTH_STATE_COOKIE);
  if (!state || !cookieState || state !== cookieState) return false;

  const [nonce, signature] = state.split('.');
  if (!nonce || !signature) return false;

  const expected = signState(nonce);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function clearOAuthStateCookie(res) {
  res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; ${clearCookieOptions()}`);
}

export async function createSession(res, userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { token: hashToken(token), userId, expiresAt }
  });

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(SESSION_DAYS * 24 * 60 * 60)}`
  );
}

export async function getCurrentUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token: hashToken(token) },
    include: { user: true }
  });

  if (!session) return null;

  if (session.expiresAt <= new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  return session.user;
}

export async function requireAuth(req, res, next) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[AUTH] Session lookup failed:', err);
    res.status(500).json({ error: 'AUTHENTICATION_ERROR' });
  }
}

export async function logout(req, res) {
  const token = getCookie(req, SESSION_COOKIE);

  if (token) {
    await prisma.session.deleteMany({ where: { token: hashToken(token) } });
  }

  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${clearCookieOptions()}`);
}
