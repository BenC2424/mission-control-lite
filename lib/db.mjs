import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const TENANT_ID = process.env.MCL_TENANT_ID || 'internal';

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
CREATE TABLE IF NOT EXISTS task_start_acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  pid_or_session TEXT,
  heartbeat_at TEXT,
  note_at TEXT,
  tenant_id TEXT,
  UNIQUE(task_id, agent_id, started_at)
);
CREATE TABLE IF NOT EXISTS heartbeat_restart_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  result TEXT NOT NULL,
  skip_reason TEXT,
  cooldown_until TEXT,
  attempt_count_window INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT
);
CREATE TABLE IF NOT EXISTS task_recovery_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action_at TEXT NOT NULL,
  result TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT
);
CREATE TABLE IF NOT EXISTS standups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  content_md TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  run_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  content_md TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  capabilities_profile TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, agent_id)
);
CREATE TABLE IF NOT EXISTS tenant_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  status TEXT NOT NULL,
  activated_at TEXT,
  deactivated_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, team_key)
);
CREATE TABLE IF NOT EXISTS team_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  plan_key TEXT,
  template_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  monthly_price TEXT,
  default_team_template TEXT,
  max_teams INTEGER NOT NULL DEFAULT 1,
  max_agents INTEGER NOT NULL,
  max_wip INTEGER NOT NULL,
  max_tasks INTEGER,
  features_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL UNIQUE,
  plan_key TEXT NOT NULL,
  subscription_id TEXT,
  status TEXT NOT NULL,
  activated_at TEXT,
  limits_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  billing_provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_onboarding (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_plan TEXT,
  requested_team_type TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  created_by TEXT,
  notes TEXT,
  last_validation_json TEXT
);
CREATE TABLE IF NOT EXISTS tenant_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  team_key TEXT,
  agent_id TEXT,
  event_type TEXT NOT NULL,
  task_id TEXT,
  tokens_used INTEGER,
  compute_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_rollups_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  agent_actions INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  compute_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, day)
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
CREATE TABLE IF NOT EXISTS task_start_acks (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  pid_or_session TEXT,
  heartbeat_at TEXT,
  note_at TEXT,
  tenant_id TEXT,
  UNIQUE(task_id, agent_id, started_at)
);
CREATE TABLE IF NOT EXISTS heartbeat_restart_attempts (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  result TEXT NOT NULL,
  skip_reason TEXT,
  cooldown_until TEXT,
  attempt_count_window INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT
);
CREATE TABLE IF NOT EXISTS task_recovery_actions (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action_at TEXT NOT NULL,
  result TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT
);
CREATE TABLE IF NOT EXISTS standups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  content_md TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  run_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  content_md TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_agents (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  capabilities_profile TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, agent_id)
);
CREATE TABLE IF NOT EXISTS tenant_teams (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  status TEXT NOT NULL,
  activated_at TEXT,
  deactivated_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, team_key)
);
CREATE TABLE IF NOT EXISTS team_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  plan_key TEXT,
  template_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_plans (
  id BIGSERIAL PRIMARY KEY,
  plan_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  monthly_price TEXT,
  default_team_template TEXT,
  max_teams INTEGER NOT NULL DEFAULT 1,
  max_agents INTEGER NOT NULL,
  max_wip INTEGER NOT NULL,
  max_tasks INTEGER,
  features_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_plans (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  plan_key TEXT NOT NULL,
  subscription_id TEXT,
  status TEXT NOT NULL,
  activated_at TEXT,
  limits_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  billing_provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_onboarding (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_plan TEXT,
  requested_team_type TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  created_by TEXT,
  notes TEXT,
  last_validation_json TEXT
);
CREATE TABLE IF NOT EXISTS tenant_users (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  team_key TEXT,
  agent_id TEXT,
  event_type TEXT NOT NULL,
  task_id TEXT,
  tokens_used INTEGER,
  compute_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_rollups_daily (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  agent_actions INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  compute_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, day)
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

let _hasLastActivityColumn;
async function hasLastActivityColumn() {
  if (typeof _hasLastActivityColumn === 'boolean') return _hasLastActivityColumn;
  try {
    if (backend.mode === 'postgres') {
      const row = await backend.get(
        "SELECT 1 as ok FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'last_activity_at' LIMIT 1"
      );
      _hasLastActivityColumn = !!row;
      return _hasLastActivityColumn;
    }
    const cols = await backend.all('PRAGMA table_info(tasks)');
    _hasLastActivityColumn = cols.some((c) => c.name === 'last_activity_at');
    return _hasLastActivityColumn;
  } catch {
    _hasLastActivityColumn = false;
    return false;
  }
}

async function ensureTenantFoundation() {
  const tenantTables = ['agents','tasks','task_notes','task_events','task_assignments','heartbeat_runs','task_start_acks','heartbeat_restart_attempts','task_recovery_actions','standups','weekly_reports','tenant_agents','tenant_teams','tenant_plans','tenant_users'];
  if (backend.mode === 'postgres') {
    await backend.exec('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_activity_at TEXT');
    for (const table of tenantTables) {
      await backend.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await backend.exec(`UPDATE ${table} SET tenant_id = '${TENANT_ID}' WHERE tenant_id IS NULL`);
    }
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status)');
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_last_activity ON tasks(tenant_id, last_activity_at)');
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_task_events_tenant_task ON task_events(tenant_id, task_id)');
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_tenant_agent_at ON heartbeat_runs(tenant_id, agent_id, created_at)');
    await backend.exec('CREATE TABLE IF NOT EXISTS task_start_acks (id BIGSERIAL PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, started_at TEXT NOT NULL, pid_or_session TEXT, heartbeat_at TEXT, note_at TEXT, tenant_id TEXT, UNIQUE(task_id, agent_id, started_at))');
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_task_start_acks_tenant_task ON task_start_acks(tenant_id, task_id, agent_id, started_at)');
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_standups_tenant_generated_at ON standups(tenant_id, generated_at)');
    await backend.exec('CREATE INDEX IF NOT EXISTS idx_weekly_reports_tenant_generated_at ON weekly_reports(tenant_id, generated_at)');
    await backend.exec('CREATE TABLE IF NOT EXISTS service_plans (id BIGSERIAL PRIMARY KEY, plan_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, monthly_price TEXT, default_team_template TEXT, max_teams INTEGER NOT NULL DEFAULT 1, max_agents INTEGER NOT NULL, max_wip INTEGER NOT NULL, max_tasks INTEGER, features_json TEXT, created_at TEXT NOT NULL)');
    await backend.exec('CREATE TABLE IF NOT EXISTS tenant_plans (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL UNIQUE, plan_key TEXT NOT NULL, subscription_id TEXT, status TEXT NOT NULL, activated_at TEXT, limits_json TEXT, created_at TEXT NOT NULL)');
    await backend.exec('CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_key TEXT NOT NULL, billing_provider TEXT NOT NULL, provider_customer_id TEXT, provider_subscription_id TEXT, status TEXT NOT NULL, current_period_start TEXT, current_period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    await backend.exec('CREATE TABLE IF NOT EXISTS tenant_teams (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, team_key TEXT NOT NULL, status TEXT NOT NULL, activated_at TEXT, deactivated_at TEXT, created_at TEXT NOT NULL, UNIQUE(tenant_id, team_key))');
    await backend.exec('CREATE TABLE IF NOT EXISTS usage_events (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, team_key TEXT, agent_id TEXT, event_type TEXT NOT NULL, task_id TEXT, tokens_used INTEGER, compute_ms INTEGER, created_at TEXT NOT NULL)');
    await backend.exec('CREATE TABLE IF NOT EXISTS usage_rollups_daily (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, day TEXT NOT NULL, tasks_completed INTEGER NOT NULL DEFAULT 0, agent_actions INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, compute_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(tenant_id, day))');
    await backend.exec('ALTER TABLE tenant_plans ADD COLUMN IF NOT EXISTS subscription_id TEXT');
    await backend.exec('ALTER TABLE team_templates ADD COLUMN IF NOT EXISTS plan_key TEXT');
    await backend.exec('ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS max_teams INTEGER');

    const seedTeam = ['ultron','ops','codi','scout'];
    for (const a of seedTeam) {
      await backend.run('INSERT INTO tenant_agents (tenant_id, agent_id, role, enabled, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, agent_id) DO NOTHING', TENANT_ID, a, 'agent', 1, now());
    }

    const plans = [
      { plan_key: 'starter', name: 'Starter', description: 'Small team', monthly_price: null, default_team_template: 'general_team', max_teams: 1, max_agents: 2, max_wip: 2, max_tasks: 200, features: { reports: true, restart: false } },
      { plan_key: 'professional', name: 'Professional', description: 'Balanced team', monthly_price: null, default_team_template: 'general_team', max_teams: 2, max_agents: 4, max_wip: 4, max_tasks: 1000, features: { reports: true, restart: true } },
      { plan_key: 'enterprise', name: 'Enterprise', description: 'Full team', monthly_price: null, default_team_template: 'general_team', max_teams: 4, max_agents: 8, max_wip: 8, max_tasks: 10000, features: { reports: true, restart: true, advanced_ops: true } }
    ];
    for (const p of plans) {
      await backend.run('INSERT INTO service_plans (plan_key,name,description,monthly_price,default_team_template,max_teams,max_agents,max_wip,max_tasks,features_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (plan_key) DO NOTHING', p.plan_key, p.name, p.description, p.monthly_price, p.default_team_template, p.max_teams, p.max_agents, p.max_wip, p.max_tasks, JSON.stringify(p.features||{}), now());
    }

    const templates = [
      {
        name: 'general_team',
        plan_key: 'starter',
        template_json: JSON.stringify({ agents: seedTeam.map((agentId) => ({ agentId, role: 'agent', enabled: 1 })), defaults: { wip_limit_in_progress: 4, review_limit: 3 } })
      },
      {
        name: 'research_team',
        plan_key: 'starter',
        template_json: JSON.stringify({ agents: [{ agentId: 'scout', role: 'research', enabled: 1 }, { agentId: 'ultron', role: 'operator', enabled: 1 }], defaults: { wip_limit_in_progress: 2 } })
      },
      {
        name: 'dev_team',
        plan_key: 'professional',
        template_json: JSON.stringify({ agents: [{ agentId: 'codi', role: 'developer', enabled: 1 }, { agentId: 'ultron', role: 'operator', enabled: 1 }], defaults: { wip_limit_in_progress: 3 } })
      },
      {
        name: 'ops_team',
        plan_key: 'professional',
        template_json: JSON.stringify({ agents: [{ agentId: 'ops', role: 'operations', enabled: 1 }, { agentId: 'ultron', role: 'operator', enabled: 1 }], defaults: { wip_limit_in_progress: 3 } })
      }
    ];
    for (const t of templates) {
      await backend.run('INSERT INTO team_templates (name, plan_key, template_json, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING', t.name, t.plan_key, t.template_json, now());
    }

    await backend.run("UPDATE service_plans SET max_teams = COALESCE(max_teams, CASE WHEN plan_key='starter' THEN 1 WHEN plan_key='professional' THEN 2 ELSE 4 END)");
    return;
  }

  try { await backend.exec('ALTER TABLE tasks ADD COLUMN last_activity_at TEXT'); } catch {}
  for (const table of tenantTables) {
    try { await backend.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT`); } catch {}
    await backend.run(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`, TENANT_ID);
  }
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status)'); } catch {}
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_last_activity ON tasks(tenant_id, last_activity_at)'); } catch {}
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_task_events_tenant_task ON task_events(tenant_id, task_id)'); } catch {}
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_tenant_agent_at ON heartbeat_runs(tenant_id, agent_id, created_at)'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS task_start_acks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, started_at TEXT NOT NULL, pid_or_session TEXT, heartbeat_at TEXT, note_at TEXT, tenant_id TEXT, UNIQUE(task_id, agent_id, started_at))'); } catch {}
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_task_start_acks_tenant_task ON task_start_acks(tenant_id, task_id, agent_id, started_at)'); } catch {}
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_standups_tenant_generated_at ON standups(tenant_id, generated_at)'); } catch {}
  try { await backend.exec('CREATE INDEX IF NOT EXISTS idx_weekly_reports_tenant_generated_at ON weekly_reports(tenant_id, generated_at)'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS service_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, monthly_price TEXT, default_team_template TEXT, max_teams INTEGER NOT NULL DEFAULT 1, max_agents INTEGER NOT NULL, max_wip INTEGER NOT NULL, max_tasks INTEGER, features_json TEXT, created_at TEXT NOT NULL)'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS tenant_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL UNIQUE, plan_key TEXT NOT NULL, subscription_id TEXT, status TEXT NOT NULL, activated_at TEXT, limits_json TEXT, created_at TEXT NOT NULL)'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan_key TEXT NOT NULL, billing_provider TEXT NOT NULL, provider_customer_id TEXT, provider_subscription_id TEXT, status TEXT NOT NULL, current_period_start TEXT, current_period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS tenant_teams (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, team_key TEXT NOT NULL, status TEXT NOT NULL, activated_at TEXT, deactivated_at TEXT, created_at TEXT NOT NULL, UNIQUE(tenant_id, team_key))'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, team_key TEXT, agent_id TEXT, event_type TEXT NOT NULL, task_id TEXT, tokens_used INTEGER, compute_ms INTEGER, created_at TEXT NOT NULL)'); } catch {}
  try { await backend.exec('CREATE TABLE IF NOT EXISTS usage_rollups_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, day TEXT NOT NULL, tasks_completed INTEGER NOT NULL DEFAULT 0, agent_actions INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, compute_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(tenant_id, day))'); } catch {}
  try { await backend.exec('ALTER TABLE tenant_plans ADD COLUMN subscription_id TEXT'); } catch {}
  try { await backend.exec('ALTER TABLE team_templates ADD COLUMN plan_key TEXT'); } catch {}
  try { await backend.exec('ALTER TABLE service_plans ADD COLUMN max_teams INTEGER'); } catch {}

  const seedTeam = ['ultron','ops','codi','scout'];
  for (const a of seedTeam) {
    if (backend.mode === 'postgres') {
      await backend.run('INSERT INTO tenant_agents (tenant_id, agent_id, role, enabled, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, agent_id) DO NOTHING', TENANT_ID, a, 'agent', 1, now());
    } else {
      await backend.run('INSERT OR IGNORE INTO tenant_agents (tenant_id, agent_id, role, enabled, created_at) VALUES (?, ?, ?, ?, ?)', TENANT_ID, a, 'agent', 1, now());
    }
  }

  const plans = [
    { plan_key: 'starter', name: 'Starter', description: 'Small team', monthly_price: null, default_team_template: 'general_team', max_teams: 1, max_agents: 2, max_wip: 2, max_tasks: 200, features: { reports: true, restart: false } },
    { plan_key: 'professional', name: 'Professional', description: 'Balanced team', monthly_price: null, default_team_template: 'general_team', max_teams: 2, max_agents: 4, max_wip: 4, max_tasks: 1000, features: { reports: true, restart: true } },
    { plan_key: 'enterprise', name: 'Enterprise', description: 'Full team', monthly_price: null, default_team_template: 'general_team', max_teams: 4, max_agents: 8, max_wip: 8, max_tasks: 10000, features: { reports: true, restart: true, advanced_ops: true } }
  ];
  for (const p of plans) {
    if (backend.mode === 'postgres') {
      await backend.run('INSERT INTO service_plans (plan_key,name,description,monthly_price,default_team_template,max_agents,max_wip,max_tasks,features_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (plan_key) DO NOTHING', p.plan_key, p.name, p.description, p.monthly_price, p.default_team_template, p.max_agents, p.max_wip, p.max_tasks, JSON.stringify(p.features||{}), now());
    } else {
      await backend.run('INSERT OR IGNORE INTO service_plans (plan_key,name,description,monthly_price,default_team_template,max_teams,max_agents,max_wip,max_tasks,features_json,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', p.plan_key, p.name, p.description, p.monthly_price, p.default_team_template, p.max_teams, p.max_agents, p.max_wip, p.max_tasks, JSON.stringify(p.features||{}), now());
    }
  }

  const templates = [
    {
      name: 'general_team',
      plan_key: 'starter',
      template_json: JSON.stringify({ agents: seedTeam.map((agentId) => ({ agentId, role: 'agent', enabled: 1 })), defaults: { wip_limit_in_progress: 4, review_limit: 3 } })
    },
    {
      name: 'research_team',
      plan_key: 'starter',
      template_json: JSON.stringify({ agents: [{ agentId: 'scout', role: 'research', enabled: 1 }, { agentId: 'ultron', role: 'operator', enabled: 1 }], defaults: { wip_limit_in_progress: 2 } })
    },
    {
      name: 'dev_team',
      plan_key: 'professional',
      template_json: JSON.stringify({ agents: [{ agentId: 'codi', role: 'developer', enabled: 1 }, { agentId: 'ultron', role: 'operator', enabled: 1 }], defaults: { wip_limit_in_progress: 3 } })
    },
    {
      name: 'ops_team',
      plan_key: 'professional',
      template_json: JSON.stringify({ agents: [{ agentId: 'ops', role: 'operations', enabled: 1 }, { agentId: 'ultron', role: 'operator', enabled: 1 }], defaults: { wip_limit_in_progress: 3 } })
    }
  ];

  for (const t of templates) {
    if (backend.mode === 'postgres') {
      await backend.run('INSERT INTO team_templates (name, plan_key, template_json, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING', t.name, t.plan_key, t.template_json, now());
    } else {
      await backend.run('INSERT OR IGNORE INTO team_templates (name, plan_key, template_json, created_at) VALUES (?, ?, ?, ?)', t.name, t.plan_key, t.template_json, now());
    }
  }
}

