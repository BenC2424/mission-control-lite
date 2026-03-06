import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE_DIR = process.env.VERCEL ? '/tmp' : process.cwd();
const RUNTIME_DIR = join(BASE_DIR, 'runtime');
mkdirSync(RUNTIME_DIR, { recursive: true });

const DB_PATH = join(RUNTIME_DIR, 'mission-control.sqlite');
const TASKS_JSON = join(process.cwd(), 'runtime', 'tasks.json');
const ACTIVITY_JSON = join(process.cwd(), 'runtime', 'activity.json');
const AGENTS_JSON = join(process.cwd(), 'config', 'agents.json');

const now = () => new Date().toISOString();
const CLAIM_TIMEOUT_MINUTES = Number(process.env.CLAIM_TIMEOUT_MINUTES || 60);
const DB_MODE = (process.env.MCL_DB || 'sqlite').toLowerCase();

const SQLITE_SCHEMA = `
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
`;

const POSTGRES_SCHEMA = `
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
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_assignments (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  seen_at TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  UNIQUE(task_id, agent_id)
);
CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
`;

let backend;

async function initSqlite() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SQLITE_SCHEMA);

  return {
    mode: 'sqlite',
    async scalar(sql, ...params) {
      const row = db.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : null;
    },
    async all(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, ...params) {
      return db.prepare(sql).get(...params) || null;
    },
    async run(sql, ...params) {
      return db.prepare(sql).run(...params);
    },
    async exec(sql) {
      db.exec(sql);
    }
  };
}

async function initPostgres() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('MCL_DB=postgres requires DATABASE_URL');

  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(POSTGRES_SCHEMA);

  return {
    mode: 'postgres',
    async scalar(sql, ...params) {
      const res = await client.query(sql, params);
      return res.rows[0] ? Object.values(res.rows[0])[0] : null;
    },
    async all(sql, ...params) {
      const res = await client.query(sql, params);
      return res.rows;
    },
    async get(sql, ...params) {
      const res = await client.query(sql, params);
      return res.rows[0] || null;
    },
    async run(sql, ...params) {
      return client.query(sql, params);
    },
    async exec(sql) {
      return client.query(sql);
    }
  };
}

async function initBackend() {
  if (DB_MODE === 'postgres') return initPostgres();
  return initSqlite();
}

backend = await initBackend();

function sql(byMode) {
  return backend.mode === 'postgres' ? byMode.postgres : byMode.sqlite;
}

export async function seedFromJsonIfEmpty() {
  const countSql = sql({
    sqlite: 'SELECT COUNT(*) AS c FROM tasks',
    postgres: 'SELECT COUNT(*)::int AS c FROM tasks'
  });
  const row = await backend.get(countSql);
  if ((row?.c || 0) > 0) return;

  if (existsSync(AGENTS_JSON)) {
    const agents = JSON.parse(readFileSync(AGENTS_JSON, 'utf8')).agents || [];
    const ins = sql({
      sqlite: 'INSERT OR IGNORE INTO agents (id, role, created_at) VALUES (?, ?, ?)',
      postgres: 'INSERT INTO agents (id, role, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING'
    });
    for (const a of agents) await backend.run(ins, a.id, a.role || 'agent', now());
  }

  if (existsSync(TASKS_JSON)) {
    const tasks = JSON.parse(readFileSync(TASKS_JSON, 'utf8')).tasks || [];
    const insTask = sql({
      sqlite: 'INSERT OR IGNORE INTO tasks (id, title, status, priority, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING'
    });
    const insNote = sql({
      sqlite: 'INSERT INTO task_notes (task_id, note, created_at, actor) VALUES (?, ?, ?, ?)',
      postgres: 'INSERT INTO task_notes (task_id, note, created_at, actor) VALUES ($1, $2, $3, $4)'
    });
    for (const t of tasks) {
      await backend.run(insTask, t.id, t.title, t.status, t.priority || 'p2', t.owner || 'ultron', t.createdAt || now(), t.updatedAt || now());
      for (const n of (t.notes || [])) await backend.run(insNote, t.id, n.note || '', n.at || now(), 'import');
    }
  }

  if (existsSync(ACTIVITY_JSON)) {
    const events = JSON.parse(readFileSync(ACTIVITY_JSON, 'utf8')).events || [];
    const insEvent = sql({
      sqlite: 'INSERT INTO task_events (task_id, type, message, actor, created_at) VALUES (?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_events (task_id, type, message, actor, created_at) VALUES ($1, $2, $3, $4, $5)'
    });
    for (const e of events) await backend.run(insEvent, e.taskId || null, e.type || 'event', e.message || '', e.actor || 'import', e.at || now());
  }
}

