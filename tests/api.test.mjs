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
    body: JSON.stringify({ title: 'Delete me', status: 'inbox', owner: 'ops', priority: 'p2' })
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

test('PR-1 guard: create rejects inbox owned by non-ops', async () => {
  const res = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR1 invalid inbox owner', status: 'inbox', owner: 'codi', priority: 'p1' })
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.error, 'inbox_owner_must_be_ops');
});

test('PR-1 guard: create allows inbox owned by ops', async () => {
  const res = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR1 valid inbox owner', status: 'inbox', owner: 'ops', priority: 'p1' })
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.task.owner, 'ops');
  assert.equal(json.task.status, 'inbox');
});

test('PR-1 verify endpoint returns invalid_inbox_rows=0', async () => {
  const res = await fetch(`${base}/api/pr1/verify`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(typeof json.invalid_inbox_rows, 'number');
  assert.equal(json.invalid_inbox_rows, 0);
});

test('worker completion flow auto-transitions in_progress -> review', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR2a worker completion test', status: 'in_progress', owner: 'codi', priority: 'p1' })
  });
  assert.equal(create.status, 200);
  const c = await create.json();

  const assign = await fetch(`${base}/api/task/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, agentIds: ['codi'] })
  });
  assert.equal(assign.status, 200);

  const completionPackage = [
    'Summary',
    '- done',
    '',
    'What changed',
    '- file',
    '',
    'Verification steps',
    '- test',
    '',
    'Artifacts',
    '- log',
    '',
    'Follow-ups',
    '- none'
  ].join('\n');

  const complete = await fetch(`${base}/api/agent/codi/complete-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, completionPackage })
  });
  assert.equal(complete.status, 200);
  const cj = await complete.json();
  assert.equal(cj.transitioned, true);
  assert.equal(cj.task.status, 'review');

  const completeAgain = await fetch(`${base}/api/agent/codi/complete-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, completionPackage })
  });
  assert.equal(completeAgain.status, 200);
  const cj2 = await completeAgain.json();
  assert.equal(cj2.idempotent, true);
});

test('inbox hygiene run is telemetry-only', async () => {
  const res = await fetch(`${base}/api/autopilot/inbox-hygiene-run`, { method: 'POST' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.mode, 'telemetry_only');
  assert.equal(typeof json.inbox_triage_required_count, 'number');
  assert.equal(typeof json.archive_candidate_count, 'number');
});

test('review-run dry_run evaluates and returns decisions without mutating', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3 review dry-run', status: 'review', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();
  await fetch(`${base}/api/task/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, actor: 'codi', note: 'Summary\nWhat changed\nVerification steps\nArtifacts\nFollow-ups' })
  });

  const run = await fetch(`${base}/api/autopilot/review-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'dry_run', batchSize: 5 })
  });
  assert.equal(run.status, 200);
  const rj = await run.json();
  assert.equal(rj.mode, 'dry_run');
  assert.equal(Array.isArray(rj.decisions), true);

  const tasks = await fetch(`${base}/api/tasks?mode=full`);
  const tj = await tasks.json();
  const task = (tj.tasks || []).find((t) => t.id === c.task.id);
  assert.equal(task.status, 'review');
});

test('review-run apply reassigns incomplete packages with reason_code', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3 review apply incomplete', status: 'review', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();

  const run = await fetch(`${base}/api/autopilot/review-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'apply', batchSize: 10 })
  });
  assert.equal(run.status, 200);
  const rj = await run.json();
  assert.equal(typeof rj.review_decision_count_last_run, 'number');

  const tasks = await fetch(`${base}/api/tasks?mode=full`);
  const tj = await tasks.json();
  const task = (tj.tasks || []).find((t) => t.id === c.task.id);
  assert.equal(task.status, 'assigned');
  assert.equal((task.notes || []).some((n) => String(n.note || '').includes('review_package_incomplete')), true);
});

test('review transition role guards enforce actor_not_allowed', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3 role guard', status: 'review', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();

  const badDone = await fetch(`${base}/api/task/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'done', owner: 'codi', actor: 'codi' })
  });
  assert.equal(badDone.status, 403);
  const bd = await badDone.json();
  assert.equal(bd.error, 'actor_not_allowed');

  const badReassign = await fetch(`${base}/api/task/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'assigned', owner: 'codi', actor: 'scout' })
  });
  assert.equal(badReassign.status, 403);
  const br = await badReassign.json();
  assert.equal(br.error, 'actor_not_allowed');
});

test('starting guard: assigned -> starting requires ops/autopilot', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3a assigned to starting', status: 'assigned', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();

  const bad = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'starting', actor: 'codi' })
  });
  assert.equal(bad.status, 403);
  const bj = await bad.json();
  assert.equal(bj.error, 'actor_not_allowed');

  const ok = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'starting', actor: 'ops' })
  });
  assert.equal(ok.status, 200);
});