await ensureTenantFoundation();

export async function applyPr1InboxOwnershipInvariant() {
  const migrationId = '20260308_001_pr1_inbox_ownership_invariant';

  // Backfill (tasks)
  await backend.run(
    sql({
      sqlite: "UPDATE tasks SET owner = 'ops', updated_at = ? WHERE tenant_id = ? AND status = 'inbox' AND owner <> 'ops'",
      postgres: "UPDATE tasks SET owner = 'ops', updated_at = $1 WHERE tenant_id = $2 AND status = 'inbox' AND owner <> 'ops'"
    }),
    now(),
    TENANT_ID
  );

  // DB-level invariant
  if (backend.mode === 'postgres') {
    await backend.exec("ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_inbox_owner_must_be_ops_chk");
    await backend.exec("ALTER TABLE tasks ADD CONSTRAINT tasks_inbox_owner_must_be_ops_chk CHECK (status <> 'inbox' OR owner = 'ops')");
  } else {
    await backend.exec("DROP TRIGGER IF EXISTS trg_tasks_inbox_owner_ops_insert");
    await backend.exec("DROP TRIGGER IF EXISTS trg_tasks_inbox_owner_ops_update");
    await backend.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_tasks_inbox_owner_ops_insert
      BEFORE INSERT ON tasks
      FOR EACH ROW
      WHEN NEW.status = 'inbox' AND NEW.owner <> 'ops'
      BEGIN
        SELECT RAISE(ABORT, 'inbox_owner_must_be_ops');
      END;
    `);
    await backend.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_tasks_inbox_owner_ops_update
      BEFORE UPDATE OF status, owner ON tasks
      FOR EACH ROW
      WHEN NEW.status = 'inbox' AND NEW.owner <> 'ops'
      BEGIN
        SELECT RAISE(ABORT, 'inbox_owner_must_be_ops');
      END;
    `);
  }

  return { ok: true, migrationId };
}

