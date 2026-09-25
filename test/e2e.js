#!/usr/bin/env node
/* GE Actividades v1.2 — E2E: 3 roles, calendar, activity log, permissions */
'use strict';
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8080);
let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('  ✓ ' + l); } else { failed++; console.log('  ✗ FAIL: ' + l); } }
async function req(method, path, body, tok) {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}

(async () => {
  console.log('GE Actividades v1.2 E2E — ' + BASE);

  console.log('\n[health & static]');
  let r = await req('GET', '/api/health');
  ok(r.status === 200 && r.json.ok, 'health ok, version ' + (r.json.version || '?'));
  const html = await (await fetch(BASE + '/')).text();
  ok(html.includes('lang-pick'), 'serves language pick screen');

  console.log('\n[auth]');
  r = await req('POST', '/api/login', { username: 'admin', password: 'wrong' });
  ok(r.status === 401, 'wrong password rejected');
  r = await req('POST', '/api/login', { username: 'admin', password: 'ge12345' });
  ok(r.status === 200 && r.json.user.role === 'admin', 'admin login');
  const A = r.json.token;

  console.log('\n[users: 3 roles]');
  r = await req('POST', '/api/users', { name: 'Sub Juan', username: 'sub1', password: 'sub12345', role: 'subadmin' }, A);
  ok(r.status === 200 && r.json.user.role === 'subadmin', 'create subadmin');
  const SUB_ID = r.json.user.id;
  r = await req('POST', '/api/users', { name: 'Emp María', username: 'maria', password: 'mar12345', role: 'employee' }, A);
  ok(r.status === 200 && r.json.user.role === 'employee', 'create employee');
  const MARIA_ID = r.json.user.id;
  r = await req('POST', '/api/users', { name: 'Emp Carlos', username: 'carlos', password: 'car12345', role: 'employee' }, A);
  ok(r.status === 200, 'create second employee');

  // subadmin login
  r = await req('POST', '/api/login', { username: 'sub1', password: 'sub12345' });
  ok(r.status === 200, 'subadmin login');
  const S = r.json.token;
  // employee login
  r = await req('POST', '/api/login', { username: 'maria', password: 'mar12345' });
  ok(r.status === 200, 'employee login');
  const M = r.json.token;

  console.log('\n[role permissions: employee]');
  r = await req('POST', '/api/tasks', { title: 'x', assignee: MARIA_ID }, M);
  ok(r.status === 403, 'employee cannot create tasks');
  r = await req('GET', '/api/users', null, M);
  ok(r.status === 403, 'employee cannot list users');
  r = await req('POST', '/api/users', { name: 'x', username: 'hack', password: 'xxxxxx', role: 'employee' }, M);
  ok(r.status === 403, 'employee cannot create users');
  r = await req('DELETE', '/api/users/' + MARIA_ID, null, M);
  ok(r.status === 403, 'employee cannot delete users');

  console.log('\n[role permissions: subadmin]');
  r = await req('POST', '/api/users', { name: 'x', username: 'hack2', password: 'xxxxxx', role: 'employee' }, S);
  ok(r.status === 403, 'subadmin cannot create users');
  r = await req('DELETE', '/api/users/' + MARIA_ID, null, S);
  ok(r.status === 403, 'subadmin cannot delete users');
  // subadmin CAN create tasks
  r = await req('POST', '/api/tasks', { title: 'Regar cultivos', desc: 'Sector A completo', assignee: MARIA_ID, priority: 'alta', due: '2026-09-28' }, S);
  ok(r.status === 200, 'subadmin creates task for maria');
  const T1 = r.json.task.id;
  ok(r.json.task.createdBy === SUB_ID, 'task createdBy = subadmin');
  ok(r.json.task.completedAt === null, 'task not yet completed');

  console.log('\n[role permissions: admin]');
  r = await req('POST', '/api/tasks', { title: 'Limpieza', assignee: MARIA_ID, priority: 'normal' }, A);
  ok(r.status === 200, 'admin creates task');
  const T2 = r.json.task.id;

  console.log('\n[employee can update + photo + check-off]');
  // maria posts a note
  r = await req('POST', '/api/tasks/' + T1 + '/updates', { text: 'Regando sector A, 50% listo' }, M);
  ok(r.status === 200, 'employee posts update');
  // maria uploads a photo
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await req('POST', '/api/upload', { dataUrl: PNG }, M);
  ok(r.status === 200 && r.json.url.startsWith('/files/'), 'employee uploads photo');
  const PHOTO = r.json.url;
  r = await req('POST', '/api/tasks/' + T1 + '/updates', { photo: PHOTO }, M);
  ok(r.status === 200, 'employee posts photo-only update');
  // maria cannot edit task fields
  r = await req('PATCH', '/api/tasks/' + T1, { title: 'hack' }, M);
  ok(r.status === 403, 'employee cannot edit task fields');
  // maria starts task
  r = await req('PATCH', '/api/tasks/' + T1, { status: 'in_progress' }, M);
  ok(r.status === 200 && r.json.task.status === 'in_progress', 'employee starts task');
  // maria completes task
  r = await req('PATCH', '/api/tasks/' + T1, { status: 'done' }, M);
  ok(r.status === 200 && r.json.task.status === 'done', 'employee checks off task');
  ok(r.json.task.completedAt !== null, 'completedAt set');
  ok(r.json.task.completedBy === MARIA_ID, 'completedBy = maria');

  console.log('\n[activity log]');
  r = await req('GET', '/api/log', null, A);
  ok(r.status === 200, 'admin reads full log');
  const logTypes = r.json.log.map(e => e.type);
  ok(logTypes.includes('task_created'), 'log has task_created');
  ok(logTypes.includes('task_completed'), 'log has task_completed');
  ok(logTypes.includes('update_added'), 'log has update_added');
  ok(logTypes.includes('user_created'), 'log has user_created');
  // every log entry has actorName + ts
  ok(r.json.log.every(e => e.actorName && e.ts), 'every log entry has actorName + ts');
  // filter by date
  const today = new Date().toISOString().slice(0,10);
  r = await req('GET', '/api/log?date=' + today, null, A);
  ok(r.status === 200 && r.json.log.length > 0, 'log filtered by today returns entries');
  // employee sees limited log
  r = await req('GET', '/api/log', null, M);
  ok(r.status === 200, 'employee reads log');
  ok(!r.json.log.some(e => e.type === 'user_created'), 'employee cannot see user_created events');
  ok(r.json.log.some(e => e.type === 'update_added'), 'employee sees own task updates');

  console.log('\n[calendar: tasks with due dates]');
  // task T1 due 2026-09-28
  r = await req('GET', '/api/tasks', null, A);
  const t1data = r.json.tasks.find(t => t.id === T1);
  ok(t1data && t1data.due === '2026-09-28', 'task T1 has due date 2026-09-28');
  ok(t1data.completedByName === 'Emp María', 'task shows completedByName');

  console.log('\n[notifications]');
  r = await req('GET', '/api/notifications', null, S);
  ok(r.status === 200, 'subadmin gets notifications');
  ok(r.json.notifications.some(n => n.type === 'task.status' || n.type === 'update.new'), 'subadmin notified of maria activity');
  r = await req('GET', '/api/notifications', null, A);
  ok(r.json.unread > 0, 'admin has unread');

  console.log('\n[schedule]');
  r = await req('POST', '/api/schedule', { title: 'Capacitación', date: '2026-09-30', start: '09:00', end: '11:00', userIds: [MARIA_ID] }, S);
  ok(r.status === 200, 'subadmin creates schedule');
  const S1 = r.json.entry.id;
  r = await req('GET', '/api/schedule', null, M);
  ok(r.json.schedule.some(s => s.id === S1), 'maria sees schedule that includes her');
  r = await req('POST', '/api/schedule', { title: 'x', date: '2026-09-30' }, M);
  ok(r.status === 403, 'employee cannot create schedule');

  console.log('\n[user management: admin only]');
  r = await req('DELETE', '/api/users/' + SUB_ID, null, A);
  ok(r.status === 200, 'admin deletes subadmin');
  r = await req('POST', '/api/login', { username: 'sub1', password: 'sub12345' });
  ok(r.status === 401, 'deleted user cannot log in');
  r = await req('DELETE', '/api/users/' + MARIA_ID, null, A);
  // wait — maria has tasks assigned; deletion should still work (tasks stay, name becomes (—))
  ok(r.status === 200, 'admin deletes employee with tasks');
  // cannot delete self
  const meR = await req('GET', '/api/me', null, A);
  r = await req('DELETE', '/api/users/' + meR.json.user.id, null, A);
  ok(r.status === 400, 'admin cannot delete self');
  // cannot delete last admin
  r = await req('DELETE', '/api/users/' + meR.json.user.id, null, A);
  ok(r.status === 400, 'cannot delete last admin');

  console.log('\n[logout]');
  r = await req('POST', '/api/logout', null, M);
  ok(r.status === 200, 'logout');
  r = await req('GET', '/api/tasks', null, M);
  ok(r.status === 401, 'token dead after logout');

  console.log('\n==========================================');
  console.log('PASSED: ' + passed + '  FAILED: ' + failed);
  console.log('==========================================');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
