#!/usr/bin/env node
/*
 * GE Actividades — server v1.2
 * Zero-dependency Node.js: auth (3 roles), tasks, updates+photos, calendar, activity log, notifications, live sync.
 * Roles: admin (everything + user management), subadmin (tasks + assignments), employee (updates, photos, check-off).
 * Run:  node ge-server.js   (PORT and DATA_DIR env vars optional)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ge-data.json');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PORT = parseInt(process.env.PORT || '8080', 10);

/* ---------------------------------------------------------------- data -- */

function nowISO() { return new Date().toISOString(); }

function freshData() {
  return { meta: { seq: 0, createdAt: nowISO() }, users: [], tasks: [], updates: [], schedule: [], log: [], events: [], sessions: {} };
}

let data = freshData();
let saveTimer = null;

function nextId(prefix) {
  data.meta.seq += 1;
  return prefix + data.meta.seq;
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 400);
}
function flush() {
  saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('save failed:', e.message); }
}
function saveNow() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } flush(); }

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = Object.assign(freshData(), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      return true;
    }
  } catch (e) { console.error('could not read data file, starting fresh:', e.message); }
  return false;
}

/* ------------------------------------------------------------- helpers -- */

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

const sessions = new Map();
const SESSION_MS = 30 * 24 * 3600 * 1000;

function loadSessions() {
  const cutoff = Date.now();
  for (const [tok, s] of Object.entries(data.sessions || {})) {
    if (s.expires > cutoff) sessions.set(tok, s);
  }
}
function persistSessions() {
  const cutoff = Date.now();
  const out = {};
  for (const [tok, s] of sessions) if (s.expires > cutoff) out[tok] = s;
  data.sessions = out;
}
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_MS });
  persistSessions(); save();
  return token;
}
function destroySession(token) {
  if (token) { sessions.delete(token); persistSessions(); save(); }
}
function killUserSessions(userId) {
  for (const [tok, s] of sessions) if (s.userId === userId) sessions.delete(tok);
  persistSessions();
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function userFromReq(req) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) token = parseCookies(req).ge_token;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_MS;
  const u = data.users.find(u => u.id === s.userId && u.active !== false);
  return u || null;
}

const failCounts = new Map();
function loginAllowed(key) {
  const f = failCounts.get(key);
  if (!f) return true;
  if (f.until && Date.now() > f.until) { failCounts.delete(key); return true; }
  return f.count < 5;
}
function loginFail(key) {
  const f = failCounts.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.count = 0; }
  failCounts.set(key, f);
}
function loginOk(key) { failCounts.delete(key); }

function userName(id) {
  const u = data.users.find(u => u.id === id);
  return u ? u.name : '(—)';
}
function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, role: u.role, active: u.active !== false, createdAt: u.createdAt };
}
const isManager = u => u && (u.role === 'admin' || u.role === 'subadmin');

/* Activity log: every action with who + when. Rendered client-side in the user's language. */
function logEvent(type, actorId, extra) {
  data.meta.seq += 1;
  const entry = Object.assign({ seq: data.meta.seq, ts: nowISO(), type, actorId }, extra || {});
  data.log.push(entry);
  if (data.log.length > 4000) data.log = data.log.slice(-3500);
  return entry;
}

/* Notification events (bell). aud: { users: [], roles: [] } — actor never sees own ping. */
function emitEvent(type, payload, aud, actorId) {
  data.meta.seq += 1;
  const seq = data.meta.seq;
  const users = (aud.users || []).filter(id => id && id !== actorId);
  const roles = (aud.roles || []);
  if (users.length || roles.length) {
    data.events.push({ seq, ts: nowISO(), type, payload, aud: { users, roles }, actorId });
    if (data.events.length > 500) data.events = data.events.slice(-400);
  }
  return seq;
}

const STATUSES = ['pending', 'in_progress', 'done'];

function canSeeTask(u, t) {
  if (!u || !t) return false;
  return isManager(u) || t.assignee === u.id || t.createdBy === u.id;
}
function logVisibleTo(u, e) {
  if (isManager(u)) return true;
  if (e.type === 'schedule_created' || e.type === 'schedule_deleted') {
    // employees only see schedule entries that include them
    if (e.userIds && e.userIds.includes(u.id)) return true;
    return false;
  }
  if (e.type === 'user_created' || e.type === 'user_updated') return false;
  if (e.taskId) {
    const t = data.tasks.find(x => x.id === e.taskId);
    return !!t && canSeeTask(u, t);
  }
  return false;
}

