import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_PATH = join(process.cwd(), 'runtime', 'mission-control.sqlite');
const TASKS_JSON = join(process.cwd(), 'runtime', 'tasks.json');
const ACTIVITY_JSON = join(process.cwd(), 'runtime', 'activity.json');
const AGENTS_JSON = join(process.cwd(), 'config', 'agents.json');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  seen_at TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  UNIQUE(task_id, agent_id)
);
CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();

export function seedFromJsonIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM tasks').get();
  if (row.c > 0) return;

  if (existsSync(AGENTS_JSON)) {
    const agents = JSON.parse(readFileSync(AGENTS_JSON, 'utf8')).agents || [];
    const ins = db.prepare('INSERT OR IGNORE INTO agents (id, role, created_at) VALUES (?, ?, ?)');
    for (const a of agents) ins.run(a.id, a.role || 'agent', now());
  }

  if (existsSync(TASKS_JSON)) {
    const tasks = JSON.parse(readFileSync(TASKS_JSON, 'utf8')).tasks || [];
    const insTask = db.prepare('INSERT OR IGNORE INTO tasks (id, title, status, priority, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insNote = db.prepare('INSERT INTO task_notes (task_id, note, created_at, actor) VALUES (?, ?, ?, ?)');
    for (const t of tasks) {
      insTask.run(t.id, t.title, t.status, t.priority || 'p2', t.owner || 'ultron', t.createdAt || now(), t.updatedAt || now());
      for (const n of (t.notes || [])) insNote.run(t.id, n.note || '', n.at || now(), 'import');
    }
  }

  if (existsSync(ACTIVITY_JSON)) {
    const events = JSON.parse(readFileSync(ACTIVITY_JSON, 'utf8')).events || [];
    const insEvent = db.prepare('INSERT INTO task_events (task_id, type, message, actor, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const e of events) insEvent.run(e.taskId || null, e.type || 'event', e.message || '', e.actor || 'import', e.at || now());
  }
}

export function listTasks() {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all();
  const notesStmt = db.prepare('SELECT note, created_at FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 50');
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    owner: t.owner,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    notes: notesStmt.all(t.id).map((n) => ({ note: n.note, at: n.created_at }))
  }));
}

export function listEvents(limit = 300) {
  return db.prepare('SELECT task_id as taskId, type, message, actor, created_at as at FROM task_events ORDER BY id DESC LIMIT ?').all(limit);
}

export function createTask(task) {
  db.prepare('INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(task.id, task.title, task.status, task.priority, task.owner, task.createdAt, task.updatedAt);
}

export function updateTask(patch) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(patch.id);
  if (!t) return null;
  const status = patch.status || t.status;
  const owner = patch.owner || t.owner;
  const priority = patch.priority || t.priority;
  const updatedAt = now();
  db.prepare('UPDATE tasks SET status=?, owner=?, priority=?, updated_at=? WHERE id=?').run(status, owner, priority, updatedAt, patch.id);
  return { ...t, status, owner, priority, updated_at: updatedAt };
}

export function deleteTask(id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) return null;
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  db.prepare('DELETE FROM task_notes WHERE task_id=?').run(id);
  db.prepare('DELETE FROM task_assignments WHERE task_id=?').run(id);
  return t;
}

export function addNote(taskId, note, actor) {
  db.prepare('INSERT INTO task_notes (task_id, note, created_at, actor) VALUES (?, ?, ?, ?)').run(taskId, note, now(), actor);
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), taskId);
}

export function addEvent({ taskId = null, type, message, actor = 'system' }) {
  db.prepare('INSERT INTO task_events (task_id, type, message, actor, created_at) VALUES (?, ?, ?, ?, ?)').run(taskId, type, message, actor, now());
}

export function assignTask(taskId, agentId) {
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, agent_id, assigned_at) VALUES (?, ?, ?)').run(taskId, agentId, now());
}

export function agentInbox(agentId) {
  return db.prepare(`
    SELECT t.*, a.assigned_at, a.seen_at, a.claimed_at
    FROM task_assignments a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.agent_id = ? AND a.completed_at IS NULL
    ORDER BY a.claimed_at IS NOT NULL, t.updated_at DESC
  `).all(agentId).map((r) => ({
    id: r.id, title: r.title, status: r.status, priority: r.priority, owner: r.owner,
    assignedAt: r.assigned_at, seenAt: r.seen_at, claimedAt: r.claimed_at
  }));
}

export function markInboxSeen(agentId) {
  db.prepare('UPDATE task_assignments SET seen_at = COALESCE(seen_at, ?) WHERE agent_id = ? AND completed_at IS NULL').run(now(), agentId);
}

export function claimNext(agentId) {
  const next = db.prepare(`
    SELECT a.task_id FROM task_assignments a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.agent_id = ? AND a.completed_at IS NULL AND a.claimed_at IS NULL
    ORDER BY t.priority='p0' DESC, t.priority='p1' DESC, a.assigned_at ASC
    LIMIT 1
  `).get(agentId);
  if (!next) return null;
  db.prepare('UPDATE task_assignments SET claimed_at = ? WHERE agent_id=? AND task_id=?').run(now(), agentId, next.task_id);
  return db.prepare('SELECT id, title, status, priority, owner FROM tasks WHERE id=?').get(next.task_id);
}

export function recordHeartbeat(agentId, status, summary = '') {
  db.prepare('INSERT INTO heartbeat_runs (agent_id, status, summary, created_at) VALUES (?, ?, ?, ?)').run(agentId, status, summary, now());
}
