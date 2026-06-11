// Atlas auth routes and request authentication.
// Sessions ride an HttpOnly cookie for the studio; the API and SDK can also
// authenticate with `Authorization: Bearer <api key>` for server-to-server use.

import {
  createUser, verifyCredentials, createSession, getSessionUser,
  deleteSession, findUserByApiKey, logActivity
} from './db.js';

const COOKIE_NAME = 'atlas_session';

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Resolve the authenticated user from session cookie or API key. */
export function getAuthUser(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) return findUserByApiKey(bearer[1]);
  return getSessionUser(parseCookies(req)[COOKIE_NAME]);
}

function sessionCookie(token, expires) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`;
}

function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Handle /api/auth/* routes. Returns true if the route was handled.
 * sendJSON(res, status, body, extraHeaders?) is provided by the server.
 */
export async function handleAuthRoutes(req, res, url, body, sendJSON) {
  const route = url.pathname;

  if (route === '/api/auth/register' && req.method === 'POST') {
    let user;
    try {
      user = createUser(body || {});
    } catch (err) {
      sendJSON(res, err.status || 400, { error: err.message });
      return true;
    }
    const session = createSession(user.id);
    logActivity({ event: 'user.registered', user: user.email, via: 'api' });
    sendJSON(res, 201, { user }, { 'Set-Cookie': sessionCookie(session.token, session.expires) });
    return true;
  }

  if (route === '/api/auth/login' && req.method === 'POST') {
    const user = verifyCredentials(body?.email, body?.password || '');
    if (!user) {
      sendJSON(res, 401, { error: 'Invalid email or password' });
      return true;
    }
    const session = createSession(user.id);
    logActivity({ event: 'user.login', user: user.email, via: 'api' });
    sendJSON(res, 200, { user }, { 'Set-Cookie': sessionCookie(session.token, session.expires) });
    return true;
  }

  if (route === '/api/auth/logout' && req.method === 'POST') {
    deleteSession(parseCookies(req)[COOKIE_NAME]);
    sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie() });
    return true;
  }

  if (route === '/api/auth/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) {
      sendJSON(res, 401, { error: 'Not signed in' });
      return true;
    }
    sendJSON(res, 200, { user });
    return true;
  }

  return false;
}