await applyPr1InboxOwnershipInvariant();

export async function seedFromJsonIfEmpty() {
  const countSql = sql({
    sqlite: 'SELECT COUNT(*) AS c FROM tasks WHERE tenant_id = ?',
    postgres: 'SELECT COUNT(*)::int AS c FROM tasks WHERE tenant_id = $1'
  });
  const row = await backend.get(countSql, TENANT_ID);
  if ((row?.c || 0) > 0) return;

  if (existsSync(AGENTS_JSON)) {
    const agents = JSON.parse(readFileSync(AGENTS_JSON, 'utf8')).agents || [];
    const ins = sql({
      sqlite: 'INSERT OR IGNORE INTO agents (id, role, created_at, tenant_id) VALUES (?, ?, ?, ?)',
      postgres: 'INSERT INTO agents (id, role, created_at, tenant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING'
    });
    for (const a of agents) await backend.run(ins, a.id, a.role || 'agent', now(), TENANT_ID);
  }

  if (existsSync(TASKS_JSON)) {
    const tasks = JSON.parse(readFileSync(TASKS_JSON, 'utf8')).tasks || [];
    const insTask = sql({
      sqlite: 'INSERT OR IGNORE INTO tasks (id, title, status, priority, owner, created_at, updated_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING'
    });
    const insNote = sql({
      sqlite: 'INSERT INTO task_notes (task_id, note, created_at, actor, tenant_id) VALUES (?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_notes (task_id, note, created_at, actor, tenant_id) VALUES ($1, $2, $3, $4, $5)'
    });
    for (const t of tasks) {
      await backend.run(insTask, t.id, t.title, t.status, t.priority || 'p2', t.owner || 'ultron', t.createdAt || now(), t.updatedAt || now(), TENANT_ID);
      for (const n of (t.notes || [])) await backend.run(insNote, t.id, n.note || '', n.at || now(), 'import', TENANT_ID);
    }
  }

  if (existsSync(ACTIVITY_JSON)) {
    const events = JSON.parse(readFileSync(ACTIVITY_JSON, 'utf8')).events || [];
    const insEvent = sql({
      sqlite: 'INSERT INTO task_events (task_id, type, message, actor, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_events (task_id, type, message, actor, created_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6)'
    });
    for (const e of events) await backend.run(insEvent, e.taskId || null, e.type || 'event', e.message || '', e.actor || 'import', e.at || now(), TENANT_ID);
  }
}

export async function listTasks() {
  const tasks = await backend.all(sql({ sqlite: 'SELECT * FROM tasks WHERE tenant_id = ? ORDER BY updated_at DESC', postgres: 'SELECT * FROM tasks WHERE tenant_id = $1 ORDER BY updated_at DESC' }), TENANT_ID);
  const notesSql = sql({
    sqlite: 'SELECT task_id, note, created_at FROM task_notes WHERE tenant_id = ? ORDER BY id DESC LIMIT 5000',
    postgres: 'SELECT task_id, note, created_at FROM task_notes WHERE tenant_id = $1 ORDER BY id DESC LIMIT 5000'
  });
  const notesRows = await backend.all(notesSql, TENANT_ID);
  const notesByTask = new Map();
  for (const n of notesRows) {
    const taskId = n.task_id;
    if (!notesByTask.has(taskId)) notesByTask.set(taskId, []);
    const bucket = notesByTask.get(taskId);
    if (bucket.length < 50) bucket.push({ note: n.note, at: n.created_at });
  }

  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    owner: t.owner,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    notes: notesByTask.get(t.id) || []
  }));
}

export async function listTasksBoard() {
  const tasks = await backend.all(
    sql({
      sqlite: `SELECT id, title, status, priority, owner, created_at, updated_at,
                      CASE WHEN EXISTS(
                        SELECT 1 FROM task_start_acks a
                        WHERE a.tenant_id = tasks.tenant_id AND a.task_id = tasks.id AND a.agent_id = tasks.owner
                      ) THEN 1 ELSE 0 END as has_start_ack
               FROM tasks
               WHERE tenant_id = ? AND status IN ('inbox','assigned','starting','in_progress','review','done')
               ORDER BY updated_at DESC`,
      postgres: `SELECT id, title, status, priority, owner, created_at, updated_at,
                        CASE WHEN EXISTS(
                          SELECT 1 FROM task_start_acks a
                          WHERE a.tenant_id = tasks.tenant_id AND a.task_id = tasks.id AND a.agent_id = tasks.owner
                        ) THEN 1 ELSE 0 END as has_start_ack
                 FROM tasks
                 WHERE tenant_id = $1 AND status IN ('inbox','assigned','starting','in_progress','review','done')
                 ORDER BY updated_at DESC`
    }),
    TENANT_ID
  );

  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    owner: t.owner,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    hasStartAck: Boolean(t.has_start_ack),
    notes: []
  }));
}

export async function listEvents(limit = 300) {
  const q = sql({
    sqlite: 'SELECT task_id as taskId, type, message, actor, created_at as at FROM task_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?',
    postgres: 'SELECT task_id as "taskId", type, message, actor, created_at as at FROM task_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2'
  });
  return backend.all(q, TENANT_ID, limit);
}

export async function createTask(task) {
  const ts = task.updatedAt || task.createdAt || now();
  if (await hasLastActivityColumn()) {
    const q = sql({
      sqlite: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at, last_activity_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at, last_activity_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)'
    });
    await backend.run(q, task.id, task.title, task.status, task.priority, task.owner, task.createdAt, ts, ts, TENANT_ID);
    return;
  }

  const q = sql({
    sqlite: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    postgres: 'INSERT INTO tasks (id, title, status, priority, owner, created_at, updated_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)'
  });
  await backend.run(q, task.id, task.title, task.status, task.priority, task.owner, task.createdAt, ts, TENANT_ID);
}

export async function updateTask(patch) {
  const sel = sql({ sqlite: 'SELECT * FROM tasks WHERE id = ? AND tenant_id = ?', postgres: 'SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2' });
  const t = await backend.get(sel, patch.id, TENANT_ID);
  if (!t) return null;
  const status = patch.status || t.status;
  const owner = patch.owner || t.owner;
  const priority = patch.priority || t.priority;
  const updatedAt = now();

  if (await hasLastActivityColumn()) {
    const upd = sql({
      sqlite: 'UPDATE tasks SET status=?, owner=?, priority=?, updated_at=?, last_activity_at=? WHERE id=? AND tenant_id = ?',
      postgres: 'UPDATE tasks SET status=$1, owner=$2, priority=$3, updated_at=$4, last_activity_at=$5 WHERE id=$6 AND tenant_id = $7'
    });
    await backend.run(upd, status, owner, priority, updatedAt, updatedAt, patch.id, TENANT_ID);
  } else {
    const upd = sql({
      sqlite: 'UPDATE tasks SET status=?, owner=?, priority=?, updated_at=? WHERE id=? AND tenant_id = ?',
      postgres: 'UPDATE tasks SET status=$1, owner=$2, priority=$3, updated_at=$4 WHERE id=$5 AND tenant_id = $6'
    });
    await backend.run(upd, status, owner, priority, updatedAt, patch.id, TENANT_ID);
  }

  if (status === 'done') {
    const doneQ = sql({
      sqlite: 'UPDATE task_assignments SET completed_at = COALESCE(completed_at, ?) WHERE task_id = ?',
      postgres: 'UPDATE task_assignments SET completed_at = COALESCE(completed_at, $1) WHERE task_id = $2'
    });
    await backend.run(doneQ, updatedAt, patch.id);
  }

  return { ...t, status, owner, priority, updated_at: updatedAt };
}

export async function updateTaskTitle(id, title) {
  const sel = sql({ sqlite: 'SELECT * FROM tasks WHERE id = ? AND tenant_id = ?', postgres: 'SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2' });
  const t = await backend.get(sel, id, TENANT_ID);
  if (!t) return null;
  const updatedAt = now();

  if (await hasLastActivityColumn()) {
    const upd = sql({
      sqlite: 'UPDATE tasks SET title=?, updated_at=?, last_activity_at=? WHERE id=? AND tenant_id = ?',
      postgres: 'UPDATE tasks SET title=$1, updated_at=$2, last_activity_at=$3 WHERE id=$4 AND tenant_id = $5'
    });
    await backend.run(upd, String(title || ''), updatedAt, updatedAt, id, TENANT_ID);
  } else {
    const upd = sql({
      sqlite: 'UPDATE tasks SET title=?, updated_at=? WHERE id=? AND tenant_id = ?',
      postgres: 'UPDATE tasks SET title=$1, updated_at=$2 WHERE id=$3 AND tenant_id = $4'
    });
    await backend.run(upd, String(title || ''), updatedAt, id, TENANT_ID);
  }

  return { ...t, title: String(title || ''), updated_at: updatedAt };
}

export async function deleteTask(id) {
  const sel = sql({ sqlite: 'SELECT * FROM tasks WHERE id=? AND tenant_id = ?', postgres: 'SELECT * FROM tasks WHERE id=$1 AND tenant_id = $2' });
  const t = await backend.get(sel, id, TENANT_ID);
  if (!t) return null;

  await backend.run(sql({ sqlite: 'DELETE FROM tasks WHERE id=?', postgres: 'DELETE FROM tasks WHERE id=$1' }), id);
  await backend.run(sql({ sqlite: 'DELETE FROM task_notes WHERE task_id=?', postgres: 'DELETE FROM task_notes WHERE task_id=$1' }), id);
  await backend.run(sql({ sqlite: 'DELETE FROM task_assignments WHERE task_id=?', postgres: 'DELETE FROM task_assignments WHERE task_id=$1' }), id);
  return t;
}