export async function listTasks() {
  const tasks = await backend.all('SELECT * FROM tasks ORDER BY updated_at DESC');
  const notesSql = sql({
    sqlite: 'SELECT note, created_at FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 50',
    postgres: 'SELECT note, created_at FROM task_notes WHERE task_id = $1 ORDER BY id DESC LIMIT 50'
  });

  const out = [];
  for (const t of tasks) {
    const notes = await backend.all(notesSql, t.id);
    out.push({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      owner: t.owner,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      notes: notes.map((n) => ({ note: n.note, at: n.created_at }))
    });
  }
  return out;
}

export async function listEvents(limit = 300) {
  const q = sql({
    sqlite: 'SELECT task_id as taskId, type, message, actor, created_at as at FROM task_events ORDER BY id DESC LIMIT ?',
    postgres: 'SELECT task_id as "taskId", type, message, actor, created_at as at FROM task_events ORDER BY id DESC LIMIT $1'
  });
  return backend.all(q, limit);
}

export async function createTask(task) {
  const q = sql({
    sqlite: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    postgres: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)'
  });
  await backend.run(q, task.id, task.title, task.status, task.priority, task.owner, task.createdAt, task.updatedAt);
}

export async function updateTask(patch) {
  const sel = sql({ sqlite: 'SELECT * FROM tasks WHERE id = ?', postgres: 'SELECT * FROM tasks WHERE id = $1' });
  const t = await backend.get(sel, patch.id);
  if (!t) return null;
  const status = patch.status || t.status;
  const owner = patch.owner || t.owner;
  const priority = patch.priority || t.priority;
  const updatedAt = now();

  const upd = sql({
    sqlite: 'UPDATE tasks SET status=?, owner=?, priority=?, updated_at=? WHERE id=?',
    postgres: 'UPDATE tasks SET status=$1, owner=$2, priority=$3, updated_at=$4 WHERE id=$5'
  });
  await backend.run(upd, status, owner, priority, updatedAt, patch.id);

  if (status === 'done') {
    const doneQ = sql({
      sqlite: 'UPDATE task_assignments SET completed_at = COALESCE(completed_at, ?) WHERE task_id = ?',
      postgres: 'UPDATE task_assignments SET completed_at = COALESCE(completed_at, $1) WHERE task_id = $2'
    });
    await backend.run(doneQ, updatedAt, patch.id);
  }

  return { ...t, status, owner, priority, updated_at: updatedAt };
}

export async function deleteTask(id) {
  const sel = sql({ sqlite: 'SELECT * FROM tasks WHERE id=?', postgres: 'SELECT * FROM tasks WHERE id=$1' });
  const t = await backend.get(sel, id);
  if (!t) return null;

  await backend.run(sql({ sqlite: 'DELETE FROM tasks WHERE id=?', postgres: 'DELETE FROM tasks WHERE id=$1' }), id);
  await backend.run(sql({ sqlite: 'DELETE FROM task_notes WHERE task_id=?', postgres: 'DELETE FROM task_notes WHERE task_id=$1' }), id);
  await backend.run(sql({ sqlite: 'DELETE FROM task_assignments WHERE task_id=?', postgres: 'DELETE FROM task_assignments WHERE task_id=$1' }), id);
  return t;
}

export async function getTaskById(id) {
  return backend.get(sql({ sqlite: 'SELECT id FROM tasks WHERE id = ?', postgres: 'SELECT id FROM tasks WHERE id = $1' }), id);
}

export async function addNote(taskId, note, actor) {
  await backend.run(
    sql({
      sqlite: 'INSERT INTO task_notes (task_id, note, created_at, actor) VALUES (?, ?, ?, ?)',
      postgres: 'INSERT INTO task_notes (task_id, note, created_at, actor) VALUES ($1, $2, $3, $4)'
    }),
    taskId,
    note,
    now(),
    actor
  );
  await backend.run(
    sql({ sqlite: 'UPDATE tasks SET updated_at=? WHERE id=?', postgres: 'UPDATE tasks SET updated_at=$1 WHERE id=$2' }),
    now(),
    taskId
  );
}

