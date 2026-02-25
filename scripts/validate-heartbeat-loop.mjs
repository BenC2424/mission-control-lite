#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const base = process.env.MCL_BASE_URL || 'http://127.0.0.1:8787';

async function api(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const title = `Heartbeat validation ${new Date().toISOString()} ${randomUUID().slice(0,6)}`;

console.log('1) Create task');
const created = await api('/api/task/create', {
  method: 'POST',
  body: JSON.stringify({ title, status: 'assigned', owner: 'ultron', priority: 'p1' })
});
const taskId = created.task.id;
console.log(`   created: ${taskId}`);

console.log('2) Assign task to codi');
await api('/api/task/assign', {
  method: 'POST',
  body: JSON.stringify({ taskId, agentIds: ['codi'], actor: 'phase1.validation' })
});

console.log('3) Wake codi');
const wake = await api('/api/agent/codi/wake', { method: 'POST' });
console.log(`   wake claimed: ${wake.task?.id || 'none'}`);

console.log('4) Verify in inbox');
const inbox = await api('/api/agent/codi/inbox');
const found = inbox.tasks.find((t) => t.id === taskId);
if (!found) throw new Error(`task ${taskId} not found in codi inbox`);
console.log(`   inbox contains ${taskId}`);

console.log('5) Write progress note + mark in_progress');
await api('/api/task/note', {
  method: 'POST',
  body: JSON.stringify({ id: taskId, note: 'phase1 validation progress note', actor: 'phase1.validation' })
});
await api('/api/task/update', {
  method: 'POST',
  body: JSON.stringify({ id: taskId, status: 'in_progress', actor: 'phase1.validation' })
});

console.log('6) Read metrics');
const metrics = await api('/api/metrics');
console.log(`   open=${metrics.tasks?.open} done=${metrics.tasks?.done} escalations=${metrics.escalationCount}`);

console.log('heartbeat-loop-validation: PASS');