export async function getTaskById(id) {
  return backend.get(
    sql({
      sqlite: 'SELECT id, status, owner, priority, updated_at FROM tasks WHERE id = ? AND tenant_id = ?',
      postgres: 'SELECT id, status, owner, priority, updated_at FROM tasks WHERE id = $1 AND tenant_id = $2'
    }),
    id,
    TENANT_ID
  );
}

export async function getPr1InboxInvariantCount() {
  const query = "SELECT COUNT(*) AS invalid_inbox_rows FROM tasks WHERE tenant_id = ? AND status = 'inbox' AND owner <> 'ops'";
  const count = Number(
    await backend.scalar(
      sql({
        sqlite: query,
        postgres: "SELECT COUNT(*)::int AS invalid_inbox_rows FROM tasks WHERE tenant_id = $1 AND status = 'inbox' AND owner <> 'ops'"
      }),
      TENANT_ID
    )
  ) || 0;

  let invariantApplied = false;
  if (backend.mode === 'postgres') {
    const row = await backend.get("SELECT conname FROM pg_constraint WHERE conname = 'tasks_inbox_owner_must_be_ops_chk' LIMIT 1");
    invariantApplied = !!row;
  } else {
    const row = await backend.get("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_tasks_inbox_owner_ops_update' LIMIT 1");
    invariantApplied = !!row;
  }

  return {
    invalidInboxRows: count,
    query,
    tenantId: TENANT_ID,
    invariantApplied
  };
}

export async function countTasksByStatus(status, excludeId = null) {
  if (excludeId) {
    return Number(
      await backend.scalar(
        sql({
          sqlite: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND status = ? AND id <> ?',
          postgres: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = $1 AND status = $2 AND id <> $3'
        }),
        TENANT_ID,
        status,
        excludeId
      )
    ) || 0;
  }
  return Number(
    await backend.scalar(
      sql({
        sqlite: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND status = ?',
        postgres: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = $1 AND status = $2'
      }),
      TENANT_ID,
      status
    )
  ) || 0;
}

export async function countTasksByOwnerAndStatus(owner, status, excludeId = null) {
  if (excludeId) {
    return Number(
      await backend.scalar(
        sql({
          sqlite: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND owner = ? AND status = ? AND id <> ?',
          postgres: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = $1 AND owner = $2 AND status = $3 AND id <> $4'
        }),
        TENANT_ID,
        owner,
        status,
        excludeId
      )
    ) || 0;
  }
  return Number(
    await backend.scalar(
      sql({
        sqlite: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND owner = ? AND status = ?',
        postgres: 'SELECT COUNT(*) FROM tasks WHERE tenant_id = $1 AND owner = $2 AND status = $3'
      }),
      TENANT_ID,
      owner,
      status
    )
  ) || 0;
}

export async function addNote(taskId, note, actor) {
  await backend.run(
    sql({
      sqlite: 'INSERT INTO task_notes (task_id, note, created_at, actor, tenant_id) VALUES (?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_notes (task_id, note, created_at, actor, tenant_id) VALUES ($1, $2, $3, $4, $5)'
    }),
    taskId,
    note,
    now(),
    actor,
    TENANT_ID
  );
  const ts = now();
  if (await hasLastActivityColumn()) {
    await backend.run(
      sql({
        sqlite: 'UPDATE tasks SET updated_at=?, last_activity_at=? WHERE id=? AND tenant_id = ?',
        postgres: 'UPDATE tasks SET updated_at=$1, last_activity_at=$2 WHERE id=$3 AND tenant_id = $4'
      }),
      ts,
      ts,
      taskId,
      TENANT_ID
    );
  } else {
    await backend.run(
      sql({ sqlite: 'UPDATE tasks SET updated_at=? WHERE id=? AND tenant_id = ?', postgres: 'UPDATE tasks SET updated_at=$1 WHERE id=$2 AND tenant_id = $3' }),
      ts,
      taskId,
      TENANT_ID
    );
  }
}

export async function addEvent({ taskId = null, type, message, actor = 'system' }) {
  await backend.run(
    sql({
      sqlite: 'INSERT INTO task_events (task_id, type, message, actor, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_events (task_id, type, message, actor, created_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6)'
    }),
    taskId,
    type,
    message,
    actor,
    now(),
    TENANT_ID
  );
}

export async function assignTask(taskId, agentId) {
  const ts = now();
  await backend.run(
    sql({
      sqlite: 'INSERT OR IGNORE INTO task_assignments (task_id, agent_id, assigned_at, tenant_id) VALUES (?, ?, ?, ?)',
      postgres: 'INSERT INTO task_assignments (task_id, agent_id, assigned_at, tenant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (task_id, agent_id) DO NOTHING'
    }),
    taskId,
    agentId,
    ts,
    TENANT_ID
  );

  if (await hasLastActivityColumn()) {
    await backend.run(
      sql({
        sqlite: 'UPDATE tasks SET updated_at=?, last_activity_at=? WHERE id=? AND tenant_id = ?',
        postgres: 'UPDATE tasks SET updated_at=$1, last_activity_at=$2 WHERE id=$3 AND tenant_id = $4'
      }),
      ts,
      ts,
      taskId,
      TENANT_ID
    );
  }
}

export async function isTaskAssignedToAgent(taskId, agentId) {
  const row = await backend.get(
    sql({
      sqlite: 'SELECT 1 as ok FROM task_assignments WHERE tenant_id = ? AND task_id = ? AND agent_id = ? AND completed_at IS NULL LIMIT 1',
      postgres: 'SELECT 1 as ok FROM task_assignments WHERE tenant_id = $1 AND task_id = $2 AND agent_id = $3 AND completed_at IS NULL LIMIT 1'
    }),
    TENANT_ID,
    taskId,
    agentId
  );
  return !!row;
}

export async function hasWorkerStartAck(taskId, agentId) {
  const row = await backend.get(
    sql({
      sqlite: 'SELECT 1 as ok FROM task_start_acks WHERE tenant_id = ? AND task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1',
      postgres: 'SELECT 1 as ok FROM task_start_acks WHERE tenant_id = $1 AND task_id = $2 AND agent_id = $3 ORDER BY id DESC LIMIT 1'
    }),
    TENANT_ID,
    taskId,
    agentId
  );
  return !!row;
}

export async function recordTaskStartAck({ taskId, agentId, startedAt, pidOrSession = null, heartbeatAt = null, noteAt = null }) {
  await backend.run(
    sql({
      sqlite: 'INSERT OR IGNORE INTO task_start_acks (task_id, agent_id, started_at, pid_or_session, heartbeat_at, note_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_start_acks (task_id, agent_id, started_at, pid_or_session, heartbeat_at, note_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (task_id, agent_id, started_at) DO NOTHING'
    }),
    taskId,
    agentId,
    startedAt,
    pidOrSession,
    heartbeatAt,
    noteAt,
    TENANT_ID
  );

  const row = await backend.get(
    sql({
      sqlite: 'SELECT task_id as taskId, agent_id as agentId, started_at as startedAt, pid_or_session as pidOrSession, heartbeat_at as heartbeatAt, note_at as noteAt FROM task_start_acks WHERE tenant_id = ? AND task_id = ? AND agent_id = ? AND started_at = ? LIMIT 1',
      postgres: 'SELECT task_id as "taskId", agent_id as "agentId", started_at as "startedAt", pid_or_session as "pidOrSession", heartbeat_at as "heartbeatAt", note_at as "noteAt" FROM task_start_acks WHERE tenant_id = $1 AND task_id = $2 AND agent_id = $3 AND started_at = $4 LIMIT 1'
    }),
    TENANT_ID,
    taskId,
    agentId,
    startedAt
  );
  return row;
}

export async function agentInbox(agentId) {
  const q = sql({
    sqlite: `
      SELECT t.*, a.assigned_at, a.seen_at, a.claimed_at
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.tenant_id = ? AND t.tenant_id = ? AND a.agent_id = ? AND a.completed_at IS NULL
      ORDER BY a.claimed_at IS NOT NULL, t.updated_at DESC
    `,
    postgres: `
      SELECT t.*, a.assigned_at, a.seen_at, a.claimed_at
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.tenant_id = $1 AND t.tenant_id = $1 AND a.agent_id = $2 AND a.completed_at IS NULL
      ORDER BY CASE WHEN a.claimed_at IS NOT NULL THEN 1 ELSE 0 END, t.updated_at DESC
    `
  });

  const rows = backend.mode === 'postgres'
    ? await backend.all(q, TENANT_ID, agentId)
    : await backend.all(q, TENANT_ID, TENANT_ID, agentId);
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
      sqlite: 'UPDATE task_assignments SET seen_at = COALESCE(seen_at, ?) WHERE tenant_id = ? AND agent_id = ? AND completed_at IS NULL',
      postgres: 'UPDATE task_assignments SET seen_at = COALESCE(seen_at, $1) WHERE tenant_id = $2 AND agent_id = $3 AND completed_at IS NULL'
    }),
    now(),
    TENANT_ID,
    agentId
  );
}

export async function claimNext(agentId) {
  const nextQ = sql({
    sqlite: `
      SELECT a.task_id FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.tenant_id = ?
        AND t.tenant_id = ?
        AND a.agent_id = ?
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
      WHERE a.tenant_id = $1
        AND t.tenant_id = $1
        AND a.agent_id = $2
        AND a.completed_at IS NULL
        AND (
          a.claimed_at IS NULL
          OR a.claimed_at::timestamptz < (NOW() - ($3::text || ' minutes')::interval)
        )
      ORDER BY (t.priority='p0') DESC, (t.priority='p1') DESC, a.assigned_at ASC
      LIMIT 1
    `
  });

  const next = backend.mode === 'postgres'
    ? await backend.get(nextQ, TENANT_ID, agentId, CLAIM_TIMEOUT_MINUTES)
    : await backend.get(nextQ, TENANT_ID, TENANT_ID, agentId, CLAIM_TIMEOUT_MINUTES);
  if (!next) return null;

  await backend.run(
    sql({
      sqlite: 'UPDATE task_assignments SET claimed_at = ? WHERE tenant_id = ? AND agent_id=? AND task_id=?',
      postgres: 'UPDATE task_assignments SET claimed_at = $1 WHERE tenant_id = $2 AND agent_id=$3 AND task_id=$4'
    }),
    now(),
    TENANT_ID,
    agentId,
    next.task_id
  );

  return backend.get(
    sql({ sqlite: 'SELECT id, title, status, priority, owner FROM tasks WHERE id=? AND tenant_id = ?', postgres: 'SELECT id, title, status, priority, owner FROM tasks WHERE id=$1 AND tenant_id = $2' }),
    next.task_id,
    TENANT_ID
  );
}