export async function addEvent({ taskId = null, type, message, actor = 'system' }) {
  await backend.run(
    sql({
      sqlite: 'INSERT INTO task_events (task_id, type, message, actor, created_at) VALUES (?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_events (task_id, type, message, actor, created_at) VALUES ($1, $2, $3, $4, $5)'
    }),
    taskId,
    type,
    message,
    actor,
    now()
  );
}

export async function assignTask(taskId, agentId) {
  await backend.run(
    sql({
      sqlite: 'INSERT OR IGNORE INTO task_assignments (task_id, agent_id, assigned_at) VALUES (?, ?, ?)',
      postgres: 'INSERT INTO task_assignments (task_id, agent_id, assigned_at) VALUES ($1, $2, $3) ON CONFLICT (task_id, agent_id) DO NOTHING'
    }),
    taskId,
    agentId,
    now()
  );
}

export async function agentInbox(agentId) {
  const q = sql({
    sqlite: `
      SELECT t.*, a.assigned_at, a.seen_at, a.claimed_at
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.agent_id = ? AND a.completed_at IS NULL
      ORDER BY a.claimed_at IS NOT NULL, t.updated_at DESC
    `,
    postgres: `
      SELECT t.*, a.assigned_at, a.seen_at, a.claimed_at
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.agent_id = $1 AND a.completed_at IS NULL
      ORDER BY CASE WHEN a.claimed_at IS NOT NULL THEN 1 ELSE 0 END, t.updated_at DESC
    `
  });

  const rows = await backend.all(q, agentId);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    owner: r.owner,
    assignedAt: r.assigned_at,
    seenAt: r.seen_at,
    claimedAt: r.claimed_at
  }));
}

export async function markInboxSeen(agentId) {
  await backend.run(
    sql({
      sqlite: 'UPDATE task_assignments SET seen_at = COALESCE(seen_at, ?) WHERE agent_id = ? AND completed_at IS NULL',
      postgres: 'UPDATE task_assignments SET seen_at = COALESCE(seen_at, $1) WHERE agent_id = $2 AND completed_at IS NULL'
    }),
    now(),
    agentId
  );
}

export async function claimNext(agentId) {
  const nextQ = sql({
    sqlite: `
      SELECT a.task_id FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.agent_id = ?
        AND a.completed_at IS NULL
        AND (
          a.claimed_at IS NULL
          OR datetime(a.claimed_at) < datetime('now', '-' || ? || ' minutes')
        )
      ORDER BY t.priority='p0' DESC, t.priority='p1' DESC, a.assigned_at ASC
      LIMIT 1
    `,
    postgres: `
      SELECT a.task_id FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.agent_id = $1
        AND a.completed_at IS NULL
        AND (
          a.claimed_at IS NULL
          OR a.claimed_at::timestamptz < (NOW() - ($2::text || ' minutes')::interval)
        )
      ORDER BY (t.priority='p0') DESC, (t.priority='p1') DESC, a.assigned_at ASC
      LIMIT 1
    `
  });

  const next = await backend.get(nextQ, agentId, CLAIM_TIMEOUT_MINUTES);
  if (!next) return null;

  await backend.run(
    sql({
      sqlite: 'UPDATE task_assignments SET claimed_at = ? WHERE agent_id=? AND task_id=?',
      postgres: 'UPDATE task_assignments SET claimed_at = $1 WHERE agent_id=$2 AND task_id=$3'
    }),
    now(),
    agentId,
    next.task_id
  );

  return backend.get(
    sql({ sqlite: 'SELECT id, title, status, priority, owner FROM tasks WHERE id=?', postgres: 'SELECT id, title, status, priority, owner FROM tasks WHERE id=$1' }),
    next.task_id
  );
}

export async function recordHeartbeat(agentId, status, summary = '') {
  await backend.run(
    sql({
      sqlite: 'INSERT INTO heartbeat_runs (agent_id, status, summary, created_at) VALUES (?, ?, ?, ?)',
      postgres: 'INSERT INTO heartbeat_runs (agent_id, status, summary, created_at) VALUES ($1, $2, $3, $4)'
    }),
    agentId,
    status,
    summary,
    now()
  );
}