/* ---------------------------------------------------------------- http -- */

function send(res, status, obj, headers) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(body);
}
function bad(res, status, msg) { send(res, status, { error: msg }); }

function readBody(req, limit) {
  limit = limit || 30 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new Error('bad_json'); }
}

/* ----------------------------------------------------------- SSE board -- */

const sseClients = new Set();
function sseBroadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) {
    try { res.write(line); } catch (e) { sseClients.delete(res); }
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); }
  }
}, 25000).unref();

/* --------------------------------------------------------------- files -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const isUpload = resolved.startsWith(FILES_DIR);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': isUpload ? 'public, max-age=3600' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(resolved).pipe(res);
}

/* ------------------------------------------------------------- cleanup -- */

function cleanupFiles() {
  try {
    if (!fs.existsSync(FILES_DIR)) return;
    const referenced = new Set();
    for (const up of data.updates) if (up.photo) referenced.add(path.basename(up.photo));
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(FILES_DIR)) {
      if (referenced.has(f)) continue;
      const full = path.join(FILES_DIR, f);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}
setInterval(cleanupFiles, 24 * 3600 * 1000).unref();

/* ------------------------------------------------------------ handlers -- */

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

/* ---- auth ---- */

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readJSON(req, 64 * 1024);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = req.socket.remoteAddress || '?';
  const key = ip + ':' + username;
  if (!loginAllowed(key)) return bad(res, 429, 'TOO_MANY');
  const u = data.users.find(u => u.username === username);
  if (!u || u.active === false || !verifyPassword(password, u.salt, u.hash)) {
    loginFail(key);
    return bad(res, 401, 'BAD_LOGIN');
  }
  loginOk(key);
  const token = createSession(u.id);
  send(res, 200, { user: publicUser(u), token }, {
    'Set-Cookie': 'ge_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MS / 1000),
  });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : parseCookies(req).ge_token;
  destroySession(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'ge_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
});

route('GET', /^\/api\/me$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  send(res, 200, { user: publicUser(u) });
});

route('POST', /^\/api\/me\/password$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const body = await readJSON(req, 16 * 1024);
  if (!verifyPassword(String(body.current || ''), u.salt, u.hash)) return bad(res, 400, 'WRONG_CURRENT');
  const next = String(body.next || '');
  if (next.length < 6) return bad(res, 400, 'PASS_SHORT');
  const h = hashPassword(next);
  u.salt = h.salt; u.hash = h.hash;
  save();
  send(res, 200, { ok: true });
});

/* ---- users ---- */

route('GET', /^\/api\/users$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  if (!isManager(u)) return bad(res, 403, 'FORBIDDEN');
  const list = data.users.map(v => {
    const p = publicUser(v);
    p.taskCount = data.tasks.filter(t => t.assignee === v.id && t.status !== 'done').length;
    return p;
  });
  send(res, 200, { users: list });
});

route('POST', /^\/api\/users$/, async (req, res, m, u) => {
  if (!u || u.role !== 'admin') return bad(res, u ? 403 : 401, u ? 'ADMIN_ONLY' : 'No autenticado');
  const body = await readJSON(req, 64 * 1024);
  const name = String(body.name || '').trim().slice(0, 60);
  const username = String(body.username || '').trim().toLowerCase().slice(0, 32);
  const password = String(body.password || '');
  const role = ['admin', 'subadmin', 'employee'].includes(body.role) ? body.role : 'employee';
  if (!name) return bad(res, 400, 'NEED_NAME');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return bad(res, 400, 'BAD_USERNAME');
  if (password.length < 6) return bad(res, 400, 'PASS_SHORT');
  if (data.users.some(x => x.username === username)) return bad(res, 400, 'USER_EXISTS');
  const h = hashPassword(password);
  const nu = { id: nextId('u'), name, username, role, active: true, salt: h.salt, hash: h.hash, lastSeenSeq: 0, createdAt: nowISO() };
  data.users.push(nu);
  logEvent('user_created', u.id, { targetName: name, role });
  emitEvent('user.created', { name, username }, { roles: ['admin'] }, u.id);
  save();
  send(res, 200, { user: publicUser(nu) });
});