export async function recordHeartbeat(agentId, status, summary = '') {
  await backend.run(
    sql({
      sqlite: 'INSERT INTO heartbeat_runs (agent_id, status, summary, created_at, tenant_id) VALUES (?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO heartbeat_runs (agent_id, status, summary, created_at, tenant_id) VALUES ($1, $2, $3, $4, $5)'
    }),
    agentId,
    status,
    summary,
    now(),
    TENANT_ID
  );
}

export async function createHeartbeatRestartAttempt({ agentId, attemptedAt, reason, result, skipReason = null, cooldownUntil = null, attemptCountWindow = 0, idempotencyKey }) {
  const exists = await backend.get(
    sql({
      sqlite: 'SELECT id FROM heartbeat_restart_attempts WHERE tenant_id = ? AND idempotency_key = ?',
      postgres: 'SELECT id FROM heartbeat_restart_attempts WHERE tenant_id = $1 AND idempotency_key = $2'
    }),
    TENANT_ID,
    idempotencyKey
  );
  if (exists) return { inserted: false };

  await backend.run(
    sql({
      sqlite: 'INSERT INTO heartbeat_restart_attempts (agent_id, attempted_at, reason, result, skip_reason, cooldown_until, attempt_count_window, idempotency_key, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO heartbeat_restart_attempts (agent_id, attempted_at, reason, result, skip_reason, cooldown_until, attempt_count_window, idempotency_key, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)'
    }),
    agentId,
    attemptedAt,
    reason,
    result,
    skipReason,
    cooldownUntil,
    attemptCountWindow,
    idempotencyKey,
    TENANT_ID
  );
  return { inserted: true };
}

export async function listHeartbeatRestartAttempts(agentId, sinceIso = null) {
  if (sinceIso) {
    return backend.all(
      sql({
        sqlite: 'SELECT agent_id as agentId, attempted_at as attemptedAt, reason, result, skip_reason as skipReason, cooldown_until as cooldownUntil, attempt_count_window as attemptCountWindow, idempotency_key as idempotencyKey FROM heartbeat_restart_attempts WHERE tenant_id = ? AND agent_id = ? AND attempted_at >= ? ORDER BY id DESC',
        postgres: 'SELECT agent_id as "agentId", attempted_at as "attemptedAt", reason, result, skip_reason as "skipReason", cooldown_until as "cooldownUntil", attempt_count_window as "attemptCountWindow", idempotency_key as "idempotencyKey" FROM heartbeat_restart_attempts WHERE tenant_id = $1 AND agent_id = $2 AND attempted_at >= $3 ORDER BY id DESC'
      }),
      TENANT_ID,
      agentId,
      sinceIso
    );
  }
  return backend.all(
    sql({
      sqlite: 'SELECT agent_id as agentId, attempted_at as attemptedAt, reason, result, skip_reason as skipReason, cooldown_until as cooldownUntil, attempt_count_window as attemptCountWindow, idempotency_key as idempotencyKey FROM heartbeat_restart_attempts WHERE tenant_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 20',
      postgres: 'SELECT agent_id as "agentId", attempted_at as "attemptedAt", reason, result, skip_reason as "skipReason", cooldown_until as "cooldownUntil", attempt_count_window as "attemptCountWindow", idempotency_key as "idempotencyKey" FROM heartbeat_restart_attempts WHERE tenant_id = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 20'
    }),
    TENANT_ID,
    agentId
  );
}

export async function hasTaskRecoveryAction(idempotencyKey) {
  const row = await backend.get(
    sql({
      sqlite: 'SELECT id FROM task_recovery_actions WHERE tenant_id = ? AND idempotency_key = ?',
      postgres: 'SELECT id FROM task_recovery_actions WHERE tenant_id = $1 AND idempotency_key = $2'
    }),
    TENANT_ID,
    idempotencyKey
  );
  return !!row;
}

export async function createTaskRecoveryAction({ taskId, agentId, result, idempotencyKey }) {
  if (await hasTaskRecoveryAction(idempotencyKey)) return { inserted: false };
  await backend.run(
    sql({
      sqlite: 'INSERT INTO task_recovery_actions (task_id, agent_id, action_at, result, idempotency_key, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO task_recovery_actions (task_id, agent_id, action_at, result, idempotency_key, tenant_id) VALUES ($1, $2, $3, $4, $5, $6)'
    }),
    taskId,
    agentId,
    now(),
    result,
    idempotencyKey,
    TENANT_ID
  );
  return { inserted: true };
}

export async function createStandupRecord({ tenantId = 'default', content, snapshot, runId }) {
  const id = `mcs-${randomUUID().slice(0, 8)}`;
  const generatedAt = now();
  await backend.run(
    sql({
      sqlite: 'INSERT INTO standups (id, tenant_id, generated_at, content_md, snapshot_json, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO standups (id, tenant_id, generated_at, content_md, snapshot_json, run_id) VALUES ($1, $2, $3, $4, $5, $6)'
    }),
    id,
    tenantId,
    generatedAt,
    content,
    JSON.stringify(snapshot || {}),
    runId || generatedAt
  );
  return { id, generatedAt };
}

export async function listTenantAgents(tenantId = TENANT_ID) {
  return backend.all(
    sql({
      sqlite: 'SELECT tenant_id as tenantId, agent_id as agentId, role, enabled, display_name as displayName, capabilities_profile as capabilitiesProfile FROM tenant_agents WHERE tenant_id = ? AND enabled = 1 ORDER BY agent_id ASC',
      postgres: 'SELECT tenant_id as "tenantId", agent_id as "agentId", role, enabled, display_name as "displayName", capabilities_profile as "capabilitiesProfile" FROM tenant_agents WHERE tenant_id = $1 AND enabled = 1 ORDER BY agent_id ASC'
    }),
    tenantId
  );
}

export async function listServicePlans() {
  return backend.all(
    sql({
      sqlite: 'SELECT plan_key as planKey, name, description, monthly_price as monthlyPrice, default_team_template as defaultTeamTemplate, max_teams as maxTeams, max_agents as maxAgents, max_wip as maxWip, max_tasks as maxTasks, features_json as featuresJson, created_at as createdAt FROM service_plans ORDER BY id ASC',
      postgres: 'SELECT plan_key as "planKey", name, description, monthly_price as "monthlyPrice", default_team_template as "defaultTeamTemplate", max_teams as "maxTeams", max_agents as "maxAgents", max_wip as "maxWip", max_tasks as "maxTasks", features_json as "featuresJson", created_at as "createdAt" FROM service_plans ORDER BY id ASC'
    })
  );
}

export async function getServicePlan(planKey) {
  return backend.get(
    sql({
      sqlite: 'SELECT plan_key as planKey, name, description, monthly_price as monthlyPrice, default_team_template as defaultTeamTemplate, max_teams as maxTeams, max_agents as maxAgents, max_wip as maxWip, max_tasks as maxTasks, features_json as featuresJson, created_at as createdAt FROM service_plans WHERE plan_key = ?',
      postgres: 'SELECT plan_key as "planKey", name, description, monthly_price as "monthlyPrice", default_team_template as "defaultTeamTemplate", max_teams as "maxTeams", max_agents as "maxAgents", max_wip as "maxWip", max_tasks as "maxTasks", features_json as "featuresJson", created_at as "createdAt" FROM service_plans WHERE plan_key = $1'
    }),
    planKey
  );
}

export async function setTenantPlan({ tenantId, planKey, subscriptionId = null, status = 'active', activatedAt = null, limits = null }) {
  const limitsJson = JSON.stringify(limits || {});
  if (backend.mode === 'postgres') {
    await backend.run(
      'INSERT INTO tenant_plans (tenant_id, plan_key, subscription_id, status, activated_at, limits_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id) DO UPDATE SET plan_key=EXCLUDED.plan_key, subscription_id=EXCLUDED.subscription_id, status=EXCLUDED.status, activated_at=EXCLUDED.activated_at, limits_json=EXCLUDED.limits_json',
      tenantId,
      planKey,
      subscriptionId,
      status,
      activatedAt,
      limitsJson,
      now()
    );
  } else {
    await backend.run('INSERT OR REPLACE INTO tenant_plans (tenant_id, plan_key, subscription_id, status, activated_at, limits_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', tenantId, planKey, subscriptionId, status, activatedAt, limitsJson, now());
  }
}

export async function getTenantPlan(tenantId = TENANT_ID) {
  return backend.get(
    sql({
      sqlite: 'SELECT tenant_id as tenantId, plan_key as planKey, subscription_id as subscriptionId, status, activated_at as activatedAt, limits_json as limitsJson, created_at as createdAt FROM tenant_plans WHERE tenant_id = ?',
      postgres: 'SELECT tenant_id as "tenantId", plan_key as "planKey", subscription_id as "subscriptionId", status, activated_at as "activatedAt", limits_json as "limitsJson", created_at as "createdAt" FROM tenant_plans WHERE tenant_id = $1'
    }),
    tenantId
  );
}

