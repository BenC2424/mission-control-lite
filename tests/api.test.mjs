import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

async function waitForHealth(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

test.before(async () => {
  proc = spawn('node', ['server.mjs'], {
    cwd: '/home/ubuntu/.openclaw/workspace/mission-control-lite',
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  await waitForHealth();
});

test.after(() => {
  if (proc && !proc.killed) proc.kill('SIGTERM');
});

test('GET /api/health responds ok', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
});

test('POST /api/task/create rejects invalid payload', async () => {
  const res = await fetch(`${BASE}/api/task/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', status: 'bad-status' })
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error, 'validation_failed');
});