route('PATCH', /^\/api\/users\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u || u.role !== 'admin') return bad(res, u ? 403 : 401, u ? 'ADMIN_ONLY' : 'No autenticado');
  const target = data.users.find(x => x.id === m[1]);
  if (!target) return bad(res, 404, 'NOT_FOUND');
  const body = await readJSON(req, 64 * 1024);

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) return bad(res, 400, 'NEED_NAME');
    target.name = name;
  }
  if (body.password !== undefined) {
    const pw = String(body.password);
    if (pw.length < 6) return bad(res, 400, 'PASS_SHORT');
    const h = hashPassword(pw);
    target.salt = h.salt; target.hash = h.hash;
    killUserSessions(target.id);
  }
  if (body.active !== undefined) {
    const active = !!body.active;
    if (!active) {
      const activeAdmins = data.users.filter(x => x.role === 'admin' && x.active !== false);
      if (target.role === 'admin' && activeAdmins.length <= 1) return bad(res, 400, 'LAST_ADMIN');
      if (target.id === u.id) return bad(res, 400, 'CANNOT_SELF_DEACTIVATE');
    }
    target.active = active;
    if (!active) killUserSessions(target.id);
  }
  if (body.role !== undefined) {
    const role = ['admin', 'subadmin', 'employee'].includes(body.role) ? body.role : 'employee';
    if (target.role === 'admin' && role !== 'admin' && target.active !== false) {
      const activeAdmins = data.users.filter(x => x.role === 'admin' && x.active !== false);
      if (activeAdmins.length <= 1) return bad(res, 400, 'LAST_ADMIN');
    }
    target.role = role;
  }
  logEvent('user_updated', u.id, { targetName: target.name });
  save();
  send(res, 200, { user: publicUser(target) });
});

route('DELETE', /^\/api\/users\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u || u.role !== 'admin') return bad(res, u ? 403 : 401, u ? 'ADMIN_ONLY' : 'No autenticado');
  const target = data.users.find(x => x.id === m[1]);
  if (!target) return bad(res, 404, 'NOT_FOUND');
  if (target.id === u.id) return bad(res, 400, 'CANNOT_DELETE_SELF');
  if (target.role === 'admin') {
    const activeAdmins = data.users.filter(x => x.role === 'admin' && x.active !== false);
    if (activeAdmins.length <= 1) return bad(res, 400, 'LAST_ADMIN');
  }
  data.users = data.users.filter(x => x.id !== target.id);
  killUserSessions(target.id);
  logEvent('user_deleted', u.id, { targetName: target.name });
  save();
  send(res, 200, { ok: true });
});

/* ---- tasks ---- */

route('POST', /^\/api\/tasks$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  if (!isManager(u)) return bad(res, 403, 'MANAGERS_ONLY');
  const body = await readJSON(req, 128 * 1024);
  const title = String(body.title || '').trim().slice(0, 120);
  const desc = String(body.desc || '').trim().slice(0, 4000);
  const assignee = String(body.assignee || '');
  const priority = ['baja', 'normal', 'alta', 'urgente'].includes(body.priority) ? body.priority : 'normal';
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(body.due || '')) ? body.due : null;
  if (!title) return bad(res, 400, 'NEED_TITLE');
  const target = data.users.find(x => x.id === assignee && x.active !== false);
  if (!target) return bad(res, 400, 'BAD_ASSIGNEE');
  const t = {
    id: nextId('t'), title, desc, assignee: target.id, priority, due,
    status: 'pending', createdBy: u.id, createdAt: nowISO(), updatedAt: nowISO(),
    completedAt: null, completedBy: null,
  };
  data.tasks.push(t);
  logEvent('task_created', u.id, { taskId: t.id, taskTitle: title, assigneeName: target.name });
  emitEvent('task.created', { title, taskId: t.id, by: u.name, assignee: target.name }, { users: [target.id], roles: ['admin', 'subadmin'] }, u.id);
  save(); sseBroadcast({ type: 'sync' });
  send(res, 200, { task: withNames(t) });
});

function withNames(t) {
  return Object.assign({}, t, {
    assigneeName: userName(t.assignee),
    createdByName: userName(t.createdBy),
    completedByName: t.completedBy ? userName(t.completedBy) : null,
    updateCount: data.updates.filter(x => x.taskId === t.id).length,
  });
}

route('GET', /^\/api\/tasks$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  let list = data.tasks.filter(t => canSeeTask(u, t));
  list = list.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  send(res, 200, { tasks: list.map(withNames) });
});