export async function upsertSubscription({ tenantId, planKey, status = 'trial', billingProvider = 'manual', providerCustomerId = null, providerSubscriptionId = null, currentPeriodStart = null, currentPeriodEnd = null }) {
  const id = `sub-${randomUUID().slice(0, 8)}`;
  const ts = now();
  const existing = await getSubscriptionByTenant(tenantId);

  if (existing) {
    await backend.run(
      sql({
        sqlite: 'UPDATE subscriptions SET plan_key = ?, billing_provider = ?, provider_customer_id = COALESCE(?, provider_customer_id), provider_subscription_id = COALESCE(?, provider_subscription_id), status = ?, current_period_start = COALESCE(?, current_period_start), current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE tenant_id = ?',
        postgres: 'UPDATE subscriptions SET plan_key = $1, billing_provider = $2, provider_customer_id = COALESCE($3, provider_customer_id), provider_subscription_id = COALESCE($4, provider_subscription_id), status = $5, current_period_start = COALESCE($6, current_period_start), current_period_end = COALESCE($7, current_period_end), updated_at = $8 WHERE tenant_id = $9'
      }),
      planKey,
      billingProvider,
      providerCustomerId,
      providerSubscriptionId,
      status,
      currentPeriodStart,
      currentPeriodEnd,
      ts,
      tenantId
    );
    return getSubscriptionByTenant(tenantId);
  }

  await backend.run(
    sql({
      sqlite: 'INSERT INTO subscriptions (id, tenant_id, plan_key, billing_provider, provider_customer_id, provider_subscription_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO subscriptions (id, tenant_id, plan_key, billing_provider, provider_customer_id, provider_subscription_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
    }),
    id,
    tenantId,
    planKey,
    billingProvider,
    providerCustomerId,
    providerSubscriptionId,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    ts,
    ts
  );
  return getSubscriptionByTenant(tenantId);
}

export async function getSubscriptionByTenant(tenantId) {
  return backend.get(
    sql({
      sqlite: 'SELECT id, tenant_id as tenantId, plan_key as planKey, billing_provider as billingProvider, provider_customer_id as providerCustomerId, provider_subscription_id as providerSubscriptionId, status, current_period_start as currentPeriodStart, current_period_end as currentPeriodEnd, created_at as createdAt, updated_at as updatedAt FROM subscriptions WHERE tenant_id = ?',
      postgres: 'SELECT id, tenant_id as "tenantId", plan_key as "planKey", billing_provider as "billingProvider", provider_customer_id as "providerCustomerId", provider_subscription_id as "providerSubscriptionId", status, current_period_start as "currentPeriodStart", current_period_end as "currentPeriodEnd", created_at as "createdAt", updated_at as "updatedAt" FROM subscriptions WHERE tenant_id = $1'
    }),
    tenantId
  );
}

export async function updateSubscriptionStatus({ tenantId, status, currentPeriodStart = null, currentPeriodEnd = null }) {
  const ts = now();
  await backend.run(
    sql({
      sqlite: 'UPDATE subscriptions SET status = ?, current_period_start = COALESCE(?, current_period_start), current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE tenant_id = ?',
      postgres: 'UPDATE subscriptions SET status = $1, current_period_start = COALESCE($2, current_period_start), current_period_end = COALESCE($3, current_period_end), updated_at = $4 WHERE tenant_id = $5'
    }),
    status,
    currentPeriodStart,
    currentPeriodEnd,
    ts,
    tenantId
  );
  return getSubscriptionByTenant(tenantId);
}

export async function addTenantUser({ tenantId, userId, email = null, role = 'tenant_admin' }) {
  if (backend.mode === 'postgres') {
    await backend.run(
      'INSERT INTO tenant_users (tenant_id, user_id, email, role, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, user_id) DO NOTHING',
      tenantId,
      userId,
      email,
      role,
      now()
    );
  } else {
    await backend.run(
      'INSERT OR IGNORE INTO tenant_users (tenant_id, user_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)',
      tenantId,
      userId,
      email,
      role,
      now()
    );
  }
}

export async function listTenantUsers(tenantId) {
  return backend.all(
    sql({
      sqlite: 'SELECT tenant_id as tenantId, user_id as userId, email, role, created_at as createdAt FROM tenant_users WHERE tenant_id = ? ORDER BY created_at ASC',
      postgres: 'SELECT tenant_id as "tenantId", user_id as "userId", email, role, created_at as "createdAt" FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at ASC'
    }),
    tenantId
  );
}

export async function addTenantAgent({ tenantId, agentId, role = 'agent', enabled = 1, displayName = null, capabilitiesProfile = null }) {
  if (backend.mode === 'postgres') {
    await backend.run(
      'INSERT INTO tenant_agents (tenant_id, agent_id, role, enabled, display_name, capabilities_profile, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, agent_id) DO NOTHING',
      tenantId,
      agentId,
      role,
      enabled,
      displayName,
      capabilitiesProfile,
      now()
    );
  } else {
    await backend.run(
      'INSERT OR IGNORE INTO tenant_agents (tenant_id, agent_id, role, enabled, display_name, capabilities_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      tenantId,
      agentId,
      role,
      enabled,
      displayName,
      capabilitiesProfile,
      now()
    );
  }
}

export async function getTeamTemplate(name = 'general_team') {
  return backend.get(
    sql({
      sqlite: 'SELECT name, plan_key as planKey, template_json as templateJson, created_at as createdAt FROM team_templates WHERE name = ?',
      postgres: 'SELECT name, plan_key as "planKey", template_json as "templateJson", created_at as "createdAt" FROM team_templates WHERE name = $1'
    }),
    name
  );
}

export async function listTeamTemplates() {
  return backend.all(
    sql({
      sqlite: 'SELECT name, plan_key as planKey, template_json as templateJson, created_at as createdAt FROM team_templates ORDER BY name ASC',
      postgres: 'SELECT name, plan_key as "planKey", template_json as "templateJson", created_at as "createdAt" FROM team_templates ORDER BY name ASC'
    })
  );
}

export async function upsertTenantTeam({ tenantId, teamKey, status = 'active' }) {
  const ts = now();
  if (backend.mode === 'postgres') {
    await backend.run(
      'INSERT INTO tenant_teams (tenant_id, team_key, status, activated_at, deactivated_at, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, team_key) DO UPDATE SET status=EXCLUDED.status, activated_at=COALESCE(EXCLUDED.activated_at, tenant_teams.activated_at), deactivated_at=EXCLUDED.deactivated_at',
      tenantId,
      teamKey,
      status,
      status === 'active' ? ts : null,
      status === 'inactive' ? ts : null,
      ts
    );
  } else {
    await backend.run('INSERT OR REPLACE INTO tenant_teams (tenant_id, team_key, status, activated_at, deactivated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', tenantId, teamKey, status, status === 'active' ? ts : null, status === 'inactive' ? ts : null, ts);
  }
}

export async function listTenantTeams(tenantId) {
  return backend.all(
    sql({
      sqlite: 'SELECT tenant_id as tenantId, team_key as teamKey, status, activated_at as activatedAt, deactivated_at as deactivatedAt, created_at as createdAt FROM tenant_teams WHERE tenant_id = ? ORDER BY team_key ASC',
      postgres: 'SELECT tenant_id as "tenantId", team_key as "teamKey", status, activated_at as "activatedAt", deactivated_at as "deactivatedAt", created_at as "createdAt" FROM tenant_teams WHERE tenant_id = $1 ORDER BY team_key ASC'
    }),
    tenantId
  );
}

export async function countActiveTenantTeams(tenantId) {
  return Number(await backend.scalar(
    sql({
      sqlite: 'SELECT COUNT(*) FROM tenant_teams WHERE tenant_id = ? AND status = ? ',
      postgres: 'SELECT COUNT(*) FROM tenant_teams WHERE tenant_id = $1 AND status = $2'
    }),
    tenantId,
    'active'
  )) || 0;
}

export async function setTenantAgentEnabled({ tenantId, agentId, enabled = 1 }) {
  await backend.run(
    sql({
      sqlite: 'UPDATE tenant_agents SET enabled = ? WHERE tenant_id = ? AND agent_id = ?',
      postgres: 'UPDATE tenant_agents SET enabled = $1 WHERE tenant_id = $2 AND agent_id = $3'
    }),
    enabled,
    tenantId,
    agentId
  );
}

export async function createOnboardingRecord({ tenantId, requestedPlan = 'starter', requestedTeamType = 'general_team', createdBy = 'system', notes = '' }) {
  const id = `onb-${randomUUID().slice(0, 8)}`;
  const createdAt = now();
  await backend.run(
    sql({
      sqlite: 'INSERT INTO tenant_onboarding (id, tenant_id, status, requested_plan, requested_team_type, created_at, created_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO tenant_onboarding (id, tenant_id, status, requested_plan, requested_team_type, created_at, created_by, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)'
    }),
    id,
    tenantId,
    'requested',
    requestedPlan,
    requestedTeamType,
    createdAt,
    createdBy,
    notes
  );
  return { id, createdAt };
}

export async function getOnboardingRecord(id) {
  return backend.get(
    sql({
      sqlite: 'SELECT id, tenant_id as tenantId, status, requested_plan as requestedPlan, requested_team_type as requestedTeamType, created_at as createdAt, activated_at as activatedAt, created_by as createdBy, notes, last_validation_json as lastValidationJson FROM tenant_onboarding WHERE id = ?',
      postgres: 'SELECT id, tenant_id as "tenantId", status, requested_plan as "requestedPlan", requested_team_type as "requestedTeamType", created_at as "createdAt", activated_at as "activatedAt", created_by as "createdBy", notes, last_validation_json as "lastValidationJson" FROM tenant_onboarding WHERE id = $1'
    }),
    id
  );
}