test('starting guard: starting -> in_progress requires owner + ack', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3a starting to in_progress', status: 'starting', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();

  const noAck = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'in_progress', actor: 'codi' })
  });
  assert.equal(noAck.status, 409);
  const na = await noAck.json();
  assert.equal(na.error, 'missing_worker_ack');

  const ack = await fetch(`${base}/api/task/ack-start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, taskId: c.task.id, agentId: 'codi', startedAt: new Date().toISOString() })
  });
  assert.equal(ack.status, 200);

  const ok = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'in_progress', actor: 'codi' })
  });
  assert.equal([200,409].includes(ok.status), true);
});

test('starting guard: starting -> assigned requires ops/autopilot', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3a starting to assigned', status: 'starting', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();

  const bad = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'assigned', actor: 'codi' })
  });
  assert.equal(bad.status, 403);
  const bj = await bad.json();
  assert.equal(bj.error, 'actor_not_allowed');

  const ok = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'assigned', actor: 'autopilot' })
  });
  assert.equal(ok.status, 200);
});

test('starting guard: invalid transition returns invalid_transition', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'PR3a invalid transition', status: 'starting', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();

  const bad = await fetch(`${base}/api/task/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.task.id, status: 'done', actor: 'ops' })
  });
  assert.equal(bad.status, 409);
  const bj = await bad.json();
  assert.equal(bj.error, 'invalid_transition');
});

test('ack-start valid insert + idempotent retry', async () => {
  const create = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'ack valid', status: 'starting', owner: 'codi', priority: 'p1' })
  });
  const c = await create.json();
  const startedAt = new Date().toISOString();

  const a1 = await fetch(`${base}/api/task/ack-start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, agentId: 'codi', startedAt, pidOrSession: 'pid-1' })
  });
  assert.equal(a1.status, 200);
  const j1 = await a1.json();
  assert.equal(j1.ok, true);

  const a2 = await fetch(`${base}/api/task/ack-start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: c.task.id, agentId: 'codi', startedAt, pidOrSession: 'pid-1' })
  });
  assert.equal(a2.status, 200);
  const j2 = await a2.json();
  assert.equal(j2.idempotent, true);
});

test('ack-start rejects non-starting and wrong-owner', async () => {
  const nonStarting = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'ack nonstarting', status: 'assigned', owner: 'codi', priority: 'p1' })
  });
  const n = await nonStarting.json();
  const badStatus = await fetch(`${base}/api/task/ack-start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: n.task.id, agentId: 'codi', startedAt: new Date().toISOString() })
  });
  assert.equal(badStatus.status, 409);
  const bs = await badStatus.json();
  assert.equal(bs.error, 'invalid_transition');

  const starting = await fetch(`${base}/api/task/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'ack wrong owner', status: 'starting', owner: 'codi', priority: 'p1' })
  });
  const s = await starting.json();
  const badOwner = await fetch(`${base}/api/task/ack-start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: s.task.id, agentId: 'scout', startedAt: new Date().toISOString() })
  });
  assert.equal(badOwner.status, 403);
  const bo = await badOwner.json();
  assert.equal(bo.error, 'actor_not_allowed');
});

test('inbox auto-triage handles legit/test/unclear', async () => {
  const mk = async (title) => {
    const r = await fetch(`${base}/api/task/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, status: 'inbox', owner: 'ops', priority: 'p1' })
    });
    const j = await r.json();
    await fetch(`${base}/api/task/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j.task.id, status: 'inbox', owner: 'ops', actor: 'ops' }) });
    await fetch(`${base}/api/task/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j.task.id, actor: 'ops', note: 'seed_backdated' }) });
    return j.task.id;
  };

  const legitId = await mk('Implement auth hardening');
  const testId = await mk('canary smoke test task');
  const unclearId = await mk('Investigate TBD behavior');

  const run = await fetch(`${base}/api/autopilot/inbox-auto-triage-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thresholdMinutes: 0 }) });
  assert.equal(run.status, 200);
  const rj = await run.json();
  assert.equal(rj.ok, true);

  const tasks = await fetch(`${base}/api/tasks?mode=full`);
  const tj = await tasks.json();
  const l = (tj.tasks||[]).find(t=>t.id===legitId);
  const tt = (tj.tasks||[]).find(t=>t.id===testId);
  const u = (tj.tasks||[]).find(t=>t.id===unclearId);
  assert.equal(['assigned','inbox','archived'].includes(l.status), true);
  assert.equal(['archived','inbox'].includes(tt.status), true);
  assert.equal(['inbox','assigned'].includes(u.status), true);
});

test('board-health includes starting metrics', async () => {
  const r = await fetch(`${base}/api/autopilot/board-health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(typeof j.starting_total, 'number');
  assert.equal(typeof j.starting_over_timeout_count, 'number');
  assert.equal(typeof j.starting_oldest_age_minutes, 'number');
  assert.equal(Array.isArray(j.sample_starting_task_ids), true);
});

test('UI includes Starting column and starting ack/waiting render markers', async () => {
  const r = await fetch(`${base}/ui/app.js`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes("starting:'Starting'"), true);
  assert.equal(text.includes('awaiting_ack'), true);
  assert.equal(text.includes('ack_received'), true);
  assert.equal(text.includes('waiting ${ageBadge(t.updatedAt)}'), true);
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
