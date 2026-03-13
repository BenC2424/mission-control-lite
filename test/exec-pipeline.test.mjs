import test from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.MCL_TEST_BASE_URL || 'https://mission-control-lite-self.vercel.app';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const intent = (title = '') => {
  const m = String(title).match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].toUpperCase() : null;
};

test('EXEC create path auto-assigns into assigned status and inbox row exists', async () => {
  const created = await api('/api/task/create', {
    method: 'POST',
    body: { title: `[EXEC] test create invariant ${Date.now()}`, priority: 'p2', actor: 'autopilot' }
  });
  const t = created.task;
  assert.equal(t.status, 'assigned');
  assert.ok(['codi', 'scout'].includes(t.owner));

  const inbox = await api(`/api/agent/${t.owner}/inbox`);
  assert.equal(inbox.tasks.some((x) => x.id === t.id), true);
});

test('EXEC update reassignment closes old visibility and opens new owner visibility', async () => {
  const created = await api('/api/task/create', {
    method: 'POST',
    body: { title: `[EXEC] test update invariant ${Date.now()}`, priority: 'p2', actor: 'autopilot' }
  });
  const taskId = created.task.id;
  const from = created.task.owner;
  const to = from === 'codi' ? 'scout' : 'codi';

  await api('/api/task/update', {
    method: 'POST',
    body: { id: taskId, status: 'assigned', owner: to, intent: 'EXEC', actor: 'autopilot' }
  });

  const toInbox = await api(`/api/agent/${to}/inbox`);
  const fromInbox = await api(`/api/agent/${from}/inbox`);
  assert.equal(toInbox.tasks.some((x) => x.id === taskId), true);
  assert.equal(fromInbox.tasks.some((x) => x.id === taskId), false);
});

test('claim-next returns runnable assigned EXEC work only', async () => {
  const agent = 'codi';
  const claim = await api('/api/task/claim-next', {
    method: 'POST',
    body: { agentId: agent, actor: 'autopilot' }
  });

  if (claim.claimed === false && claim.reason === 'already_in_progress') {
    assert.ok(claim.task);
    return;
  }

  assert.equal(claim.claimed, true);
  assert.equal(claim.task.status, 'starting');
  assert.equal(intent(claim.task.title), 'EXEC');
});

test('agent inbox endpoint only returns open rows for requested agent (visibility invariant)', async () => {
  const created = await api('/api/task/create', {
    method: 'POST',
    body: { title: `[EXEC] test inbox invariant ${Date.now()}`, priority: 'p2', actor: 'autopilot' }
  });
  const taskId = created.task.id;
  const owner = created.task.owner;
  const other = owner === 'codi' ? 'scout' : 'codi';

  const ownerInbox = await api(`/api/agent/${owner}/inbox`);
  const otherInbox = await api(`/api/agent/${other}/inbox`);

  assert.equal(ownerInbox.tasks.some((x) => x.id === taskId), true);
  assert.equal(otherInbox.tasks.some((x) => x.id === taskId), false);
});