export async function updateOnboardingStatus({ id, status, notes = null, activatedAt = null, validation = null }) {
  await backend.run(
    sql({
      sqlite: 'UPDATE tenant_onboarding SET status = ?, notes = COALESCE(?, notes), activated_at = COALESCE(?, activated_at), last_validation_json = COALESCE(?, last_validation_json) WHERE id = ?',
      postgres: 'UPDATE tenant_onboarding SET status = $1, notes = COALESCE($2, notes), activated_at = COALESCE($3, activated_at), last_validation_json = COALESCE($4, last_validation_json) WHERE id = $5'
    }),
    status,
    notes,
    activatedAt,
    validation ? JSON.stringify(validation) : null,
    id
  );
}

export async function recordUsageEvent({ tenantId = TENANT_ID, teamKey = null, agentId = null, eventType, taskId = null, tokensUsed = 0, computeMs = 0 }) {
  const ts = now();
  const day = ts.slice(0, 10);
  await backend.run(
    sql({
      sqlite: 'INSERT INTO usage_events (tenant_id, team_key, agent_id, event_type, task_id, tokens_used, compute_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO usage_events (tenant_id, team_key, agent_id, event_type, task_id, tokens_used, compute_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)'
    }),
    tenantId,
    teamKey,
    agentId,
    eventType,
    taskId,
    Number(tokensUsed || 0),
    Number(computeMs || 0),
    ts
  );

  const tasksCompletedInc = eventType === 'task_completed' ? 1 : 0;
  const agentActionsInc = 1;
  if (backend.mode === 'postgres') {
    await backend.run(
      `INSERT INTO usage_rollups_daily (tenant_id, day, tasks_completed, agent_actions, tokens_used, compute_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, day) DO UPDATE SET
         tasks_completed = usage_rollups_daily.tasks_completed + EXCLUDED.tasks_completed,
         agent_actions = usage_rollups_daily.agent_actions + EXCLUDED.agent_actions,
         tokens_used = usage_rollups_daily.tokens_used + EXCLUDED.tokens_used,
         compute_ms = usage_rollups_daily.compute_ms + EXCLUDED.compute_ms`,
      tenantId,
      day,
      tasksCompletedInc,
      agentActionsInc,
      Number(tokensUsed || 0),
      Number(computeMs || 0),
      ts
    );
  } else {
    await backend.run(
      `INSERT INTO usage_rollups_daily (tenant_id, day, tasks_completed, agent_actions, tokens_used, compute_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, day) DO UPDATE SET
         tasks_completed = tasks_completed + excluded.tasks_completed,
         agent_actions = agent_actions + excluded.agent_actions,
         tokens_used = tokens_used + excluded.tokens_used,
         compute_ms = compute_ms + excluded.compute_ms`,
      tenantId,
      day,
      tasksCompletedInc,
      agentActionsInc,
      Number(tokensUsed || 0),
      Number(computeMs || 0),
      ts
    );
  }
}

export async function getUsageSummary({ tenantId = TENANT_ID, period = '24h' }) {
  const nowTs = Date.now();
  const sinceMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const sinceIso = new Date(nowTs - sinceMs).toISOString();

  const summary = await backend.get(
    sql({
      sqlite: `SELECT
        SUM(CASE WHEN event_type = 'task_completed' THEN 1 ELSE 0 END) as tasks_completed,
        COUNT(*) as agent_actions,
        COALESCE(SUM(tokens_used),0) as tokens_used,
        COALESCE(SUM(compute_ms),0) as compute_ms
      FROM usage_events
      WHERE tenant_id = ? AND created_at >= ?`,
      postgres: `SELECT
        COALESCE(SUM(CASE WHEN event_type = 'task_completed' THEN 1 ELSE 0 END),0)::int as tasks_completed,
        COUNT(*)::int as agent_actions,
        COALESCE(SUM(tokens_used),0)::int as tokens_used,
        COALESCE(SUM(compute_ms),0)::int as compute_ms
      FROM usage_events
      WHERE tenant_id = $1 AND created_at >= $2`
    }),
    tenantId,
    sinceIso
  );

  return {
    tenant: tenantId,
    period,
    tasks_completed: Number(summary?.tasks_completed || 0),
    agent_actions: Number(summary?.agent_actions || 0),
    tokens_used: Number(summary?.tokens_used || 0),
    compute_ms: Number(summary?.compute_ms || 0)
  };
}

export async function getBoardHealthAggregates(tenantId = TENANT_ID) {
  const nowTs = Date.now();
  const since24h = new Date(nowTs - 24 * 60 * 60 * 1000).toISOString();
  const assignedCutoff = new Date(nowTs - 24 * 60 * 60 * 1000).toISOString();
  const inProgressCutoff = new Date(nowTs - 8 * 60 * 60 * 1000).toISOString();
  const reviewCutoff = new Date(nowTs - 12 * 60 * 60 * 1000).toISOString();
  const startingCutoff = new Date(nowTs - 3 * 60 * 1000).toISOString();

  const [statusRows, ownerRows, summary, teamRows, startingRows] = await Promise.all([
    backend.all(
      sql({
        sqlite: 'SELECT status, COUNT(*) as count FROM tasks WHERE tenant_id = ? GROUP BY status',
        postgres: 'SELECT status, COUNT(*)::int as count FROM tasks WHERE tenant_id = $1 GROUP BY status'
      }),
      tenantId
    ),
    backend.all(
      sql({
        sqlite: 'SELECT owner, COUNT(*) as count FROM tasks WHERE tenant_id = ? GROUP BY owner',
        postgres: 'SELECT owner, COUNT(*)::int as count FROM tasks WHERE tenant_id = $1 GROUP BY owner'
      }),
      tenantId
    ),
    backend.get(
      sql({
        sqlite: `SELECT
          SUM(CASE WHEN status NOT IN ('done','archived') THEN 1 ELSE 0 END) as open_total,
          SUM(CASE WHEN status = 'starting' THEN 1 ELSE 0 END) as starting_total,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_total,
          SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review_total,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked_total,
          SUM(CASE WHEN status = 'inbox' AND owner != 'ops' THEN 1 ELSE 0 END) as inbox_owner_violations,
          SUM(CASE WHEN owner = 'ultron' AND status IN ('assigned','in_progress') THEN 1 ELSE 0 END) as ultron_execution_violations,
          SUM(CASE WHEN status = 'assigned' AND datetime(COALESCE(last_activity_at, updated_at, created_at)) < datetime(?) THEN 1 ELSE 0 END) as assigned_gt_24h,
          SUM(CASE WHEN status = 'starting' AND datetime(COALESCE(last_activity_at, updated_at, created_at)) < datetime(?) THEN 1 ELSE 0 END) as starting_gt_3m,
          SUM(CASE WHEN status = 'in_progress' AND datetime(COALESCE(last_activity_at, updated_at, created_at)) < datetime(?) THEN 1 ELSE 0 END) as in_progress_gt_8h,
          SUM(CASE WHEN status = 'review' AND datetime(COALESCE(last_activity_at, updated_at, created_at)) < datetime(?) THEN 1 ELSE 0 END) as review_gt_12h,
          MAX(CASE WHEN status = 'starting' THEN CAST((julianday('now') - julianday(COALESCE(last_activity_at, updated_at, created_at))) * 24 * 60 AS INTEGER) ELSE 0 END) as starting_oldest_age_minutes,
          SUM(CASE WHEN status = 'done' AND datetime(COALESCE(updated_at, created_at)) >= datetime(?) THEN 1 ELSE 0 END) as tasks_completed_24h
          FROM tasks WHERE tenant_id = ?`,
        postgres: `SELECT
          COALESCE(SUM(CASE WHEN status NOT IN ('done','archived') THEN 1 ELSE 0 END),0)::int as open_total,
          COALESCE(SUM(CASE WHEN status = 'starting' THEN 1 ELSE 0 END),0)::int as starting_total,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END),0)::int as in_progress_total,
          COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END),0)::int as review_total,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END),0)::int as blocked_total,
          COALESCE(SUM(CASE WHEN status = 'inbox' AND owner != 'ops' THEN 1 ELSE 0 END),0)::int as inbox_owner_violations,
          COALESCE(SUM(CASE WHEN owner = 'ultron' AND status IN ('assigned','in_progress') THEN 1 ELSE 0 END),0)::int as ultron_execution_violations,
          COALESCE(SUM(CASE WHEN status = 'assigned' AND COALESCE(NULLIF(last_activity_at::text,'')::timestamptz, NULLIF(updated_at::text,'')::timestamptz, NULLIF(created_at::text,'')::timestamptz) < $1::timestamptz THEN 1 ELSE 0 END),0)::int as assigned_gt_24h,
          COALESCE(SUM(CASE WHEN status = 'starting' AND COALESCE(NULLIF(last_activity_at::text,'')::timestamptz, NULLIF(updated_at::text,'')::timestamptz, NULLIF(created_at::text,'')::timestamptz) < $2::timestamptz THEN 1 ELSE 0 END),0)::int as starting_gt_3m,
          COALESCE(SUM(CASE WHEN status = 'in_progress' AND COALESCE(NULLIF(last_activity_at::text,'')::timestamptz, NULLIF(updated_at::text,'')::timestamptz, NULLIF(created_at::text,'')::timestamptz) < $3::timestamptz THEN 1 ELSE 0 END),0)::int as in_progress_gt_8h,
          COALESCE(SUM(CASE WHEN status = 'review' AND COALESCE(NULLIF(last_activity_at::text,'')::timestamptz, NULLIF(updated_at::text,'')::timestamptz, NULLIF(created_at::text,'')::timestamptz) < $4::timestamptz THEN 1 ELSE 0 END),0)::int as review_gt_12h,
          COALESCE(MAX(CASE WHEN status = 'starting' THEN EXTRACT(EPOCH FROM (NOW() - COALESCE(NULLIF(last_activity_at::text,'')::timestamptz, NULLIF(updated_at::text,'')::timestamptz, NULLIF(created_at::text,'')::timestamptz))) / 60 ELSE 0 END),0)::int as starting_oldest_age_minutes,
          COALESCE(SUM(CASE WHEN status = 'done' AND COALESCE(updated_at::timestamptz, created_at::timestamptz) >= $5::timestamptz THEN 1 ELSE 0 END),0)::int as tasks_completed_24h
          FROM tasks WHERE tenant_id = $6`
      }),
      assignedCutoff,
      startingCutoff,
      inProgressCutoff,
      reviewCutoff,
      since24h,
      tenantId
    ),
    backend.all(
      sql({
        sqlite: `SELECT a.agent_id as agent_id,
          SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN t.status = 'assigned' THEN 1 ELSE 0 END) as assigned,
          SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) as review
          FROM tenant_agents a
          LEFT JOIN tasks t ON t.tenant_id = a.tenant_id AND t.owner = a.agent_id
          WHERE a.tenant_id = ? AND a.enabled = 1
          GROUP BY a.agent_id
          ORDER BY a.agent_id ASC`,
        postgres: `SELECT a.agent_id as agent_id,
          COALESCE(SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END),0)::int as in_progress,
          COALESCE(SUM(CASE WHEN t.status = 'assigned' THEN 1 ELSE 0 END),0)::int as assigned,
          COALESCE(SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END),0)::int as review
          FROM tenant_agents a
          LEFT JOIN tasks t ON t.tenant_id = a.tenant_id AND t.owner = a.agent_id
          WHERE a.tenant_id = $1 AND a.enabled = 1
          GROUP BY a.agent_id
          ORDER BY a.agent_id ASC`
      }),
      tenantId
    ),
    backend.all(
      sql({
        sqlite: `SELECT id FROM tasks WHERE tenant_id = ? AND status = 'starting' ORDER BY updated_at ASC LIMIT 10`,
        postgres: `SELECT id FROM tasks WHERE tenant_id = $1 AND status = 'starting' ORDER BY updated_at ASC LIMIT 10`
      }),
      tenantId
    )
  ]);

  const byStatus = {};
  for (const r of statusRows) byStatus[r.status] = Number(r.count || 0);

  const byOwner = {};
  for (const r of ownerRows) byOwner[r.owner] = Number(r.count || 0);

  const teamWip = {};
  for (const r of teamRows) {
    teamWip[r.agent_id] = {
      in_progress: Number(r.in_progress || 0),
      assigned: Number(r.assigned || 0),
      review: Number(r.review || 0)
    };
  }

  return {
    byStatus,
    byOwner,
    teamWip,
    openTotal: Number(summary?.open_total || 0),
    startingTotal: Number(summary?.starting_total || 0),
    inProgressTotal: Number(summary?.in_progress_total || 0),
    reviewTotal: Number(summary?.review_total || 0),
    blockedTotal: Number(summary?.blocked_total || 0),
    tasksCompleted24h: Number(summary?.tasks_completed_24h || 0),
    inboxOwnerViolations: Number(summary?.inbox_owner_violations || 0),
    ultronExecutionViolations: Number(summary?.ultron_execution_violations || 0),
    staleBins: {
      assigned_gt_24h: Number(summary?.assigned_gt_24h || 0),
      starting_gt_3m: Number(summary?.starting_gt_3m || 0),
      in_progress_gt_8h: Number(summary?.in_progress_gt_8h || 0),
      review_gt_12h: Number(summary?.review_gt_12h || 0)
    },
    startingOldestAgeMinutes: Number(summary?.starting_oldest_age_minutes || 0),
    sampleStartingTaskIds: (startingRows || []).map((r) => r.id)
  };
}