route('GET', /^\/api\/tasks\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const t = data.tasks.find(x => x.id === m[1]);
  if (!t || !canSeeTask(u, t)) return bad(res, 404, 'NOT_FOUND');
  const updates = data.updates.filter(x => x.taskId === t.id)
    .map(x => Object.assign({}, x, { authorName: userName(x.authorId) }))
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  send(res, 200, { task: withNames(t), updates });
});

route('PATCH', /^\/api\/tasks\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const t = data.tasks.find(x => x.id === m[1]);
  if (!t || !canSeeTask(u, t)) return bad(res, 404, 'NOT_FOUND');
  const body = await readJSON(req, 64 * 1024);
  const manager = isManager(u);
  const isAssignee = t.assignee === u.id;

  // status change: assignee or manager
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return bad(res, 400, 'BAD_STATUS');
    if (!manager && !isAssignee) return bad(res, 403, 'FORBIDDEN');
    const prev = t.status;
    t.status = body.status;
    if (t.status === 'done') {
      t.completedAt = nowISO();
      t.completedBy = u.id;
      logEvent('task_completed', u.id, { taskId: t.id, taskTitle: t.title });
    } else {
      if (prev === 'done') logEvent('task_reopened', u.id, { taskId: t.id, taskTitle: t.title });
      t.completedAt = null; t.completedBy = null;
      if (prev !== t.status) logEvent('task_status', u.id, { taskId: t.id, taskTitle: t.title, to: t.status });
    }
    if (prev !== t.status) {
      emitEvent('task.status', {
        title: t.title, taskId: t.id, from: prev, to: t.status, by: u.name, assignee: userName(t.assignee),
      }, { users: [t.assignee, t.createdBy], roles: ['admin', 'subadmin'] }, u.id);
    }
  }

  // field edits: managers only
  if (manager) {
    if (body.title !== undefined) {
      const title = String(body.title).trim().slice(0, 120);
      if (!title) return bad(res, 400, 'NEED_TITLE');
      t.title = title;
    }
    if (body.desc !== undefined) t.desc = String(body.desc).trim().slice(0, 4000);
    if (body.priority !== undefined && ['baja', 'normal', 'alta', 'urgente'].includes(body.priority)) t.priority = body.priority;
    if (body.due !== undefined) t.due = /^\d{4}-\d{2}-\d{2}$/.test(String(body.due)) ? body.due : null;
    if (body.assignee !== undefined) {
      const target = data.users.find(x => x.id === body.assignee && x.active !== false);
      if (!target) return bad(res, 400, 'BAD_ASSIGNEE');
      if (target.id !== t.assignee) {
        const oldName = userName(t.assignee);
        t.assignee = target.id;
        logEvent('task_reassigned', u.id, { taskId: t.id, taskTitle: t.title, fromName: oldName, toName: target.name });
        emitEvent('task.reassigned', { title: t.title, taskId: t.id, from: oldName, to: target.name, by: u.name }, { users: [target.id], roles: ['admin', 'subadmin'] }, u.id);
      }
    }
  } else if (body.title !== undefined || body.desc !== undefined || body.assignee !== undefined || body.priority !== undefined || body.due !== undefined) {
    return bad(res, 403, 'FORBIDDEN');
  }

  t.updatedAt = nowISO(); save();
  sseBroadcast({ type: 'sync' });
  send(res, 200, { task: withNames(t) });
});

route('DELETE', /^\/api\/tasks\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  if (u.role !== 'admin') return bad(res, 403, 'ADMIN_ONLY');
  const i = data.tasks.findIndex(x => x.id === m[1]);
  if (i === -1) return bad(res, 404, 'NOT_FOUND');
  const t = data.tasks[i];
  data.tasks.splice(i, 1);
  data.updates = data.updates.filter(x => x.taskId !== m[1]);
  logEvent('task_deleted', u.id, { taskTitle: t.title });
  save(); sseBroadcast({ type: 'sync' });
  send(res, 200, { ok: true });
});

/* ---- updates on tasks ---- */

