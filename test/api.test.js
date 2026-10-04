process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `tt-uploads-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function api(method, path, { token, body, form } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: form ?? (body && JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function register(name) {
  const r = await api('POST', '/auth/register', { body: { name, email: `${name}@example.com`, password: 'password123' } });
  assert.equal(r.status, 201);
  return { token: r.body.token, id: r.body.user.id };
}

test('full collaboration flow', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  const eve = await register('eve');

  // auth + profile
  assert.equal((await api('POST', '/auth/register', { body: { name: 'x', email: 'alice@example.com', password: 'password123' } })).status, 409);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'wrongpass1' } })).status, 401);
  assert.equal((await api('POST', '/auth/register', { body: { name: 'x', email: 'bad', password: 'short' } })).status, 400);
  assert.equal((await api('GET', '/users/me')).status, 401);
  const patched = await api('PATCH', '/users/me', { token: alice.token, body: { bio: 'hello' } });
  assert.equal(patched.body.bio, 'hello');

  // team: invite bob by email, eve via code
  const team = (await api('POST', '/teams', { token: alice.token, body: { name: 'Core' } })).body;
  assert.equal((await api('POST', `/teams/${team.id}/members`, { token: alice.token, body: { email: 'bob@example.com' } })).status, 201);
  assert.equal((await api('GET', `/teams/${team.id}`, { token: eve.token })).status, 404);
  assert.equal((await api('POST', `/teams/${team.id}/members`, { token: bob.token, body: { email: 'eve@example.com' } })).status, 403);

  // tasks
  const t = await api('POST', '/tasks', { token: alice.token, body: { title: 'Write docs', description: 'API reference', teamId: team.id, assigneeId: bob.id, dueDate: '2030-01-01' } });
  assert.equal(t.status, 201);
  assert.equal((await api('POST', '/tasks', { token: alice.token, body: { title: 'bad', teamId: team.id, assigneeId: eve.id } })).status, 400);
  assert.equal((await api('GET', `/tasks/${t.body.id}`, { token: eve.token })).status, 404);

  const mine = await api('GET', '/tasks?assignee=me&status=open&q=docs', { token: bob.token });
  assert.equal(mine.body.total, 1);
  assert.equal((await api('GET', '/tasks?q=100%25', { token: bob.token })).body.total, 0);
  assert.equal((await api('GET', '/tasks?sort=bogus', { token: bob.token })).status, 400);

  // notification for assignee
  const notes = await api('GET', '/notifications?unread=true', { token: bob.token });
  assert.equal(notes.body[0].type, 'task_assigned');

  // comments + attachments
  assert.equal((await api('POST', `/tasks/${t.body.id}/comments`, { token: bob.token, body: { body: 'On it' } })).status, 201);
  assert.equal((await api('GET', `/tasks/${t.body.id}/comments`, { token: alice.token })).body.length, 1);
  const form = new FormData();
  form.append('file', new Blob(['hello']), 'notes.txt');
  const up = await api('POST', `/tasks/${t.body.id}/attachments`, { token: bob.token, form });
  assert.equal(up.status, 201);
  const dl = await fetch(`${base}/tasks/${t.body.id}/attachments/${up.body.id}/download`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(await dl.text(), 'hello');

  // complete
  const done = await api('PATCH', `/tasks/${t.body.id}`, { token: bob.token, body: { status: 'completed' } });
  assert.equal(done.body.status, 'completed');
  assert.ok(done.body.completed_at);
  assert.equal((await api('GET', '/tasks?status=completed', { token: alice.token })).body.total, 1);

  // AI (template fallback without key)
  const ai = await api('POST', '/ai/task-description', { token: alice.token, body: { prompt: 'fix login bug' } });
  assert.equal(ai.body.generated_by, 'template');
});

test('logout revokes the token', async () => {
  const u = await register('carol');
  assert.equal((await api('GET', '/users/me', { token: u.token })).status, 200);
  assert.equal((await api('POST', '/auth/logout', { token: u.token })).status, 204);
  assert.equal((await api('GET', '/users/me', { token: u.token })).status, 401);
});
