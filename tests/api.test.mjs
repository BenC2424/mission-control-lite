import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.mjs';

let base = '';

test.before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

test('GET /api/health responds ok', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
});

test('POST /api/task/create rejects invalid payload', async () => {
  const res = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', status: 'bad-status' })
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error, 'validation_failed');
});

test('POST /api/task/delete deletes created task', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Delete me', status: 'inbox', owner: 'ultron', priority: 'p2' })
  });
  const created = await create.json();
  const id = created.task.id;

  const del = await fetch(`${base}/api/task/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  assert.equal(del.status, 200);
  const out = await del.json();
  assert.equal(out.deletedId, id);
});