route('POST', /^\/api\/tasks\/([a-z0-9]+)\/updates$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const t = data.tasks.find(x => x.id === m[1]);
  if (!t || !canSeeTask(u, t)) return bad(res, 404, 'NOT_FOUND');
  if (!isManager(u) && t.assignee !== u.id) return bad(res, 403, 'FORBIDDEN');
  const body = await readJSON(req, 2 * 1024 * 1024);
  const text = String(body.text || '').trim().slice(0, 2000);
  const photo = typeof body.photo === 'string' && body.photo.startsWith('/files/') ? body.photo : null;
  if (isManager(u) && !text) return bad(res, 400, 'NEED_TEXT');
  if (!text && !photo) return bad(res, 400, 'NEED_CONTENT');
  const up = { id: nextId('up'), taskId: t.id, authorId: u.id, text, photo, ts: nowISO() };
  data.updates.push(up);
  logEvent('update_added', u.id, { taskId: t.id, taskTitle: t.title, hasPhoto: !!photo, excerpt: text.slice(0, 80) });
  emitEvent('update.new', { title: t.title, taskId: t.id, by: u.name, hasPhoto: !!photo, excerpt: text.slice(0, 80) },
    { users: [t.assignee, t.createdBy], roles: ['admin', 'subadmin'] }, u.id);
  t.updatedAt = nowISO(); save();
  sseBroadcast({ type: 'sync' });
  send(res, 200, { update: Object.assign({}, up, { authorName: u.name }) });
});

/* ---- photo upload ---- */

route('POST', /^\/api\/upload$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const body = await readJSON(req, 12 * 1024 * 1024);
  const dataUrl = String(body.dataUrl || '');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return bad(res, 400, 'BAD_IMAGE');
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return bad(res, 400, 'IMAGE_TOO_BIG');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, name), buf);
  save();
  send(res, 200, { url: '/files/' + name });
});

/* ---- schedule ---- */

route('GET', /^\/api\/schedule$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const list = data.schedule
    .filter(s => isManager(u) || (s.userIds || []).includes(u.id))
    .map(s => Object.assign({}, s, {
      userNames: (s.userIds || []).map(userName),
      createdByName: userName(s.createdBy),
    }))
    .sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  send(res, 200, { schedule: list });
});

route('POST', /^\/api\/schedule$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  if (!isManager(u)) return bad(res, 403, 'MANAGERS_ONLY');
  const body = await readJSON(req, 128 * 1024);
  const title = String(body.title || '').trim().slice(0, 120);
  const date = String(body.date || '');
  const start = /^\d{2}:\d{2}$/.test(String(body.start || '')) ? body.start : null;
  const end = /^\d{2}:\d{2}$/.test(String(body.end || '')) ? body.end : null;
  const notes = String(body.notes || '').trim().slice(0, 1000);
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter(id => data.users.some(x => x.id === id && x.active !== false)) : [];
  if (!title) return bad(res, 400, 'NEED_TITLE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 400, 'BAD_DATE');
  const s = { id: nextId('s'), title, date, start, end, notes, userIds, createdBy: u.id, createdAt: nowISO() };
  data.schedule.push(s);
  logEvent('schedule_created', u.id, { scheduleTitle: title, date, start, userIds: userIds.slice() });
  emitEvent('schedule.new', { title, date, start, by: u.name }, { users: userIds, roles: [] }, u.id);
  save(); sseBroadcast({ type: 'sync' });
  send(res, 200, { entry: s });
});

route('PATCH', /^\/api\/schedule\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  if (!isManager(u)) return bad(res, 403, 'MANAGERS_ONLY');
  const s = data.schedule.find(x => x.id === m[1]);
  if (!s) return bad(res, 404, 'NOT_FOUND');
  const body = await readJSON(req, 128 * 1024);
  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, 120);
    if (!title) return bad(res, 400, 'NEED_TITLE');
    s.title = title;
  }
  if (body.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) s.date = body.date;
  if (body.start !== undefined) s.start = /^\d{2}:\d{2}$/.test(String(body.start)) ? body.start : null;
  if (body.end !== undefined) s.end = /^\d{2}:\d{2}$/.test(String(body.end)) ? body.end : null;
  if (body.notes !== undefined) s.notes = String(body.notes).trim().slice(0, 1000);
  if (body.userIds !== undefined) {
    s.userIds = Array.isArray(body.userIds) ? body.userIds.filter(id => data.users.some(x => x.id === id)) : [];
  }
  save(); sseBroadcast({ type: 'sync' });
  send(res, 200, { entry: s });
});

