#!/usr/bin/env node
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateTaskCreate, validateTaskUpdate, VALID_PRIORITY } from './lib/validation.mjs';
import {
  seedFromJsonIfEmpty,
  listTasks,
  listEvents,
  createTask,
  updateTask,
  deleteTask,
  addNote,
  addEvent,
  assignTask,
  agentInbox,
  markInboxSeen,
  claimNext,
  recordHeartbeat,
  resetAssignmentClaim,
  getMetrics,
  getEscalations,
  clearAllData
} from './lib/db.mjs';
import { loadPolicies, buildOrchestrationPlan } from './lib/orchestration.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const READ_ONLY = process.env.READ_ONLY === '1';
const WIP_STALE_MINUTES = Number(process.env.MCL_WIP_STALE_MINUTES || 15);
const WIP_RECOVERY_GRACE_MINUTES = Number(process.env.MCL_WIP_RECOVERY_GRACE_MINUTES || 5);
const WATCHDOG_INTERVAL_MS = Number(process.env.MCL_WATCHDOG_INTERVAL_MS || 0);

const paths = {
  tasks: join(__dirname, 'runtime', 'tasks.json'),
  agents: join(__dirname, 'config', 'agents.json'),
  standup: join(__dirname, 'runtime', 'standup-latest.md'),
  activity: join(__dirname, 'runtime', 'activity.json'),
  leases: join(__dirname, 'runtime', 'execution-leases.json')
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const now = () => new Date().toISOString();
await seedFromJsonIfEmpty();

let leaseState = { version: 1, leases: {} };
let leasePersistenceEnabled = true;
try {
  if (existsSync(paths.leases)) {
    leaseState = readJson(paths.leases);
  } else {
    writeJson(paths.leases, leaseState);
  }
} catch {
  // Serverless/read-only filesystems cannot persist runtime state.
  // Fallback to in-memory lease store for process lifetime.
  leasePersistenceEnabled = false;
}

function persistLeases() {
  if (!leasePersistenceEnabled) return;
  try {
    writeJson(paths.leases, leaseState);
  } catch {
    leasePersistenceEnabled = false;
  }
}

function openLease(taskId, agentId) {
  const runId = `run-${randomUUID().slice(0, 12)}`;
  leaseState.leases[taskId] = { runId, agentId, status: 'active', openedAt: now(), closedAt: null };
  persistLeases();
  return leaseState.leases[taskId];
}
function closeLease(taskId, reason = 'closed') {
  const lease = leaseState.leases[taskId];
  if (!lease || lease.status !== 'active') return null;
  lease.status = reason;
  lease.closedAt = now();
  persistLeases();
  return lease;
}
function activeLease(taskId) {
  const lease = leaseState.leases[taskId];
  return lease && lease.status === 'active' ? lease : null;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  if (Buffer.isBuffer(body)) return res.end(body);
  if (typeof body === 'string') return res.end(body);
  return res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function logEvent(type, message, taskId = null, actor = 'system') {
  await addEvent({ type, message, taskId, actor });
}

async function runWatchdogPass(actor = 'watchdog') {
  const tasks = await listTasks();
  const events = await listEvents(2000);
  const nowMs = Date.now();
  const staleCutoffMs = WIP_STALE_MINUTES * 60 * 1000;
  const graceMs = WIP_RECOVERY_GRACE_MINUTES * 60 * 1000;

  const byTask = new Map();
  for (const e of events) {
    if (!e.taskId) continue;
    const arr = byTask.get(e.taskId) || [];
    arr.push(e);
    byTask.set(e.taskId, arr);
  }

  const outcome = { checked: 0, nudged: 0, recovered: 0, skipped: 0, items: [] };

  for (const t of tasks) {
    if (t.status !== 'in_progress') continue;
    outcome.checked += 1;
    const evidenceAt = Date.parse(t.lastExecutionEvidenceAt || t.updatedAt || t.createdAt || 0);
    if (!Number.isFinite(evidenceAt)) { outcome.skipped += 1; continue; }
    const ageMs = nowMs - evidenceAt;
    if (ageMs < staleCutoffMs) continue;

    const taskEvents = byTask.get(t.id) || [];
    const nudgeTimes = taskEvents
      .filter((e) => e.type === 'worker_nudge_sent')
      .map((e) => Date.parse(e.at))
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    const lastNudgeAt = nudgeTimes[0] || 0;

    // Start a stale episode with a single nudge.
    // Any new execution evidence starts a fresh episode and allows another nudge.
    const needsInitialNudge = !lastNudgeAt || (lastNudgeAt < evidenceAt);
    if (needsInitialNudge) {
      await addEvent({
        type: 'worker_nudge_sent',
        message: `${actor} nudge for stale in_progress ${t.id} (${t.owner}) age=${Math.round(ageMs / 60000)}m`,
        taskId: t.id,
        actor
      });
      await recordHeartbeat(t.owner, 'warn', `watchdog_nudge ${t.id}`);
      outcome.nudged += 1;
      outcome.items.push({ taskId: t.id, action: 'nudged', owner: t.owner, staleMinutes: Math.round(ageMs / 60000) });
      continue;
    }

    // Grace countdown anchors to last nudge for this stale episode.
    if (nowMs - lastNudgeAt < graceMs) {
      outcome.skipped += 1;
      continue;
    }

    await updateTask({ id: t.id, status: 'assigned', owner: t.owner });
    await resetAssignmentClaim(t.id, t.owner);
    closeLease(t.id, 'recovered');
    await addEvent({
      type: 'worker_run_ended',
      message: `${actor} recovered stale in_progress ${t.id} back to assigned`,
      taskId: t.id,
      actor
    });
    await addEvent({
      type: 'watchdog_recovered',
      message: `${t.id} recovered to assigned after stale in_progress timeout`,
      taskId: t.id,
      actor
    });
    outcome.recovered += 1;
    outcome.items.push({ taskId: t.id, action: 'recovered', owner: t.owner, staleMinutes: Math.round(ageMs / 60000) });
  }

  return { ok: true, ...outcome, thresholds: { staleMinutes: WIP_STALE_MINUTES, graceMinutes: WIP_RECOVERY_GRACE_MINUTES } };
}

function getStandup(tasks) {
  const by = (s) => tasks.filter((t) => t.status === s);
  return [
    `# DAILY STANDUP — ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## ✅ Completed',
    ...by('done').map((t) => `- ${t.owner}: ${t.title} (${t.id})`),
    '',
    '## 🔄 In Progress',
    ...by('in_progress').map((t) => `- ${t.owner}: ${t.title} (${t.id})`),
    '',
    '## 🚫 Blocked',
    ...by('blocked').map((t) => `- ${t.owner}: ${t.title} (${t.id})`),
    '',
    '## 👀 Review',
    ...by('review').map((t) => `- ${t.owner}: ${t.title} (${t.id})`),
    ''
  ].join('\n');
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return send(res, 200, '');

  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, service: 'mission-control-lite', time: now() });
    }
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { readOnly: READ_ONLY });
    if (url.pathname === '/api/metrics' && req.method === 'GET') return send(res, 200, await getMetrics());
    if (url.pathname === '/api/escalations' && req.method === 'GET') return send(res, 200, { items: await getEscalations(100) });
    if (url.pathname === '/api/orchestration/templates' && req.method === 'GET') {
      const policy = loadPolicies();
      return send(res, 200, { templates: Object.keys(policy.templates || {}) });
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, { version: 1, tasks: await listTasks() });
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      const payload = readJson(paths.agents);
      const agents = Array.isArray(payload.agents) ? payload.agents : [];
      if (!agents.some((a) => a.id === 'ops')) {
        agents.push({
          id: 'ops',
          sessionKey: 'agent:main:subagent:ops',
          role: 'operations',
          capabilities: ['ops', 'triage', 'governance', 'watchdog'],
          canExternalMessage: false,
          canDestructive: false
        });
      }
      return send(res, 200, { ...payload, agents });
    }
    if (url.pathname === '/api/activity' && req.method === 'GET') return send(res, 200, { version: 1, events: await listEvents(300) });

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/inbox') && req.method === 'GET') {
      const agentId = url.pathname.split('/')[3];
      await markInboxSeen(agentId);
      return send(res, 200, { agentId, tasks: await agentInbox(agentId) });
    }

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/wake') && req.method === 'POST') {
      const agentId = url.pathname.split('/')[3];
      await markInboxSeen(agentId);
      const task = await claimNext(agentId);
      const summary = task ? `claimed ${task.id}` : 'no_actionable_tasks';
      await recordHeartbeat(agentId, 'ok', summary);
      if (task) {
        const lease = openLease(task.id, agentId);
        await addEvent({ type: 'task_claimed', message: `${agentId} claimed ${task.id} run_id=${lease.runId}`, taskId: task.id, actor: agentId });
        await addEvent({ type: 'worker_claimed_task', message: `${agentId} accepted task payload for ${task.id} run_id=${lease.runId}`, taskId: task.id, actor: agentId });
        task.runId = lease.runId;
      }
      return send(res, 200, { ok: true, agentId, task, inboxCount: (await agentInbox(agentId)).length });
    }

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/claim-next') && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const agentId = url.pathname.split('/')[3];
      const task = await claimNext(agentId);
      if (!task) return send(res, 200, { ok: true, task: null });
      const lease = openLease(task.id, agentId);
      await addEvent({ type: 'task_claimed', message: `${agentId} claimed ${task.id} run_id=${lease.runId}`, taskId: task.id, actor: agentId });
      await addEvent({ type: 'worker_claimed_task', message: `${agentId} accepted task payload for ${task.id} run_id=${lease.runId}`, taskId: task.id, actor: agentId });
      return send(res, 200, { ok: true, task: { ...task, runId: lease.runId } });
    }

    if (url.pathname === '/api/heartbeat/run' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.agentId) return send(res, 400, { error: 'validation_failed', details: ['agentId is required'] });
      await recordHeartbeat(body.agentId, body.status || 'ok', body.summary || '');
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/worker/event' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body.taskId || !body.agentId || !body.type) {
        return send(res, 400, { error: 'validation_failed', details: ['taskId, agentId, and type are required'] });
      }
      const type = String(body.type);
      const allowed = new Set(['worker_claimed_task', 'worker_first_progress', 'worker_progress_heartbeat', 'worker_run_ended']);
      if (!allowed.has(type)) {
        return send(res, 400, { error: 'validation_failed', details: ['unsupported worker event type'] });
      }

      const lease = activeLease(body.taskId);
      if (!body.runId) {
        return send(res, 409, { error: 'run_id_required', details: ['runId is required for worker events'] });
      }
      if (!lease || lease.runId !== body.runId || lease.agentId !== body.agentId) {
        await addEvent({
          type: 'worker_event_rejected_old_run',
          taskId: body.taskId,
          actor: body.agentId,
          message: `ignored ${type} for stale/non-active run_id=${body.runId}`
        });
        return send(res, 202, { ok: true, ignored: true, reason: 'stale_or_non_active_run' });
      }

      await addEvent({ type, taskId: body.taskId, actor: body.agentId, message: body.message || `${body.agentId} ${type} ${body.taskId} run_id=${body.runId}` });
      if (body.note) await addNote(body.taskId, String(body.note), body.agentId);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/watchdog/run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      return send(res, 200, await runWatchdogPass(body?.actor || 'watchdog'));
    }

    if (url.pathname === '/api/task/assign' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body.taskId || !Array.isArray(body.agentIds) || body.agentIds.length === 0) {
        return send(res, 400, { error: 'validation_failed', details: ['taskId and non-empty agentIds[] required'] });
      }
      for (const id of body.agentIds) await assignTask(body.taskId, id);
      await addEvent({ type: 'task_assigned', message: `${body.taskId} assigned to ${body.agentIds.join(', ')}`, taskId: body.taskId, actor: body.actor || 'ui' });
      return send(res, 200, { ok: true, taskId: body.taskId, assigned: body.agentIds.length });
    }

    if (url.pathname === '/api/orchestrate' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body.taskId || !body.template) {
        return send(res, 400, { error: 'validation_failed', details: ['taskId and template required'] });
      }
      const task = (await listTasks()).find((t) => t.id === body.taskId);
      if (!task) return send(res, 404, { error: 'task not found' });

      const plan = buildOrchestrationPlan({ taskId: task.id, template: body.template, title: task.title });

      for (const w of plan.workers) {
        const targetAgent = w.role.startsWith('codi') ? 'codi' : w.role.startsWith('scout') ? 'scout' : 'ultron';
        await assignTask(task.id, targetAgent);
      }

      await addNote(task.id, `[ORCHESTRA:${plan.template}] workers=${plan.workers.map((w) => w.role).join(', ')} evidence=${plan.evidence.join(', ')}`, body.actor || 'ui.orchestrator');
      await addEvent({ type: 'orchestra_started', message: `${task.id} started ${plan.template} with ${plan.workers.length} workers`, taskId: task.id, actor: body.actor || 'ui.orchestrator' });

      return send(res, 200, { ok: true, plan });
    }

    if (url.pathname === '/api/export' && req.method === 'GET') {
      return send(res, 200, {
        version: 1,
        exportedAt: now(),
        tasks: await listTasks(),
        activity: await listEvents(1000),
        agents: readJson(paths.agents).agents || []
      });
    }

    if (url.pathname === '/api/task/create' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const validation = validateTaskCreate(body);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const task = {
        id: `mcl-${randomUUID().slice(0, 8)}`,
        title: body.title.trim(),
        status: body.status || 'inbox',
        priority: body.priority || 'p2',
        owner: body.owner || 'ultron',
        createdAt: now(),
        updatedAt: now()
      };
      await createTask(task);
      await logEvent('task_created', `${task.owner} created ${task.id}: ${task.title}`, task.id, task.owner);
      return send(res, 200, { ok: true, task });
    }

    if (url.pathname === '/api/task/update' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const patch = await parseBody(req);
      const validation = validateTaskUpdate(patch);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const targetStatus = patch.status;
      if (targetStatus === 'in_progress') {
        const tasksNow = await listTasks();
        const current = tasksNow.find((x) => x.id === patch.id);
        if (!current) return send(res, 404, { error: 'task not found' });

        const actor = String(patch.actor || patch.owner || current.owner || '');
        const events = await listEvents(500);
        const related = events.filter((e) => e.taskId === patch.id);
        const hasClaim = related.some((e) => e.type === 'worker_claimed_task' && (!actor || e.actor === actor));
        const hasProgress = related.some((e) => e.type === 'worker_first_progress' && (!actor || e.actor === actor));

        // Any transition into in_progress must be backed by claim or first task-bound progress evidence.
        // This blocks control-plane-only promotions from assigned/starting/other pre-states.
        if (current.status !== 'in_progress' && !hasClaim && !hasProgress) {
          return send(res, 409, {
            error: 'promotion_blocked',
            details: ['transition->in_progress requires worker_claimed_task or worker_first_progress']
          });
        }
      }

      const t = await updateTask({
        id: patch.id,
        status: targetStatus,
        owner: patch.owner,
        priority: patch.priority && VALID_PRIORITY.includes(patch.priority) ? patch.priority : undefined
      });
      if (!t) return send(res, 404, { error: 'task not found' });

      if (['done','archived'].includes(String(t.status))) closeLease(t.id, 'completed');
      await logEvent('task_updated', `${t.id} -> ${t.status} (${t.owner})`, t.id, patch.actor || 'ui');
      return send(res, 200, { ok: true, task: {
        id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner, updatedAt: t.updated_at
      }});
    }

    if (url.pathname === '/api/task/note' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const existing = (await listTasks()).find((x) => x.id === body.id);
      if (!existing) return send(res, 404, { error: 'task not found' });
      const actor = body.actor || 'ui';
      await addNote(body.id, body.note || '', actor);
      await logEvent('task_note', `${body.id}: ${body.note || ''}`, body.id, actor);
      if (['codi', 'scout'].includes(String(actor)) && String(body.note || '').trim()) {
        const lease = activeLease(body.id);
        if (lease && lease.agentId === actor) {
          await addEvent({
            type: 'worker_first_progress',
            message: `${actor} posted first progress evidence for ${body.id} run_id=${lease.runId}`,
            taskId: body.id,
            actor
          });
        }
      }
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/task/delete' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body.id) return send(res, 400, { error: 'validation_failed', details: ['id is required'] });
      const removed = await deleteTask(body.id);
      if (!removed) return send(res, 404, { error: 'task not found' });
      await logEvent('task_deleted', `${removed.id}: ${removed.title}`, removed.id, body.actor || 'ui');
      return send(res, 200, { ok: true, deletedId: removed.id });
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body || body.overwrite !== true) {
        return send(res, 400, { error: 'validation_failed', details: ['overwrite=true is required'] });
      }
      if (!Array.isArray(body.tasks) || !Array.isArray(body.activity)) {
        return send(res, 400, { error: 'validation_failed', details: ['tasks and activity arrays are required'] });
      }

      await clearAllData();
      for (const t of body.tasks) {
        await createTask({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority || 'p2',
          owner: t.owner || 'ultron',
          createdAt: t.createdAt || now(),
          updatedAt: t.updatedAt || now()
        });
        for (const n of (t.notes || [])) await addNote(t.id, n.note || '', 'import');
      }
      for (const e of body.activity) await addEvent({ taskId: e.taskId || null, type: e.type || 'event', message: e.message || '', actor: e.actor || 'import' });

      await logEvent('import', `Imported snapshot with ${body.tasks.length} tasks and ${body.activity.length} events`, null, body.actor || 'ui');
      return send(res, 200, { ok: true, tasks: body.tasks.length, activity: body.activity.length });
    }

    if (url.pathname === '/api/standup' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const text = getStandup(await listTasks());
      writeFileSync(paths.standup, text + '\n');
      await logEvent('standup', 'Generated standup report');
      return send(res, 200, { ok: true, standup: text });
    }

    let filePath = url.pathname === '/' ? '/ui/index.html' : url.pathname;
    if (filePath === '/ui/' || filePath === '/ui') filePath = '/ui/index.html';
    const abs = join(__dirname, filePath.replace(/^\//, ''));
    if (!abs.startsWith(__dirname) || !existsSync(abs)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, readFileSync(abs), mime[extname(abs)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

export default server;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(PORT, HOST, () => {
    console.log(`Mission Control server running on http://${HOST}:${PORT}`);

    if (!READ_ONLY && WATCHDOG_INTERVAL_MS > 0) {
      console.log(`Watchdog scheduler enabled every ${WATCHDOG_INTERVAL_MS}ms`);
      setInterval(async () => {
        try {
          const out = await runWatchdogPass('watchdog.scheduler');
          if (out.nudged > 0 || out.recovered > 0) {
            console.log(`watchdog.scheduler action: nudged=${out.nudged} recovered=${out.recovered}`);
          }
        } catch (err) {
          console.error(`watchdog.scheduler error: ${String(err?.message || err)}`);
        }
      }, WATCHDOG_INTERVAL_MS).unref();
    }
  });
}
