// Atlas database layer (node:sqlite — zero npm dependencies).
// Holds users, sessions, and all server logging: the open-data activity log
// and the API request log. Dataset GeoJSON stays in flat files (see index.js);
// everything about *who did what, when* lives here.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsp, mkdirSync } from 'node:fs';

let db = null;

export function initDB(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'atlas.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      api_key       TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            TEXT NOT NULL,
      event         TEXT NOT NULL,
      dataset       TEXT,
      name          TEXT,
      feature_count INTEGER,
      license       TEXT,
      user_email    TEXT,
      via           TEXT
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      user_email  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at);
    CREATE INDEX IF NOT EXISTS idx_request_at ON request_log(at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  migrateJSONLLog(dataDir);
  return db;
}

// One-time migration of the pre-database JSONL activity log.
function migrateJSONLLog(dataDir) {
  const legacy = path.join(dataDir, 'activity.jsonl');
  fsp.readFile(legacy, 'utf8').then((raw) => {
    const insert = db.prepare(
      'INSERT INTO activity_log (at, event, dataset, name, feature_count, license, user_email, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const line of raw.trim().split('\n')) {
      try {
        const e = JSON.parse(line);
        insert.run(e.at, e.event, e.dataset ?? null, e.name ?? null, e.featureCount ?? null, e.license ?? null, e.user ?? null, e.via ?? null);
      } catch { /* skip malformed lines */ }
    }
    return fsp.rename(legacy, legacy + '.migrated');
  }).catch(() => { /* no legacy log to migrate */ });
}

// ---------------------------------------------------------------------------
// Users & passwords (scrypt, per-user random salt, timing-safe compare)
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyHash(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function createUser({ email, password, name }) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A valid email is required');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (findUserByEmail(email)) throw httpError(409, 'An account with that email already exists');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    email: email.trim(),
    name: (name || email.split('@')[0]).trim(),
    password_hash: hashPassword(password),
    api_key: 'atlas_' + crypto.randomBytes(24).toString('hex'),
    created_at: new Date().toISOString()
  };
  db.prepare('INSERT INTO users (id, email, name, password_hash, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, user.email, user.name, user.password_hash, user.api_key, user.created_at);
  return publicUser(user);
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email?.trim() ?? '') ?? null;
}

export function findUserByApiKey(apiKey) {
  const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey ?? '') ?? null;
  return user ? publicUser(user) : null;
}

export function verifyCredentials(email, password) {
  const user = findUserByEmail(email);
  if (!user || !verifyHash(password, user.password_hash)) return null;
  return publicUser(user);
}

export function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, apiKey: user.api_key, created: user.created_at };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_DAYS = 30;

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expires.toISOString());
  return { token, expires };
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, new Date().toISOString());
  return row ? publicUser(row) : null;
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------------------------------------------------------------------------
// Logging: open-data activity log + API request log, both in the database.
// ---------------------------------------------------------------------------

export function logActivity({ event, dataset = null, name = null, featureCount = null, license = null, user = null, via = null }) {
  db.prepare(
    'INSERT INTO activity_log (at, event, dataset, name, feature_count, license, user_email, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(new Date().toISOString(), event, dataset, name, featureCount, license, user, via);
}

export function readActivity(limit = 100) {
  return db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit).map((row) => ({
    at: row.at,
    event: row.event,
    dataset: row.dataset ?? undefined,
    name: row.name ?? undefined,
    featureCount: row.feature_count ?? undefined,
    license: row.license ?? undefined,
    user: row.user_email ?? undefined,
    via: row.via ?? undefined
  }));
}

export function logRequest({ method, path: reqPath, status, durationMs, user = null }) {
  db.prepare('INSERT INTO request_log (at, method, path, status, duration_ms, user_email) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), method, reqPath, status, Math.round(durationMs), user);
}

export function requestStats() {
  return {
    totalRequests: db.prepare('SELECT COUNT(*) AS n FROM request_log').get().n,
    totalUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    recentRequests: db.prepare('SELECT at, method, path, status, duration_ms, user_email FROM request_log ORDER BY id DESC LIMIT 25').all()
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