export async function createWeeklyReportRecord({ tenantId = 'default', weekStart, content, snapshot }) {
  const id = `mwr-${randomUUID().slice(0, 8)}`;
  const generatedAt = now();
  await backend.run(
    sql({
      sqlite: 'INSERT INTO weekly_reports (id, tenant_id, week_start, generated_at, content_md, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)',
      postgres: 'INSERT INTO weekly_reports (id, tenant_id, week_start, generated_at, content_md, snapshot_json) VALUES ($1, $2, $3, $4, $5, $6)'
    }),
    id,
    tenantId,
    weekStart,
    generatedAt,
    content,
    JSON.stringify(snapshot || {})
  );
  return { id, generatedAt };
}

export async function getEscalations(limit = 50) {
  const blockedQ = sql({
    sqlite: `
      SELECT id as taskId, title, status, owner, updated_at as updatedAt,
        'blocked_over_24h' as reason
      FROM tasks
      WHERE tenant_id = ? AND status='blocked' AND datetime(updated_at) < datetime('now', '-24 hours')
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    postgres: `
      SELECT id as "taskId", title, status, owner, updated_at as "updatedAt",
        'blocked_over_24h' as reason
      FROM tasks
      WHERE tenant_id = $1 AND status='blocked' AND updated_at::timestamptz < (NOW() - INTERVAL '24 hours')
      ORDER BY updated_at ASC
      LIMIT $2
    `
  });
  const blocked = await backend.all(blockedQ, TENANT_ID, limit);

  const staleQ = sql({
    sqlite: `
      SELECT t.id as taskId, t.title, t.status, t.owner, a.claimed_at as updatedAt,
        'claimed_timeout' as reason
      FROM task_assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.tenant_id = ?
        AND t.tenant_id = ?
        AND a.completed_at IS NULL
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
      WHERE a.tenant_id = $1
        AND t.tenant_id = $1
        AND a.completed_at IS NULL
        AND a.claimed_at IS NOT NULL
        AND a.claimed_at::timestamptz < (NOW() - ($2::text || ' minutes')::interval)
      ORDER BY a.claimed_at ASC
      LIMIT $3
    `
  });
  const staleClaims = backend.mode === 'postgres'
    ? await backend.all(staleQ, TENANT_ID, CLAIM_TIMEOUT_MINUTES, limit)
    : await backend.all(staleQ, TENANT_ID, TENANT_ID, CLAIM_TIMEOUT_MINUTES, limit);

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
      WHERE tenant_id = ?
    `,
    postgres: `
      SELECT
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END), 0)::int as done,
        COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END), 0)::int as blocked,
        COALESCE(SUM(CASE WHEN status!='done' THEN 1 ELSE 0 END), 0)::int as open
      FROM tasks
      WHERE tenant_id = $1
    `
  }), TENANT_ID);

  const assignment = await backend.get(sql({
    sqlite: `
      SELECT
        COUNT(*) as totalAssignments,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as completedAssignments,
        SUM(CASE WHEN seen_at IS NOT NULL THEN 1 ELSE 0 END) as seenAssignments,
        SUM(CASE WHEN claimed_at IS NOT NULL AND completed_at IS NULL THEN 1 ELSE 0 END) as inFlightAssignments
      FROM task_assignments
      WHERE tenant_id = ?
    `,
    postgres: `
      SELECT
        COUNT(*)::int as "totalAssignments",
        COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int as "completedAssignments",
        COALESCE(SUM(CASE WHEN seen_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int as "seenAssignments",
        COALESCE(SUM(CASE WHEN claimed_at IS NOT NULL AND completed_at IS NULL THEN 1 ELSE 0 END), 0)::int as "inFlightAssignments"
      FROM task_assignments
      WHERE tenant_id = $1
    `
  }), TENANT_ID);

  const stale = await backend.get(sql({
    sqlite: `
      SELECT COUNT(*) as staleOpen
      FROM tasks
      WHERE tenant_id = ? AND status != 'done' AND datetime(updated_at) < datetime('now', '-24 hours')
    `,
    postgres: `
      SELECT COUNT(*)::int as "staleOpen"
      FROM tasks
      WHERE tenant_id = $1 AND status != 'done' AND updated_at::timestamptz < (NOW() - INTERVAL '24 hours')
    `
  }), TENANT_ID);

  const heartbeats = await backend.all(sql({
    sqlite: `
      SELECT agent_id as agentId, status, summary, created_at as at
      FROM heartbeat_runs
      WHERE tenant_id = ?
      ORDER BY id DESC
      LIMIT 50
    `,
    postgres: `
      SELECT agent_id as "agentId", status, summary, created_at as at
      FROM heartbeat_runs
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT 50
    `
  }), TENANT_ID);

  const wip = await backend.get(sql({
    sqlite: `
      SELECT
        SUM(CASE WHEN status='in_progress' AND datetime(updated_at) >= datetime('now', '-15 minutes') THEN 1 ELSE 0 END) as wipFresh,
        SUM(CASE WHEN status='in_progress' AND datetime(updated_at) < datetime('now', '-15 minutes') THEN 1 ELSE 0 END) as wipStale,
        SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as wipTotal
      FROM tasks
      WHERE tenant_id = ?
    `,
    postgres: `
      SELECT
        COALESCE(SUM(CASE WHEN status='in_progress' AND updated_at::timestamptz >= (NOW() - INTERVAL '15 minutes') THEN 1 ELSE 0 END),0)::int as "wipFresh",
        COALESCE(SUM(CASE WHEN status='in_progress' AND updated_at::timestamptz < (NOW() - INTERVAL '15 minutes') THEN 1 ELSE 0 END),0)::int as "wipStale",
        COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END),0)::int as "wipTotal"
      FROM tasks
      WHERE tenant_id = $1
    `
  }), TENANT_ID);

  const escalations = await getEscalations(200);
  return {
    tasks: counts,
    assignments: assignment,
    staleOpen: stale.staleOpen || 0,
    wip: {
      fresh15m: Number(wip?.wipFresh || 0),
      stale15m: Number(wip?.wipStale || 0),
      total: Number(wip?.wipTotal || 0)
    },
    escalationCount: escalations.length,
    latestHeartbeats: heartbeats
  };
}

export async function clearAllData() {
  await backend.exec('DELETE FROM task_assignments; DELETE FROM task_notes; DELETE FROM tasks; DELETE FROM task_events;');
}

export const db = { mode: backend.mode };
