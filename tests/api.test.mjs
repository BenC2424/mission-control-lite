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

test('GET /api/config returns readOnly flag', async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(typeof json.readOnly, 'boolean');
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

test('GET /api/export returns snapshot payload', async () => {
  const res = await fetch(`${base}/api/export`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(Array.isArray(json.tasks), true);
  assert.equal(Array.isArray(json.activity), true);
  assert.equal(Array.isArray(json.agents), true);
});

test('assign -> inbox -> claim-next flow works', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Heartbeat task', status: 'assigned', owner: 'ultron', priority: 'p1' })
  });
  const c = await create.json();

  const assign = await fetch(`${base}/api/task/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, agentIds: ['codi'] })
  });
  assert.equal(assign.status, 200);

  const inbox = await fetch(`${base}/api/agent/codi/inbox`);
  const i = await inbox.json();
  assert.equal(i.tasks.some((t) => t.id === c.task.id), true);

  const claim = await fetch(`${base}/api/agent/codi/claim-next`, { method: 'POST' });
  const cl = await claim.json();
  assert.equal(cl.ok, true);
  assert.equal(typeof cl.task?.id, 'string');
  assert.equal(i.tasks.some((t) => t.id === cl.task.id), true);
});

test('agent wake endpoint returns task or no_actionable_tasks', async () => {
  const wake = await fetch(`${base}/api/agent/scout/wake`, { method: 'POST' });
  assert.equal(wake.status, 200);
  const w = await wake.json();
  assert.equal(w.ok, true);
});

test('metrics and escalations endpoints respond', async () => {
  const m = await fetch(`${base}/api/metrics`);
  assert.equal(m.status, 200);
  const mj = await m.json();
  assert.equal(typeof mj.escalationCount, 'number');

  const e = await fetch(`${base}/api/escalations`);
  assert.equal(e.status, 200);
  const ej = await e.json();
  assert.equal(Array.isArray(ej.items), true);
});

test('orchestration templates + run endpoint works', async () => {
  const tpl = await fetch(`${base}/api/orchestration/templates`);
  assert.equal(tpl.status, 200);
  const tj = await tpl.json();
  assert.equal(Array.isArray(tj.templates), true);

  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Orchestrate me', status: 'assigned', owner: 'ultron', priority: 'p1' })
  });
  const c = await create.json();

  const run = await fetch(`${base}/api/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, template: 'build_orchestra' })
  });
  assert.equal(run.status, 200);
  const rj = await run.json();
  assert.equal(rj.ok, true);
  assert.equal(rj.plan.template, 'build_orchestra');
});