export async function getEscalations(limit = 50) {
  const blockedQ = sql({
    sqlite: `
      SELECT id as taskId, title, status, owner, updated_at as updatedAt,
        'blocked_over_24h' as reason
      FROM tasks
      WHERE status='blocked' AND datetime(updated_at) < datetime('now', '-24 hours')
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    postgres: `
      SELECT id as "taskId", title, status, owner, updated_at as "updatedAt",
        'blocked_over_24h' as reason
      FROM tasks
      WHERE status='blocked' AND updated_at::timestamptz < (NOW() - INTERVAL '24 hours')
      ORDER BY updated_at ASC
      LIMIT $1
    `
  });
  const blocked = await backend.all(blockedQ, limit);

  const staleQ = sql({
    sqlite: `
      SELECT t.id as taskId, t.title, t.status, t.owner, a.claimed_at as updatedAt,
        'claimed_timeout' as reason
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.completed_at IS NULL
        AND a.claimed_at IS NOT NULL
        AND datetime(a.claimed_at) < datetime('now', '-' || ? || ' minutes')
      ORDER BY a.claimed_at ASC
      LIMIT ?
    `,
    postgres: `
      SELECT t.id as "taskId", t.title, t.status, t.owner, a.claimed_at as "updatedAt",
        'claimed_timeout' as reason
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.completed_at IS NULL
        AND a.claimed_at IS NOT NULL
        AND a.claimed_at::timestamptz < (NOW() - ($1::text || ' minutes')::interval)
      ORDER BY a.claimed_at ASC
      LIMIT $2
    `
  });
  const staleClaims = await backend.all(staleQ, CLAIM_TIMEOUT_MINUTES, limit);

  return [...blocked, ...staleClaims].slice(0, limit);
}

export async function getMetrics() {
  const counts = await backend.get(sql({
    sqlite: `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status!='done' THEN 1 ELSE 0 END) as open
      FROM tasks
    `,
    postgres: `
      SELECT
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END), 0)::int as done,
        COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END), 0)::int as blocked,
        COALESCE(SUM(CASE WHEN status!='done' THEN 1 ELSE 0 END), 0)::int as open
      FROM tasks
    `
  }));

  const assignment = await backend.get(sql({
    sqlite: `
      SELECT
        COUNT(*) as totalAssignments,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as completedAssignments,
        SUM(CASE WHEN seen_at IS NOT NULL THEN 1 ELSE 0 END) as seenAssignments,
        SUM(CASE WHEN claimed_at IS NOT NULL AND completed_at IS NULL THEN 1 ELSE 0 END) as inFlightAssignments
      FROM task_assignments
    `,
    postgres: `
      SELECT
        COUNT(*)::int as "totalAssignments",
        COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int as "completedAssignments",
        COALESCE(SUM(CASE WHEN seen_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int as "seenAssignments",
        COALESCE(SUM(CASE WHEN claimed_at IS NOT NULL AND completed_at IS NULL THEN 1 ELSE 0 END), 0)::int as "inFlightAssignments"
      FROM task_assignments
    `
  }));

  const stale = await backend.get(sql({
    sqlite: `
      SELECT COUNT(*) as staleOpen
      FROM tasks
      WHERE status != 'done' AND datetime(updated_at) < datetime('now', '-24 hours')
    `,
    postgres: `
      SELECT COUNT(*)::int as "staleOpen"
      FROM tasks
      WHERE status != 'done' AND updated_at::timestamptz < (NOW() - INTERVAL '24 hours')
    `
  }));

  const heartbeats = await backend.all(sql({
    sqlite: `
      SELECT agent_id as agentId, status, summary, created_at as at
      FROM heartbeat_runs
      ORDER BY id DESC
      LIMIT 50
    `,
    postgres: `
      SELECT agent_id as "agentId", status, summary, created_at as at
      FROM heartbeat_runs
      ORDER BY id DESC
      LIMIT 50
    `
  }));

  const escalations = await getEscalations(200);
  return {
    tasks: counts,
    assignments: assignment,
    staleOpen: stale.staleOpen || 0,
    escalationCount: escalations.length,
    latestHeartbeats: heartbeats
  };
}

export async function clearAllData() {
  await backend.exec('DELETE FROM task_assignments; DELETE FROM task_notes; DELETE FROM tasks; DELETE FROM task_events;');
}

export const db = { mode: backend.mode };
