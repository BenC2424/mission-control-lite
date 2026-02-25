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
  getMetrics,
  getEscalations,
  db
} from './lib/db.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const READ_ONLY = process.env.READ_ONLY === '1';

const paths = {
  tasks: join(__dirname, 'runtime', 'tasks.json'),
  agents: join(__dirname, 'config', 'agents.json'),
  standup: join(__dirname, 'runtime', 'standup-latest.md'),
  activity: join(__dirname, 'runtime', 'activity.json')
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
seedFromJsonIfEmpty();

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

function logEvent(type, message, taskId = null, actor = 'system') {
  addEvent({ type, message, taskId, actor });
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
    if (url.pathname === '/api/metrics' && req.method === 'GET') return send(res, 200, getMetrics());
    if (url.pathname === '/api/escalations' && req.method === 'GET') return send(res, 200, { items: getEscalations(100) });
    if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, { version: 1, tasks: listTasks() });
    if (url.pathname === '/api/agents' && req.method === 'GET') return send(res, 200, readJson(paths.agents));
    if (url.pathname === '/api/activity' && req.method === 'GET') return send(res, 200, { version: 1, events: listEvents(300) });

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/inbox') && req.method === 'GET') {
      const agentId = url.pathname.split('/')[3];
      markInboxSeen(agentId);
      return send(res, 200, { agentId, tasks: agentInbox(agentId) });
    }

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/wake') && req.method === 'POST') {
      const agentId = url.pathname.split('/')[3];
      markInboxSeen(agentId);
      const task = claimNext(agentId);
      const summary = task ? `claimed ${task.id}` : 'no_actionable_tasks';
      recordHeartbeat(agentId, 'ok', summary);
      if (task) addEvent({ type: 'task_claimed', message: `${agentId} claimed ${task.id}`, taskId: task.id, actor: agentId });
      return send(res, 200, { ok: true, agentId, task, inboxCount: agentInbox(agentId).length });
    }

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/claim-next') && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const agentId = url.pathname.split('/')[3];
      const task = claimNext(agentId);
      if (!task) return send(res, 200, { ok: true, task: null });
      addEvent({ type: 'task_claimed', message: `${agentId} claimed ${task.id}`, taskId: task.id, actor: agentId });
      return send(res, 200, { ok: true, task });
    }

    if (url.pathname === '/api/heartbeat/run' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.agentId) return send(res, 400, { error: 'validation_failed', details: ['agentId is required'] });
      recordHeartbeat(body.agentId, body.status || 'ok', body.summary || '');
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/task/assign' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body.taskId || !Array.isArray(body.agentIds) || body.agentIds.length === 0) {
        return send(res, 400, { error: 'validation_failed', details: ['taskId and non-empty agentIds[] required'] });
      }
      for (const id of body.agentIds) assignTask(body.taskId, id);
      addEvent({ type: 'task_assigned', message: `${body.taskId} assigned to ${body.agentIds.join(', ')}`, taskId: body.taskId, actor: body.actor || 'ui' });
      return send(res, 200, { ok: true, taskId: body.taskId, assigned: body.agentIds.length });
    }

    if (url.pathname === '/api/export' && req.method === 'GET') {
      return send(res, 200, {
        version: 1,
        exportedAt: now(),
        tasks: listTasks(),
        activity: listEvents(1000),
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
      createTask(task);
      logEvent('task_created', `${task.owner} created ${task.id}: ${task.title}`, task.id, task.owner);
      return send(res, 200, { ok: true, task });
    }

    if (url.pathname === '/api/task/update' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const patch = await parseBody(req);
      const validation = validateTaskUpdate(patch);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const t = updateTask({
        id: patch.id,
        status: patch.status,
        owner: patch.owner,
        priority: patch.priority && VALID_PRIORITY.includes(patch.priority) ? patch.priority : undefined
      });
      if (!t) return send(res, 404, { error: 'task not found' });

      logEvent('task_updated', `${t.id} -> ${t.status} (${t.owner})`, t.id, patch.actor || 'ui');
      return send(res, 200, { ok: true, task: {
        id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner, updatedAt: t.updated_at
      }});
    }

    if (url.pathname === '/api/task/note' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const existing = listTasks().find((x) => x.id === body.id);
      if (!existing) return send(res, 404, { error: 'task not found' });
      addNote(body.id, body.note || '', body.actor || 'ui');
      logEvent('task_note', `${body.id}: ${body.note || ''}`, body.id, body.actor || 'ui');
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/task/delete' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      if (!body.id) return send(res, 400, { error: 'validation_failed', details: ['id is required'] });
      const removed = deleteTask(body.id);
      if (!removed) return send(res, 404, { error: 'task not found' });
      logEvent('task_deleted', `${removed.id}: ${removed.title}`, removed.id, body.actor || 'ui');
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

      db.exec('DELETE FROM task_assignments; DELETE FROM task_notes; DELETE FROM tasks; DELETE FROM task_events;');
      for (const t of body.tasks) {
        createTask({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority || 'p2',
          owner: t.owner || 'ultron',
          createdAt: t.createdAt || now(),
          updatedAt: t.updatedAt || now()
        });
        for (const n of (t.notes || [])) addNote(t.id, n.note || '', 'import');
      }
      for (const e of body.activity) addEvent({ taskId: e.taskId || null, type: e.type || 'event', message: e.message || '', actor: e.actor || 'import' });

      logEvent('import', `Imported snapshot with ${body.tasks.length} tasks and ${body.activity.length} events`, null, body.actor || 'ui');
      return send(res, 200, { ok: true, tasks: body.tasks.length, activity: body.activity.length });
    }

    if (url.pathname === '/api/standup' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const text = getStandup(listTasks());
      writeFileSync(paths.standup, text + '\n');
      logEvent('standup', 'Generated standup report');
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(PORT, HOST, () => {
    console.log(`Mission Control server running on http://${HOST}:${PORT}`);
  });
}