route('DELETE', /^\/api\/schedule\/([a-z0-9]+)$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  if (!isManager(u)) return bad(res, 403, 'MANAGERS_ONLY');
  const i = data.schedule.findIndex(x => x.id === m[1]);
  if (i === -1) return bad(res, 404, 'NOT_FOUND');
  const s = data.schedule[i];
  data.schedule.splice(i, 1);
  logEvent('schedule_deleted', u.id, { scheduleTitle: s.title, date: s.date });
  save(); sseBroadcast({ type: 'sync' });
  send(res, 200, { ok: true });
});

/* ---- activity log (calendar day view feeds on this) ---- */

route('GET', /^\/api\/log$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const url = new URL(req.url, 'http://x');
  const date = url.searchParams.get('date');
  const actorNameCache = {};
  const actorName = id => actorNameCache[id] || (actorNameCache[id] = userName(id));
  let list = data.log.filter(e => logVisibleTo(u, e));
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // filter by UTC date of ts (client groups its local day; single-site usage)
    list = list.filter(e => (e.ts || '').slice(0, 10) === date);
  }
  list = list.slice(-300).map(e => Object.assign({}, e, { actorName: actorName(e.actorId) }));
  send(res, 200, { log: list });
});

/* ---- notifications ---- */

function visibleEvents(u) {
  return data.events.filter(e => {
    if (e.actorId === u.id) return false;
    if (e.aud.users.includes(u.id)) return true;
    if (isManager(u) && e.aud.roles.includes(u.role)) return true;
    return false;
  });
}
route('GET', /^\/api\/notifications$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const lastSeen = u.lastSeenSeq || 0;
  const all = visibleEvents(u).slice(-40).reverse();
  const unread = visibleEvents(u).filter(e => e.seq > lastSeen).length;
  send(res, 200, { notifications: all, unread, lastSeen });
});
route('POST', /^\/api\/seen$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  const body = await readJSON(req, 16 * 1024);
  const seq = parseInt(body.seq, 10);
  if (!isNaN(seq)) {
    const maxVisible = visibleEvents(u).reduce((a, e) => Math.max(a, e.seq), 0);
    u.lastSeenSeq = Math.max(u.lastSeenSeq || 0, Math.min(seq, maxVisible));
    save();
  }
  send(res, 200, { ok: true });
});

/* ---- SSE ---- */

route('GET', /^\/api\/events$/, async (req, res, m, u) => {
  if (!u) return bad(res, 401, 'No autenticado');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write('data: {"type":"sync"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

route('GET', /^\/api\/health$/, async (req, res) => {
  send(res, 200, { ok: true, app: 'GE Actividades', version: '1.2', time: nowISO(), users: data.users.length, tasks: data.tasks.length });
});

/* ------------------------------------------------------------- server -- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/files/')) {
      const name = path.basename(pathname);
      return serveStatic(res, path.join(FILES_DIR, name));
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const u = userFromReq(req);
      return await r.handler(req, res, m, u);
    }

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/app.html' || pathname === '/index.html') {
        return serveStatic(res, path.join(ROOT, 'app.html'));
      }
    }

    bad(res, 404, 'NOT_FOUND');
  } catch (e) {
    const map = { too_large: [413, 'TOO_BIG'], bad_json: [400, 'BAD_REQUEST'] };
    const hit = map[e.message];
    if (hit) return bad(res, hit[0], hit[1]);
    console.error('server error:', e);
    try { bad(res, 500, 'INTERNAL'); } catch (e2) { /* ignore */ }
  }
});

function bootstrapSeed() {
  if (data.users.length === 0) {
    const h = hashPassword('ge12345');
    const admin = {
      id: nextId('u'), name: 'Administrador', username: 'admin', role: 'admin',
      active: true, salt: h.salt, hash: h.hash, lastSeenSeq: 0, createdAt: nowISO(),
    };
    data.users.push(admin);
    saveNow();
    console.log('');
    console.log('  ========================================================');
    console.log('   GE Actividades — primera vez / first run');
    console.log('   Usuario:  admin');
    console.log('   Clave:    ge12345');
    console.log('   >>> CAMBIA LA CLAVE EN "Ajustes" / CHANGE IT IN "Settings" <<<');
    console.log('  ========================================================');
    console.log('');
  }
}

function main() {
  const existed = load();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  loadSessions();
  bootstrapSeed();
  server.listen(PORT, () => {
    console.log('GE Actividades v1.2 en http://localhost:' + PORT);
  });
}

process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

main();
