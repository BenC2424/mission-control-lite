#!/usr/bin/env node
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateTaskCreate, validateTaskUpdate, VALID_PRIORITY } from './lib/validation.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);

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
  const db = readJson(paths.activity);
  db.events.unshift({ at: now(), type, message, taskId, actor });
  db.events = db.events.slice(0, 300);
  writeJson(paths.activity, db);
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
    if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, readJson(paths.tasks));
    if (url.pathname === '/api/agents' && req.method === 'GET') return send(res, 200, readJson(paths.agents));
    if (url.pathname === '/api/activity' && req.method === 'GET') return send(res, 200, readJson(paths.activity));

    if (url.pathname === '/api/export' && req.method === 'GET') {
      return send(res, 200, {
        version: 1,
        exportedAt: now(),
        tasks: readJson(paths.tasks).tasks || [],
        activity: readJson(paths.activity).events || [],
        agents: readJson(paths.agents).agents || []
      });
    }

    if (url.pathname === '/api/task/create' && req.method === 'POST') {
      const body = await parseBody(req);
      const validation = validateTaskCreate(body);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const db = readJson(paths.tasks);
      const task = {
        id: `mcl-${randomUUID().slice(0, 8)}`,
        title: body.title.trim(),
        status: body.status || 'inbox',
        priority: body.priority || 'p2',
        owner: body.owner || 'ultron',
        notes: [],
        evidence: { tests: [], artifacts: [], sources: [] },
        createdAt: now(),
        updatedAt: now()
      };
      db.tasks.push(task);
      writeJson(paths.tasks, db);
      logEvent('task_created', `${task.owner} created ${task.id}: ${task.title}`, task.id, task.owner);
      return send(res, 200, { ok: true, task });
    }

    if (url.pathname === '/api/task/update' && req.method === 'POST') {
      const patch = await parseBody(req);
      const validation = validateTaskUpdate(patch);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const db = readJson(paths.tasks);
      const t = db.tasks.find((x) => x.id === patch.id);
      if (!t) return send(res, 404, { error: 'task not found' });

      if (patch.status) t.status = patch.status;
      if (patch.owner) t.owner = patch.owner;
      if (patch.priority && VALID_PRIORITY.includes(patch.priority)) t.priority = patch.priority;
      t.updatedAt = now();
      writeJson(paths.tasks, db);
      logEvent('task_updated', `${t.id} -> ${t.status} (${t.owner})`, t.id, patch.actor || 'ui');
      return send(res, 200, { ok: true, task: t });
    }

    if (url.pathname === '/api/task/note' && req.method === 'POST') {
      const body = await parseBody(req);
      const db = readJson(paths.tasks);
      const t = db.tasks.find((x) => x.id === body.id);
      if (!t) return send(res, 404, { error: 'task not found' });
      t.notes ??= [];
      t.notes.push({ at: now(), note: body.note || '' });
      t.updatedAt = now();
      writeJson(paths.tasks, db);
      logEvent('task_note', `${t.id}: ${body.note || ''}`, t.id, body.actor || 'ui');
      return send(res, 200, { ok: true, task: t });
    }

    if (url.pathname === '/api/task/delete' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.id) return send(res, 400, { error: 'validation_failed', details: ['id is required'] });
      const db = readJson(paths.tasks);
      const index = db.tasks.findIndex((x) => x.id === body.id);
      if (index === -1) return send(res, 404, { error: 'task not found' });
      const [removed] = db.tasks.splice(index, 1);
      writeJson(paths.tasks, db);
      logEvent('task_deleted', `${removed.id}: ${removed.title}`, removed.id, body.actor || 'ui');
      return send(res, 200, { ok: true, deletedId: removed.id });
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || body.overwrite !== true) {
        return send(res, 400, { error: 'validation_failed', details: ['overwrite=true is required'] });
      }
      if (!Array.isArray(body.tasks) || !Array.isArray(body.activity)) {
        return send(res, 400, { error: 'validation_failed', details: ['tasks and activity arrays are required'] });
      }

      writeJson(paths.tasks, { version: 1, tasks: body.tasks });
      writeJson(paths.activity, { version: 1, events: body.activity });
      logEvent('import', `Imported snapshot with ${body.tasks.length} tasks and ${body.activity.length} events`, null, body.actor || 'ui');
      return send(res, 200, { ok: true, tasks: body.tasks.length, activity: body.activity.length });
    }

    if (url.pathname === '/api/standup' && req.method === 'POST') {
      const db = readJson(paths.tasks);
      const text = getStandup(db.tasks || []);
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
