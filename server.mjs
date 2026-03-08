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
  listTasksBoard,
  listEvents,
  createTask,
  updateTask,
  deleteTask,
  addNote,
  addEvent,
  assignTask,
  isTaskAssignedToAgent,
  hasWorkerStartAck,
  recordTaskStartAck,
  agentInbox,
  markInboxSeen,
  claimNext,
  recordHeartbeat,
  getMetrics,
  getEscalations,
  clearAllData,
  getTaskById,
  createStandupRecord,
  countTasksByStatus,
  countTasksByOwnerAndStatus,
  createHeartbeatRestartAttempt,
  listHeartbeatRestartAttempts,
  createTaskRecoveryAction,
  hasTaskRecoveryAction,
  createWeeklyReportRecord,
  listTenantAgents,
  addTenantAgent,
  getTeamTemplate,
  listTeamTemplates,
  upsertTenantTeam,
  listTenantTeams,
  countActiveTenantTeams,
  setTenantAgentEnabled,
  createOnboardingRecord,
  getOnboardingRecord,
  updateOnboardingStatus,
  listServicePlans,
  getServicePlan,
  setTenantPlan,
  getTenantPlan,
  upsertSubscription,
  updateSubscriptionStatus,
  getSubscriptionByTenant,
  addTenantUser,
  listTenantUsers,
  recordUsageEvent,
  getUsageSummary,
  getBoardHealthAggregates,
  getPr1InboxInvariantCount
} from './lib/db.mjs';
import { loadPolicies, buildOrchestrationPlan } from './lib/orchestration.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const READ_ONLY = ['1','true','yes','on'].includes(String(process.env.READ_ONLY || '').trim().toLowerCase());
const REVIEW_RUN_DEFAULT_BATCH = Math.max(1, Math.min(Number(process.env.REVIEW_RUN_BATCH_SIZE || 5), 10));
const REVIEW_RUN_CADENCE_CRON = String(process.env.REVIEW_RUN_CRON || '*/5 * * * *');
let reviewRunTelemetry = { run_id: null, mode: null, review_decision_count_last_run: 0, reviewed_count_last_run: 0, generated_at: null, cadence: REVIEW_RUN_CADENCE_CRON, trigger_path: '/api/autopilot/review-run' };

const paths = {
  tasks: join(__dirname, 'runtime', 'tasks.json'),
  agents: join(__dirname, 'config', 'agents.json'),
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
await seedFromJsonIfEmpty();

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

const COMPLETION_PACKAGE_HEADERS = ['Summary', 'What changed', 'Verification steps', 'Artifacts', 'Follow-ups'];

function getMissingCompletionPackageSections(note = '') {
  return COMPLETION_PACKAGE_HEADERS.filter((h) => !new RegExp(`${h}`, 'i').test(note));
}

function hasCompletionPackageSections(note = '') {
  return getMissingCompletionPackageSections(note).length === 0;
}

function inboxAgeMs(task) {
  const ts = new Date(task.lastActivityAt || task.updatedAt || task.createdAt || 0).getTime();
  return Number.isFinite(ts) ? (Date.now() - ts) : 0;
}

function classifyInboxTask(task) {
  const text = `${String(task.title || '').toLowerCase()} ${String(task.id || '').toLowerCase()}`;
  if (/(test|canary|fixture|probe|sandbox|demo|sample|temp|proof|owner test|assign test|pr1-check)/i.test(text)) return 'test/canary';
  if (/(duplicate|\bdup\b)/i.test(text)) return 'duplicate';
  if (/(obsolete|deprecated|superseded|legacy)/i.test(text)) return 'obsolete';
  if (/(unclear|unknown|investigate|tbd|follow-up|follow up)/i.test(text)) return 'unclear';
  return 'legitimate work item';
}

const DEFAULT_TENANT_ID = process.env.MCL_TENANT_ID || 'internal';
const VALID_ROLES = new Set(['tenant_user', 'tenant_admin', 'tenant_ops', 'platform_admin']);

function resolveAccessContext(req, url) {
  const requestedTenant = String(req.headers['x-tenant-id'] || url.searchParams.get('tenant_id') || '').trim();
  const authTenant = String(req.headers['x-auth-tenant-id'] || DEFAULT_TENANT_ID).trim();
  const authRoleRaw = String(req.headers['x-auth-role'] || 'platform_admin').trim();
  const role = VALID_ROLES.has(authRoleRaw) ? authRoleRaw : 'tenant_user';

  if (!authTenant) return { ok: false, error: 'tenant_required' };

  // Tenant-bound sessions cannot be overridden by request params/headers.
  if (requestedTenant && requestedTenant !== authTenant && role !== 'platform_admin') {
    return { ok: false, error: 'tenant_mismatch' };
  }

  const tenantId = requestedTenant && role === 'platform_admin' ? requestedTenant : authTenant;
  if (!tenantId) return { ok: false, error: 'tenant_required' };

  // Customer-facing access currently constrained to internal tenant;
  // platform_admin may target other tenants for controlled onboarding/provisioning.
  if (role !== 'platform_admin' && tenantId !== DEFAULT_TENANT_ID) return { ok: false, error: 'invalid_tenant' };
  if (role === 'platform_admin' && !/^[a-z0-9_-]{2,64}$/i.test(tenantId)) return { ok: false, error: 'invalid_tenant' };

  return { ok: true, tenantId, role, userId: String(req.headers['x-auth-user-id'] || 'internal-user') };
}

function canAccess(role, allowed = []) {
  if (role === 'platform_admin') return true;
  return allowed.includes(role);
}

async function assertTenantLifecycleWriteAllowed(tenantId) {
  const plan = await getTenantPlan(tenantId);
  const sub = await getSubscriptionByTenant(tenantId);
  const status = plan?.status || sub?.status || 'active';
  if (status === 'suspended' || status === 'canceled') {
    return { ok: false, error: 'tenant_lifecycle_blocked', status };
  }
  return { ok: true, status };
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return send(res, 200, '');

  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, service: 'mission-control-lite', time: now() });
    }
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { readOnly: READ_ONLY });

    const tenantScoped = url.pathname.startsWith('/api/');
    let accessCtx = { ok: true, tenantId: DEFAULT_TENANT_ID, role: 'platform_admin', userId: 'internal-user' };
    if (tenantScoped) {
      accessCtx = resolveAccessContext(req, url);
      if (!accessCtx.ok) return send(res, 400, { error: accessCtx.error });
    }

    if (url.pathname === '/api/metrics' && req.method === 'GET') return send(res, 200, await getMetrics());
    if (url.pathname === '/api/pr1/verify' && req.method === 'GET') {
      const proof = await getPr1InboxInvariantCount();
      return send(res, 200, {
        ok: true,
        migration_id: '20260308_001_pr1_inbox_ownership_invariant',
        db_invariant: 'tasks_inbox_owner_must_be_ops_chk',
        db_invariant_applied: proof.invariantApplied,
        query: proof.query,
        tenant_id: proof.tenantId,
        invalid_inbox_rows: proof.invalidInboxRows
      });
    }
    if (url.pathname === '/api/escalations' && req.method === 'GET') return send(res, 200, { items: await getEscalations(100) });
    if (url.pathname === '/api/orchestration/templates' && req.method === 'GET') {
      const policy = loadPolicies();
      return send(res, 200, { templates: Object.keys(policy.templates || {}) });
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const mode = String(url.searchParams.get('mode') || 'board');
      const tasks = mode === 'full' ? await listTasks() : await listTasksBoard();
      return send(res, 200, { version: 1, mode, tasks });
    }
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
      if (task) await addEvent({ type: 'task_claimed', message: `${agentId} claimed ${task.id}`, taskId: task.id, actor: agentId });
      return send(res, 200, { ok: true, agentId, task, inboxCount: (await agentInbox(agentId)).length });
    }

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/claim-next') && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const agentId = url.pathname.split('/')[3];
      const task = await claimNext(agentId);
      if (!task) return send(res, 200, { ok: true, task: null });
      await addEvent({ type: 'task_claimed', message: `${agentId} claimed ${task.id}`, taskId: task.id, actor: agentId });
      return send(res, 200, { ok: true, task });
    }

    if (url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/complete-task') && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const agentId = url.pathname.split('/')[3];
      const body = await parseBody(req);
      const taskId = String(body.taskId || '').trim();
      const completionPackage = String(body.completionPackage || body.note || '').trim();
      if (!taskId) return send(res, 400, { error: 'validation_failed', details: ['taskId is required'] });
      if (!completionPackage) return send(res, 400, { error: 'validation_failed', details: ['completionPackage is required'] });
      if (!hasCompletionPackageSections(completionPackage)) {
        return send(res, 400, { error: 'completion_package_incomplete', required: ['Summary', 'What changed', 'Verification steps', 'Artifacts', 'Follow-ups'] });
      }

      const existing = await getTaskById(taskId);
      if (!existing) return send(res, 404, { error: 'task not found' });
      if (existing.owner !== agentId) return send(res, 403, { error: 'forbidden_owner', owner: existing.owner });
      const assigned = await isTaskAssignedToAgent(taskId, agentId);
      if (!assigned) return send(res, 403, { error: 'not_assigned_worker' });
      if (!['in_progress','review','done'].includes(existing.status)) {
        return send(res, 409, { error: 'invalid_status_for_completion', status: existing.status });
      }

      await addNote(taskId, completionPackage, agentId);
      await addEvent({ type: 'completion_package_written', message: `${agentId} posted completion package for ${taskId}`, taskId, actor: agentId });

      if (existing.status === 'in_progress') {
        const moved = await updateTask({ id: taskId, status: 'review', owner: agentId });
        await addEvent({ type: 'task_updated', message: `${taskId} -> review (${agentId}) auto-transition on completion package`, taskId, actor: agentId });
        return send(res, 200, { ok: true, task: { id: taskId, status: moved.status, owner: moved.owner }, transitioned: true });
      }

      return send(res, 200, { ok: true, task: { id: taskId, status: existing.status, owner: existing.owner }, transitioned: false, idempotent: true });
    }

    if (url.pathname === '/api/heartbeat/run' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.agentId) return send(res, 400, { error: 'validation_failed', details: ['agentId is required'] });
      await recordHeartbeat(body.agentId, body.status || 'ok', body.summary || '');
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/task/ack-start' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const taskId = String(body.taskId || '').trim();
      const agentId = String(body.agentId || '').trim();
      const startedAt = String(body.startedAt || '').trim();
      if (!taskId || !agentId || !startedAt) {
        return send(res, 400, { error: 'validation_failed', details: ['taskId, agentId, startedAt required'] });
      }
      const task = await getTaskById(taskId);
      if (!task) return send(res, 404, { error: 'task not found' });
      if (task.status !== 'starting') return send(res, 409, { error: 'invalid_transition', status: task.status, requiredStatus: 'starting' });
      if (task.owner !== agentId) return send(res, 403, { error: 'actor_not_allowed', owner: task.owner, agentId });

      const ack = await recordTaskStartAck({
        taskId,
        agentId,
        startedAt,
        pidOrSession: body.pidOrSession || null,
        heartbeatAt: body.heartbeatAt || null,
        noteAt: body.noteAt || null
      });
      await addEvent({ type: 'task_start_ack', message: `${taskId} ack by ${agentId} started_at=${startedAt}`, taskId, actor: agentId });
      return send(res, 200, { ok: true, ack, idempotent: true });
    }

    if (url.pathname === '/api/heartbeat/report' && req.method === 'GET') {
      const metrics = await getMetrics();
      const latest = metrics.latestHeartbeats || [];
      const latestByAgent = new Map();
      for (const hb of latest) {
        if (!latestByAgent.has(hb.agentId)) latestByAgent.set(hb.agentId, hb);
      }

      const tenantAgents = await listTenantAgents();
      const allAgentIds = [...new Set([...tenantAgents.map((a) => a.agentId), ...latestByAgent.keys()])];

      const nowMs = Date.now();
      const classify = (ageSeconds) => {
        if (ageSeconds <= 300) return 'healthy';
        if (ageSeconds <= 900) return 'degraded';
        if (ageSeconds <= 1800) return 'unhealthy';
        return 'stale';
      };

      const warningLevel = (status) => {
        if (status === 'healthy') return 'none';
        if (status === 'degraded') return 'warn';
        return 'critical';
      };
      const recommendedAction = (status) => {
        if (status === 'healthy') return 'none';
        if (status === 'degraded') return 'observe';
        if (status === 'unhealthy') return 'investigate';
        return 'restart_candidate';
      };

      const agents = allAgentIds.map((agentId) => {
        const hb = latestByAgent.get(agentId) || null;
        const ageSeconds = hb ? Math.max(0, Math.floor((nowMs - new Date(hb.at).getTime()) / 1000)) : null;
        const status = hb ? classify(ageSeconds) : 'stale';
        return {
          agent_id: agentId,
          last_heartbeat_at: hb?.at || null,
          heartbeat_age_seconds: ageSeconds,
          status,
          warning_level: warningLevel(status),
          recommended_action: recommendedAction(status)
        };
      });

      const counts = agents.reduce((acc, a) => {
        if (a.status === 'healthy') acc.healthy_count += 1;
        else if (a.status === 'degraded') acc.degraded_count += 1;
        else if (a.status === 'unhealthy') acc.unhealthy_count += 1;
        else acc.stale_count += 1;

        if (a.warning_level === 'warn') acc.warning_agents.push(a.agent_id);
        if (a.warning_level === 'critical') acc.critical_agents.push(a.agent_id);
        if (a.recommended_action === 'restart_candidate') acc.restart_candidate_agents.push(a.agent_id);
        return acc;
      }, {
        healthy_count: 0,
        degraded_count: 0,
        unhealthy_count: 0,
        stale_count: 0,
        warning_agents: [],
        critical_agents: [],
        restart_candidate_agents: []
      });

      return send(res, 200, {
        ok: true,
        generated_at: now(),
        total_agents: agents.length,
        has_warnings: counts.warning_agents.length > 0,
        has_critical: counts.critical_agents.length > 0,
        has_restart_candidates: counts.restart_candidate_agents.length > 0,
        ...counts,
        agents
      });
    }

    if (url.pathname === '/api/heartbeat/restart-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const report = await (async () => {
        const m = await getMetrics();
        const latest = m.latestHeartbeats || [];
        const latestByAgent = new Map();
        for (const hb of latest) if (!latestByAgent.has(hb.agentId)) latestByAgent.set(hb.agentId, hb);
        const tenantAgents = await listTenantAgents();
        const allAgentIds = [...new Set([...tenantAgents.map((a) => a.agentId), ...latestByAgent.keys()])];
        const nowMs = Date.now();
        const classify = (ageSeconds) => {
          if (ageSeconds <= 300) return 'healthy';
          if (ageSeconds <= 900) return 'degraded';
          if (ageSeconds <= 1800) return 'unhealthy';
          return 'stale';
        };
        return allAgentIds.map((agentId) => {
          const hb = latestByAgent.get(agentId) || null;
          const ageSeconds = hb ? Math.max(0, Math.floor((nowMs - new Date(hb.at).getTime()) / 1000)) : null;
          const status = hb ? classify(ageSeconds) : 'stale';
          return { agentId, status, at: hb?.at || null };
        });
      })();

      const onlyAgent = body.agentId || null;
      const nowTs = Date.now();
      const results = [];
      for (const a of report) {
        if (onlyAgent && a.agentId !== onlyAgent) continue;
        const eligible = a.status === 'unhealthy' || a.status === 'stale';
        if (!eligible) {
          results.push({ agent_id: a.agentId, attempted_at: now(), reason: 'not_eligible', result: 'skipped', skip_reason: 'status_not_unhealthy_or_stale' });
          continue;
        }

        const lastAttempts = await listHeartbeatRestartAttempts(a.agentId);
        const lastAttempt = lastAttempts[0] || null;
        const cooldownMs = 30 * 60 * 1000;
        const sixHoursAgo = new Date(nowTs - 6 * 60 * 60 * 1000).toISOString();
        const recentWindow = await listHeartbeatRestartAttempts(a.agentId, sixHoursAgo);
        const attemptCountWindow = recentWindow.length;

        if (lastAttempt && (nowTs - new Date(lastAttempt.attemptedAt).getTime()) < cooldownMs) {
          const cooldownUntil = new Date(new Date(lastAttempt.attemptedAt).getTime() + cooldownMs).toISOString();
          const idempotencyKey = `heartbeat_restart:${a.agentId}:${Math.floor(nowTs / cooldownMs)}`;
          await createHeartbeatRestartAttempt({ agentId: a.agentId, attemptedAt: now(), reason: 'cooldown_active', result: 'skipped', skipReason: 'cooldown_active', cooldownUntil, attemptCountWindow, idempotencyKey });
          results.push({ agent_id: a.agentId, attempted_at: now(), reason: 'cooldown_active', result: 'skipped', skip_reason: 'cooldown_active', cooldown_until: cooldownUntil, attempt_count_window: attemptCountWindow });
          continue;
        }

        if (attemptCountWindow >= 2) {
          const idempotencyKey = `heartbeat_restart:${a.agentId}:${Math.floor(nowTs / cooldownMs)}`;
          await createHeartbeatRestartAttempt({ agentId: a.agentId, attemptedAt: now(), reason: 'max_attempts_window_reached', result: 'skipped', skipReason: 'max_attempts_window_reached', attemptCountWindow, idempotencyKey });
          results.push({ agent_id: a.agentId, attempted_at: now(), reason: 'max_attempts_window_reached', result: 'skipped', skip_reason: 'max_attempts_window_reached', attempt_count_window: attemptCountWindow });
          continue;
        }

        const idempotencyKey = `heartbeat_restart:${a.agentId}:${Math.floor(nowTs / cooldownMs)}`;
        try {
          await recordHeartbeat(a.agentId, 'ok', 'restart_automation_attempt');
          await createHeartbeatRestartAttempt({ agentId: a.agentId, attemptedAt: now(), reason: 'restart_candidate', result: 'success', attemptCountWindow: attemptCountWindow + 1, idempotencyKey });
          results.push({ agent_id: a.agentId, attempted_at: now(), reason: 'restart_candidate', result: 'success', attempt_count_window: attemptCountWindow + 1 });
        } catch (e) {
          await createHeartbeatRestartAttempt({ agentId: a.agentId, attemptedAt: now(), reason: 'restart_candidate', result: 'failed', skipReason: String(e.message || e), attemptCountWindow: attemptCountWindow + 1, idempotencyKey });
          results.push({ agent_id: a.agentId, attempted_at: now(), reason: 'restart_candidate', result: 'failed', skip_reason: String(e.message || e), attempt_count_window: attemptCountWindow + 1 });
        }
      }

      return send(res, 200, { ok: true, attempted: results.length, results });
    }

    if (url.pathname === '/api/autopilot/stale-run' && req.method === 'POST') {
      const tasks = await listTasks();
      const nowMs = Date.now();
      const toMs = (v) => {
        const d = new Date(v || 0).getTime();
        return Number.isFinite(d) ? d : 0;
      };
      const lastActivityMs = (t) => toMs(t.lastActivityAt || t.updatedAt || t.createdAt);

      const assignedStale = tasks.filter((t) => t.status === 'assigned' && (nowMs - lastActivityMs(t)) > 24 * 60 * 60 * 1000);
      const inProgressStale = tasks.filter((t) => t.status === 'in_progress' && (nowMs - lastActivityMs(t)) > 8 * 60 * 60 * 1000);
      const reviewStale = tasks.filter((t) => t.status === 'review' && (nowMs - lastActivityMs(t)) > 12 * 60 * 60 * 1000);

      const runId = `stale-run-${Date.now()}`;
      const staleTaskIds = {
        assigned: assignedStale.map((t) => t.id),
        in_progress: inProgressStale.map((t) => t.id),
        review: reviewStale.map((t) => t.id)
      };

      const recommendedActions = {
        assigned: 'queue_for_ops_triage',
        in_progress: 'queue_for_recovery_check',
        review: 'return_to_assigned_for_completion_check'
      };

      const result = {
        ok: true,
        run_id: runId,
        generated_at: now(),
        assigned_stale_count: assignedStale.length,
        in_progress_stale_count: inProgressStale.length,
        review_stale_count: reviewStale.length,
        stale_task_ids: staleTaskIds,
        recommended_actions: recommendedActions,
        recovery_candidates: [...new Set(inProgressStale.map((t) => t.owner))]
      };

      if (!READ_ONLY) {
        await addEvent({ type: 'autopilot_stale_run', message: `${runId} assigned=${assignedStale.length} in_progress=${inProgressStale.length} review=${reviewStale.length}`, actor: 'autopilot' });
      }

      return send(res, 200, result);
    }

    if (url.pathname === '/api/autopilot/inbox-hygiene-run' && req.method === 'POST') {
      const tasks = await listTasks();
      const inbox = tasks.filter((t) => t.status === 'inbox');
      const triageRequired = inbox.filter((t) => inboxAgeMs(t) > 24 * 60 * 60 * 1000);
      const archiveCandidates = inbox.filter((t) => inboxAgeMs(t) > 72 * 60 * 60 * 1000);
      const ownerViolations = inbox.filter((t) => t.owner !== 'ops');

      const sample = (arr) => arr.slice(0, 10).map((t) => t.id);
      const runId = `inbox-hygiene-${Date.now()}`;

      if (!READ_ONLY) {
        await addEvent({ type: 'inbox_triage_required', message: `${runId} count=${triageRequired.length} sample=${sample(triageRequired).join(',') || 'none'}`, actor: 'autopilot' });
        await addEvent({ type: 'archive_candidate', message: `${runId} count=${archiveCandidates.length} sample=${sample(archiveCandidates).join(',') || 'none'}`, actor: 'autopilot' });
        if (ownerViolations.length > 0) {
          await addEvent({ type: 'inbox_owner_violation_detected', message: `${runId} count=${ownerViolations.length} sample=${sample(ownerViolations).join(',')}`, actor: 'autopilot' });
        }
      }

      return send(res, 200, {
        ok: true,
        mode: 'telemetry_only',
        run_id: runId,
        generated_at: now(),
        inbox_total: inbox.length,
        inbox_triage_required_count: triageRequired.length,
        archive_candidate_count: archiveCandidates.length,
        inbox_owner_violation_count: ownerViolations.length,
        sample_task_ids: {
          triage_required: sample(triageRequired),
          archive_candidate: sample(archiveCandidates),
          owner_violations: sample(ownerViolations)
        }
      });
    }

    if (url.pathname === '/api/autopilot/inbox-auto-triage-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const thresholdMinutes = Math.max(0, Number(body.thresholdMinutes ?? 15));
      const tasks = await listTasks();
      const candidates = tasks.filter((t) => t.status === 'inbox' && inboxAgeMs(t) > thresholdMinutes * 60 * 1000);
      const out = { reviewed: 0, triaged: 0, archived_test: 0, left_unclear: 0, samples: { triaged: [], archived_test: [], unclear: [] } };

      for (const t of candidates) {
        out.reviewed += 1;
        const classification = classifyInboxTask(t);
        if (classification === 'legitimate work item') {
          await updateTask({ id: t.id, status: 'assigned', owner: 'ops' });
          await addNote(t.id, 'inbox_auto_triaged', 'autopilot');
          await addEvent({ type: 'inbox_auto_triaged', message: `${t.id} inbox->assigned`, taskId: t.id, actor: 'autopilot' });
          out.triaged += 1;
          if (out.samples.triaged.length < 10) out.samples.triaged.push(t.id);
        } else if (classification === 'test/canary') {
          await updateTask({ id: t.id, status: 'archived', owner: t.owner });
          await addNote(t.id, 'inbox_auto_archived_test', 'autopilot');
          await addEvent({ type: 'inbox_auto_archived_test', message: `${t.id} inbox->archived`, taskId: t.id, actor: 'autopilot' });
          out.archived_test += 1;
          if (out.samples.archived_test.length < 10) out.samples.archived_test.push(t.id);
        } else {
          if (t.owner !== 'ops') await updateTask({ id: t.id, status: 'inbox', owner: 'ops' });
          await addNote(t.id, 'inbox_triage_required', 'autopilot');
          await addEvent({ type: 'inbox_triage_required', message: `${t.id} classification=${classification}`, taskId: t.id, actor: 'autopilot' });
          out.left_unclear += 1;
          if (out.samples.unclear.length < 10) out.samples.unclear.push(t.id);
        }
      }

      return send(res, 200, { ok: true, threshold_minutes: thresholdMinutes, ...out });
    }

    if (url.pathname === '/api/autopilot/review-run' && (req.method === 'POST' || req.method === 'GET')) {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = req.method === 'POST' ? await parseBody(req) : Object.fromEntries(url.searchParams.entries());
      const defaultMode = req.method === 'GET' ? 'apply' : 'dry_run';
      const mode = String(body.mode || defaultMode).trim();
      if (!['dry_run', 'apply'].includes(mode)) return send(res, 400, { error: 'validation_failed', details: ['mode must be dry_run or apply'] });
      const batchSize = Math.max(1, Math.min(Number(body.batchSize || REVIEW_RUN_DEFAULT_BATCH), 10));
      const thresholdHours = Math.max(1, Number(body.reviewAlertHours || 12));

      const runId = `review-run-${Date.now()}`;
      const runToken = `${runId}:${mode}:${batchSize}`;
      const processedRevisionKeys = new Set();
      const tasks = (await listTasks())
        .filter((t) => t.status === 'review')
        .sort((a, b) => new Date(a.updatedAt || a.createdAt) - new Date(b.updatedAt || b.createdAt))
        .slice(0, batchSize);

      const allEvents = await listEvents(5000);
      const decisions = [];

      for (const task of tasks) {
        const taskEvents = allEvents.filter((e) => e.taskId === task.id);
        const latestReviewEnterAt = taskEvents
          .filter((e) => e.type === 'task_updated' && String(e.message || '').includes(`${task.id} -> review`))
          .map((e) => e.at)
          .sort((a, b) => new Date(b) - new Date(a))[0] || task.createdAt;

        const latestPackage = (task.notes || []).find((n) => hasCompletionPackageSections(n.note || '') && new Date(n.at || 0).getTime() >= new Date(latestReviewEnterAt || 0).getTime());
        const revisionAnchor = `${task.updatedAt || ''}|${latestPackage?.at || 'no_package'}`;
        const revisionKey = `${task.id}:${revisionAnchor}`;
        if (processedRevisionKeys.has(revisionKey)) continue;
        processedRevisionKeys.add(revisionKey);

        const priorDecisionExists = taskEvents.some((e) => e.type === 'review_decision' && String(e.message || '').includes(`revision=${revisionKey}`));
        if (priorDecisionExists) {
          decisions.push({ task_id: task.id, prior_status: task.status, final_status: task.status, decision: 'skipped', reason_code: 'already_decided_for_revision', revision: revisionKey });
          continue;
        }

        if (!latestPackage) {
          const missing = COMPLETION_PACKAGE_HEADERS;
          if (mode === 'apply') {
            await updateTask({ id: task.id, status: 'assigned', owner: task.owner });
            await addNote(task.id, `review_package_incomplete: missing=${missing.join(', ')}`, 'ultron');
            await addEvent({ type: 'review_decision', message: `${runToken} ${task.id} review->assigned reason_code=review_package_incomplete revision=${revisionKey}`, taskId: task.id, actor: 'ultron' });
            await addEvent({ type: 'task_updated', message: `${task.id} -> assigned (${task.owner})`, taskId: task.id, actor: 'ultron' });
          }
          decisions.push({ task_id: task.id, prior_status: 'review', final_status: mode === 'apply' ? 'assigned' : 'review', decision: mode === 'apply' ? 'reassigned' : 'would_reassign', reason_code: 'review_package_incomplete', missing_items: missing, revision: revisionKey });
          continue;
        }

        const missing = getMissingCompletionPackageSections(latestPackage.note || '');
        if (missing.length > 0) {
          if (mode === 'apply') {
            await updateTask({ id: task.id, status: 'assigned', owner: task.owner });
            await addNote(task.id, `review_package_incomplete: missing=${missing.join(', ')}`, 'ultron');
            await addEvent({ type: 'review_decision', message: `${runToken} ${task.id} review->assigned reason_code=review_package_incomplete revision=${revisionKey}`, taskId: task.id, actor: 'ultron' });
            await addEvent({ type: 'task_updated', message: `${task.id} -> assigned (${task.owner})`, taskId: task.id, actor: 'ultron' });
          }
          decisions.push({ task_id: task.id, prior_status: 'review', final_status: mode === 'apply' ? 'assigned' : 'review', decision: mode === 'apply' ? 'reassigned' : 'would_reassign', reason_code: 'review_package_incomplete', missing_items: missing, revision: revisionKey });
          continue;
        }

        if (mode === 'apply') {
          await updateTask({ id: task.id, status: 'done', owner: task.owner });
          await addEvent({ type: 'review_decision', message: `${runToken} ${task.id} review->done reason_code=review_approved revision=${revisionKey}`, taskId: task.id, actor: 'ultron' });
          await addEvent({ type: 'task_updated', message: `${task.id} -> done (${task.owner})`, taskId: task.id, actor: 'ultron' });
        }
        decisions.push({ task_id: task.id, prior_status: 'review', final_status: mode === 'apply' ? 'done' : 'review', decision: mode === 'apply' ? 'approved' : 'would_approve', reason_code: 'review_approved', revision: revisionKey, package_at: latestPackage.at });
      }

      const reviewAgeThresholdMs = thresholdHours * 60 * 60 * 1000;
      const allReview = (await listTasks()).filter((t) => t.status === 'review');
      const overThreshold = allReview.filter((t) => (Date.now() - new Date(t.updatedAt || t.createdAt || 0).getTime()) > reviewAgeThresholdMs);

      reviewRunTelemetry = {
        run_id: runId,
        mode,
        review_decision_count_last_run: decisions.filter((d) => ['approved','reassigned'].includes(d.decision)).length,
        reviewed_count_last_run: tasks.length,
        generated_at: now(),
        cadence: REVIEW_RUN_CADENCE_CRON,
        trigger_path: '/api/autopilot/review-run'
      };

      return send(res, 200, {
        ok: true,
        run_id: runId,
        run_token: runToken,
        mode,
        batch_size: batchSize,
        reviewed_count: tasks.length,
        review_decision_count_last_run: reviewRunTelemetry.review_decision_count_last_run,
        review_over_threshold_count: overThreshold.length,
        review_over_threshold_sample: overThreshold.slice(0, 10).map((t) => t.id),
        cadence: REVIEW_RUN_CADENCE_CRON,
        trigger_path: '/api/autopilot/review-run',
        decisions
      });
    }

    if (url.pathname === '/api/autopilot/board-health' && req.method === 'GET') {
      const [tenantTeam, agg] = await Promise.all([
        listTenantAgents(),
        getBoardHealthAggregates(accessCtx.tenantId)
      ]);

      const inProgressTotal = Number(agg.inProgressTotal || 0);
      const reviewTotal = Number(agg.reviewTotal || 0);
      const tasksCompleted24h = Number(agg.tasksCompleted24h || 0);
      const averageWip = Math.max(1, inProgressTotal);
      const flowRatio = Number((tasksCompleted24h / averageWip).toFixed(2));
      const flowColor = flowRatio >= 2 ? 'green' : flowRatio >= 1 ? 'yellow' : 'red';

      const teamWip = agg.teamWip || {};
      const perAgentWipViolations = Object.values(teamWip).filter((v) => Number(v.in_progress || 0) > 1).length;
      const globalWipViolation = inProgressTotal > 4 ? 1 : 0;
      const reviewCapViolation = reviewTotal > 3 ? 1 : 0;
      const workerIds = tenantTeam.map((a) => a.agentId).filter((id) => id !== 'ultron' && id !== 'ops');
      const assignedBacklog = Number((agg.byStatus || {}).assigned || 0);
      const idleWorkers = workerIds.filter((id) => ((teamWip[id]?.in_progress || 0) === 0));

      return send(res, 200, {
        ok: true,
        generated_at: now(),
        open_total: Number(agg.openTotal || 0),
        starting_total: Number(agg.startingTotal || 0),
        in_progress_total: inProgressTotal,
        review_total: reviewTotal,
        blocked_total: Number(agg.blockedTotal || 0),
        by_status: agg.byStatus || {},
        by_owner: agg.byOwner || {},
        tenant_team: tenantTeam.map((a) => ({ agent_id: a.agentId, role: a.role })),
        team_wip: teamWip,
        working_by_status: teamWip,
        flow_ratio: {
          value: flowRatio,
          color: flowColor,
          tasks_completed_24h: tasksCompleted24h,
          average_wip: averageWip
        },
        contract_health: {
          inbox_owner_violations: Number(agg.inboxOwnerViolations || 0),
          ultron_execution_violations: Number(agg.ultronExecutionViolations || 0),
          per_agent_wip_violations: perAgentWipViolations,
          global_wip_violations: globalWipViolation,
          review_cap_violations: reviewCapViolation,
          idle_workers_with_assigned_backlog: assignedBacklog > 0 ? idleWorkers.length : 0,
          assigned_backlog: assignedBacklog
        },
        stale_bins: agg.staleBins || { assigned_gt_24h: 0, starting_gt_3m: 0, in_progress_gt_8h: 0, review_gt_12h: 0 },
        starting_over_timeout_count: Number((agg.staleBins || {}).starting_gt_3m || 0),
        starting_oldest_age_minutes: Number(agg.startingOldestAgeMinutes || 0),
        sample_starting_task_ids: agg.sampleStartingTaskIds || [],
        review_pressure: reviewTotal > 3 ? 'high' : reviewTotal > 1 ? 'medium' : 'low',
        wip_pressure: inProgressTotal > 4 ? 'high' : inProgressTotal > 2 ? 'medium' : 'low',
        review_loop: {
          run_id: reviewRunTelemetry.run_id,
          mode: reviewRunTelemetry.mode,
          reviewed_count_last_run: reviewRunTelemetry.reviewed_count_last_run,
          review_decision_count_last_run: reviewRunTelemetry.review_decision_count_last_run,
          generated_at: reviewRunTelemetry.generated_at,
          cadence: reviewRunTelemetry.cadence,
          trigger_path: reviewRunTelemetry.trigger_path,
          default_batch_size: REVIEW_RUN_DEFAULT_BATCH
        }
      });
    }

    if (url.pathname === '/api/task/normalize-contract' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });
      const tasks = await listTasks();
      const normalized = [];
      for (const t of tasks) {
        if (t.status === 'inbox' && t.owner !== 'ops') {
          const updated = await updateTask({ id: t.id, owner: 'ops', status: 'inbox' });
          normalized.push({ id: t.id, from_owner: t.owner, to_owner: updated.owner });
          await addEvent({ type: 'task_normalized', message: `${t.id} inbox owner normalized ${t.owner} -> ops`, taskId: t.id, actor: 'autopilot' });
        }
      }
      return send(res, 200, { ok: true, normalized_count: normalized.length, normalized });
    }


    if (url.pathname === '/api/contract/watchdog-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });

      const runId = `watchdog-${Date.now()}`;
      const tasks = await listTasks();
      const tenantAgents = await listTenantAgents();
      const teamIds = new Set(tenantAgents.map((a) => a.agentId));
      const teamWip = tasks.filter((t) => teamIds.has(t.owner)).reduce((acc, t) => {
        if (!acc[t.owner]) acc[t.owner] = { in_progress: 0, assigned: 0, review: 0 };
        if (t.status === 'in_progress') acc[t.owner].in_progress += 1;
        if (t.status === 'assigned') acc[t.owner].assigned += 1;
        if (t.status === 'review') acc[t.owner].review += 1;
        return acc;
      }, {});

      const violationsFound = [];
      const violationsFixed = [];
      const violationsFlagged = [];
      const recommendedActions = [];

      const inboxViolations = tasks.filter((t) => t.status === 'inbox' && t.owner !== 'ops');
      for (const t of inboxViolations) {
        violationsFound.push({ kind: 'inbox_owner_violation', taskId: t.id, owner: t.owner });
        violationsFlagged.push({ kind: 'inbox_owner_violation', taskId: t.id, owner: t.owner });
        recommendedActions.push('run_normalize_contract_maintenance');
        await addEvent({ type: 'contract_violation_detected', message: `${t.id} inbox owner ${t.owner} (must be ops)`, taskId: t.id, actor: 'watchdog' });
      }

      const ultronExec = tasks.filter((t) => t.owner === 'ultron' && (t.status === 'assigned' || t.status === 'in_progress'));
      for (const t of ultronExec) {
        violationsFound.push({ kind: 'ultron_execution_violation', taskId: t.id, status: t.status });
        violationsFlagged.push({ kind: 'ultron_execution_violation', taskId: t.id, status: t.status });
        await addEvent({ type: 'contract_violation_detected', message: `${t.id} ultron in ${t.status} (execution states disallowed)`, taskId: t.id, actor: 'watchdog' });
      }

      for (const [agentId, v] of Object.entries(teamWip)) {
        if (Number(v.in_progress || 0) > 1) {
          violationsFound.push({ kind: 'per_agent_wip_violation', agentId, in_progress: v.in_progress });
          violationsFlagged.push({ kind: 'per_agent_wip_violation', agentId, in_progress: v.in_progress });
          await addEvent({ type: 'contract_violation_detected', message: `${agentId} in_progress ${v.in_progress} > 1`, actor: 'watchdog' });
        }
      }

      const inProgressTotal = tasks.filter((t) => t.status === 'in_progress').length;
      if (inProgressTotal > 4) {
        violationsFound.push({ kind: 'global_wip_violation', in_progress: inProgressTotal, limit: 4 });
        violationsFlagged.push({ kind: 'global_wip_violation', in_progress: inProgressTotal, limit: 4 });
        await addEvent({ type: 'contract_violation_detected', message: `global in_progress ${inProgressTotal} > 4`, actor: 'watchdog' });
      }

      const reviewTotal = tasks.filter((t) => t.status === 'review').length;
      if (reviewTotal > 3) {
        violationsFound.push({ kind: 'review_cap_violation', review: reviewTotal, limit: 3 });
        violationsFlagged.push({ kind: 'review_cap_violation', review: reviewTotal, limit: 3 });
        await addEvent({ type: 'contract_violation_detected', message: `review ${reviewTotal} > 3`, actor: 'watchdog' });
      }

      const workerIds = tenantAgents.map((a) => a.agentId).filter((id) => id !== 'ultron' && id !== 'ops');
      const assignedBacklog = tasks.filter((t) => t.status === 'assigned').length;
      const idleWorkers = workerIds.filter((id) => ((teamWip[id]?.in_progress || 0) === 0));
      if (assignedBacklog > 0 && idleWorkers.length > 0) {
        violationsFound.push({ kind: 'idle_workers_with_assigned_backlog', idle_workers: idleWorkers.length, assigned_backlog: assignedBacklog });
        violationsFlagged.push({ kind: 'idle_workers_with_assigned_backlog', idle_workers: idleWorkers.length, assigned_backlog: assignedBacklog });
        recommendedActions.push('run_supervisor');
      }

      return send(res, 200, {
        ok: true,
        run_id: runId,
        violations_found: violationsFound.length,
        violations_fixed: violationsFixed.length,
        violations_flagged: violationsFlagged.length,
        found: violationsFound,
        fixed: violationsFixed,
        flagged: violationsFlagged,
        recommended_actions: recommendedActions
      });
    }

    if (url.pathname === '/api/contract/supervisor-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });

      const runId = `supervisor-${Date.now()}`;
      const body = await parseBody(req);
      const maxClaims = Math.max(1, Math.min(Number(body.maxClaims || 4), 10));
      const tenantAgents = await listTenantAgents();
      const eligibleWorkers = tenantAgents.filter((a) => a.enabled && a.agentId !== 'ultron' && a.agentId !== 'ops').map((a) => a.agentId);

      const tenantPlan = await getTenantPlan(accessCtx.tenantId);
      const planLimits = tenantPlan ? JSON.parse(tenantPlan.limitsJson || '{}') : {};
      const maxWipGlobal = Number(planLimits.max_wip || 4);

      const claimed = [];
      const skipped = [];

      for (const agentId of eligibleWorkers) {
        if (claimed.length >= maxClaims) break;

        const snapshot = await listTasks();
        const globalInProgress = snapshot.filter((t) => t.status === 'in_progress').length;
        if (globalInProgress >= maxWipGlobal) {
          skipped.push({ agent_id: agentId, reason: 'global_wip_cap_reached', current: globalInProgress, limit: maxWipGlobal });
          break;
        }

        const existing = snapshot.find((t) => t.owner === agentId && t.status === 'in_progress');
        if (existing) {
          skipped.push({ agent_id: agentId, reason: 'already_in_progress', task_id: existing.id });
          continue;
        }

        const candidate = await claimNext(agentId);
        if (!candidate) {
          skipped.push({ agent_id: agentId, reason: 'no_assigned_task_available' });
          continue;
        }

        const ownerInProgress = await countTasksByOwnerAndStatus(agentId, 'in_progress', candidate.id);
        if (ownerInProgress >= 1) {
          skipped.push({ agent_id: agentId, reason: 'owner_wip_cap_reached', current: ownerInProgress, limit: 1 });
          continue;
        }

        const moved = await updateTask({ id: candidate.id, status: 'in_progress', owner: agentId });
        await addEvent({ type: 'auto_claim_executed', message: `${candidate.id} auto-claimed by ${agentId}`, taskId: candidate.id, actor: 'supervisor' });
        await recordUsageEvent({ tenantId: accessCtx.tenantId, agentId, eventType: 'task_execution', taskId: candidate.id, tokensUsed: 5, computeMs: 15 });
        claimed.push({ agent_id: agentId, task_id: moved.id });
      }

      return send(res, 200, { ok: true, run_id: runId, claimed_count: claimed.length, claimed, skipped_count: skipped.length, skipped });
    }

    if (url.pathname === '/api/contract/load-balance-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });

      const runId = `loadbal-${Date.now()}`;
      const body = await parseBody(req);
      const maxMoves = Math.max(1, Math.min(Number(body.maxMoves || 2), 10));
      const tasks = await listTasks();
      const tenantAgents = await listTenantAgents();
      const workers = tenantAgents.map((a) => a.agentId).filter((id) => id !== 'ultron' && id !== 'ops');

      const byWorker = new Map();
      for (const worker of workers) byWorker.set(worker, { assigned: 0, in_progress: 0 });
      for (const t of tasks) {
        if (!workers.includes(t.owner)) continue;
        const cur = byWorker.get(t.owner) || { assigned: 0, in_progress: 0 };
        if (t.status === 'assigned') cur.assigned += 1;
        if (t.status === 'in_progress') cur.in_progress += 1;
        byWorker.set(t.owner, cur);
      }

      const actions = [];
      const skipped = [];
      for (let i = 0; i < maxMoves; i++) {
        const ordered = [...byWorker.entries()].sort((a, b) => (b[1].assigned - a[1].assigned));
        const donor = ordered[0];
        const idleRecipients = [...byWorker.entries()]
          .filter(([, v]) => Number(v.in_progress || 0) < 1)
          .sort((a, b) => (a[1].assigned - b[1].assigned));
        const recipient = idleRecipients[0];
        if (!donor) break;
        if (!recipient) {
          skipped.push({ reason: 'no_idle_recipient' });
          break;
        }
        if (donor[0] === recipient[0]) break;
        if ((donor[1].assigned - recipient[1].assigned) < 2) {
          skipped.push({ reason: 'already_balanced' });
          break;
        }

        const candidate = tasks.find((t) => t.owner === donor[0] && t.status === 'assigned');
        if (!candidate) {
          skipped.push({ reason: 'no_assigned_candidate', donor: donor[0] });
          break;
        }

        const moved = await updateTask({ id: candidate.id, owner: recipient[0], status: 'assigned' });
        byWorker.get(donor[0]).assigned = Math.max(0, Number(byWorker.get(donor[0]).assigned || 0) - 1);
        byWorker.get(recipient[0]).assigned = Number(byWorker.get(recipient[0]).assigned || 0) + 1;

        const action = { task_id: moved.id, from: donor[0], to: recipient[0], status: 'assigned' };
        actions.push(action);
        await addEvent({ type: 'load_balance_action', message: `${moved.id} reassigned ${donor[0]} -> ${recipient[0]}`, taskId: moved.id, actor: 'load-balancer' });
      }

      return send(res, 200, { ok: true, run_id: runId, actions_count: actions.length, actions, skipped_count: skipped.length, skipped });
    }

    if (url.pathname === '/api/contract/scale-workers-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });

      const runId = `scaleplan-${Date.now()}`;
      const body = await parseBody(req);
      const capability = String(body.capability || 'codi').trim().toLowerCase();
      const apply = Boolean(body.apply);
      if (capability !== 'codi') return send(res, 400, { error: 'unsupported_capability', supported: ['codi'] });

      const [tasks, tenantAgents, tenantPlan] = await Promise.all([
        listTasks(),
        listTenantAgents(),
        getTenantPlan(accessCtx.tenantId)
      ]);

      const planKey = tenantPlan?.planKey || 'starter';
      const maxTempByPlan = planKey === 'enterprise' ? 2 : planKey === 'professional' ? 1 : 0;

      const codiLike = tenantAgents.filter((a) => a.agentId === 'codi' || a.agentId.startsWith('codi-temp-')).map((a) => a.agentId);
      const primaryWorkers = codiLike.filter((id) => id === 'codi');
      const tempWorkers = codiLike.filter((id) => id.startsWith('codi-temp-'));

      const workerStats = new Map();
      for (const id of codiLike) workerStats.set(id, { assigned: 0, in_progress: 0 });
      for (const t of tasks) {
        if (!workerStats.has(t.owner)) continue;
        const cur = workerStats.get(t.owner);
        if (t.status === 'assigned') cur.assigned += 1;
        if (t.status === 'in_progress') cur.in_progress += 1;
      }

      const assignedForCapability = [...workerStats.values()].reduce((s, v) => s + Number(v.assigned || 0), 0);
      const idleWorkers = [...workerStats.values()].filter((v) => Number(v.in_progress || 0) === 0).length;
      const saturatedWorkers = [...workerStats.values()].filter((v) => Number(v.in_progress || 0) >= 1).length;
      const activeWorkerCapacity = Math.max(1, codiLike.length);
      const capacityRemaining = Math.max(0, maxTempByPlan - tempWorkers.length);

      const reasons = [];
      if (maxTempByPlan <= 0) reasons.push('plan_disallows_temp_workers');
      if (capacityRemaining <= 0) reasons.push('temp_worker_cap_reached');
      if (!(assignedForCapability >= 4)) reasons.push('assigned_backlog_below_threshold');
      if (!(idleWorkers === 0)) reasons.push('idle_worker_available');
      if (!(saturatedWorkers >= 1)) reasons.push('no_saturated_worker');
      if (!(assignedForCapability > activeWorkerCapacity)) reasons.push('capacity_not_exceeded');

      const wouldScaleUp = reasons.length === 0;

      const tempWorkerId = 'codi-temp-1';
      const tempExists = tempWorkers.includes(tempWorkerId);
      const tempStats = workerStats.get(tempWorkerId) || { assigned: 0, in_progress: 0 };
      const tempIdle = Number(tempStats.in_progress || 0) === 0 && Number(tempStats.assigned || 0) === 0;
      const backlogCleared = assignedForCapability < 2 && !wouldScaleUp;

      const recentEvents = await listEvents(120);
      const lastDownCheck = recentEvents.find((e) => e.type === 'worker_scale_down_check' && String(e.message || '').includes(tempWorkerId));
      const prevQualified = !!(lastDownCheck && String(lastDownCheck.message).includes('qualified=1'));
      const currentQualified = tempExists && backlogCleared && tempIdle;
      const wouldScaleDown = currentQualified && prevQualified;

      await addEvent({ type: 'worker_scale_down_check', message: `${tempWorkerId}|qualified=${currentQualified ? 1 : 0}|idle=${tempIdle ? 1 : 0}|backlogCleared=${backlogCleared ? 1 : 0}`, actor: 'scale-controller' });

      let scaleUp = { attempted: false, performed: false, worker: null, reason: null };
      let scaleDown = { attempted: false, performed: false, worker: null, reason: null };

      if (apply) {
        scaleUp.attempted = true;
        if (tempExists) {
          scaleUp.reason = 'temp_worker_already_exists';
        } else if (!wouldScaleUp) {
          scaleUp.reason = 'planner_conditions_not_met';
        } else {
          await addTenantAgent({ tenantId: accessCtx.tenantId, agentId: tempWorkerId, role: 'agent', enabled: 1, displayName: 'Codi Temp 1', capabilitiesProfile: 'codi-temp' });
          await setTenantAgentEnabled({ tenantId: accessCtx.tenantId, agentId: tempWorkerId, enabled: 1 });
          await addEvent({ type: 'worker_scale_up', message: `${tempWorkerId} activated (assigned_backlog_exceeds_capacity)`, actor: 'scale-controller' });
          scaleUp = { attempted: true, performed: true, worker: tempWorkerId, reason: 'assigned_backlog_exceeds_capacity' };
        }

        if (!scaleUp.performed) {
          scaleDown.attempted = true;
          if (!tempExists) {
            scaleDown.reason = 'no_temp_worker_present';
          } else if (!tempIdle) {
            scaleDown.reason = 'temp_worker_not_idle';
          } else if (!backlogCleared) {
            scaleDown.reason = 'backlog_not_cleared';
          } else if (!wouldScaleDown) {
            scaleDown.reason = 'consecutive_qualifying_checks_not_met';
          } else {
            await setTenantAgentEnabled({ tenantId: accessCtx.tenantId, agentId: tempWorkerId, enabled: 0 });
            await addEvent({ type: 'worker_scale_down', message: `${tempWorkerId} disabled (backlog_cleared_and_worker_idle)`, actor: 'scale-controller' });
            scaleDown = { attempted: true, performed: true, worker: tempWorkerId, reason: 'backlog_cleared_and_worker_idle' };
          }
        }
      }

      return send(res, 200, {
        ok: true,
        run_id: runId,
        planner_only: !apply,
        apply,
        capability,
        plan_key: planKey,
        limits: { max_temp_workers: maxTempByPlan, capacity_remaining: capacityRemaining },
        current: {
          primary_workers: primaryWorkers.length,
          temp_workers: tempWorkers.length,
          active_workers: codiLike.length,
          active_worker_capacity: activeWorkerCapacity,
          assigned_for_capability: assignedForCapability,
          idle_workers_for_capability: idleWorkers,
          saturated_workers_for_capability: saturatedWorkers,
          temp_worker_idle: tempIdle,
          backlog_cleared: backlogCleared,
          previous_scale_down_qualified: prevQualified
        },
        would_scale_up: wouldScaleUp,
        would_scale_down: wouldScaleDown,
        recommendation: wouldScaleUp ? 'scale_up_candidate' : (wouldScaleDown ? 'scale_down_candidate' : 'no_scale'),
        reasons,
        scale_up: scaleUp,
        scale_down: scaleDown
      });
    }

    if (url.pathname === '/api/task/recovery-run' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const onlyAgent = body.agentId || null;

      const metrics = await getMetrics();
      const latest = metrics.latestHeartbeats || [];
      const latestByAgent = new Map();
      for (const hb of latest) if (!latestByAgent.has(hb.agentId)) latestByAgent.set(hb.agentId, hb);
      const tenantAgents = await listTenantAgents();
      const allAgentIds = [...new Set([...tenantAgents.map((a) => a.agentId), ...latestByAgent.keys()])];

      const nowMs = Date.now();
      const classify = (ageSeconds) => {
        if (ageSeconds <= 300) return 'healthy';
        if (ageSeconds <= 900) return 'degraded';
        if (ageSeconds <= 1800) return 'unhealthy';
        return 'stale';
      };

      const tasks = await listTasks();
      const recovered = [];
      const skipped = [];

      for (const agentId of allAgentIds) {
        if (onlyAgent && onlyAgent !== agentId) continue;
        const hb = latestByAgent.get(agentId) || null;
        const ageSeconds = hb ? Math.max(0, Math.floor((nowMs - new Date(hb.at).getTime()) / 1000)) : null;
        const status = hb ? classify(ageSeconds) : 'stale';
        if (!(status === 'unhealthy' || status === 'stale')) continue;

        const sixHoursAgo = new Date(nowMs - 6 * 60 * 60 * 1000).toISOString();
        const attempts = await listHeartbeatRestartAttempts(agentId, sixHoursAgo);
        if (attempts.length < 2) {
          skipped.push({ agent_id: agentId, reason: 'restart_attempts_not_exhausted', attempts: attempts.length });
          continue;
        }

        const inProgressTasks = tasks.filter((t) => t.owner === agentId && t.status === 'in_progress');
        for (const t of inProgressTasks) {
          const bucket = Math.floor(nowMs / (30 * 60 * 1000));
          const idempotencyKey = `task_recovery:${agentId}:${bucket}:${t.id}`;
          if (await hasTaskRecoveryAction(idempotencyKey)) {
            skipped.push({ task_id: t.id, agent_id: agentId, reason: 'already_recovered_in_bucket' });
            continue;
          }

          const freshTasks = await listTasks();
          const current = freshTasks.find((x) => x.id === t.id);
          if (!current || current.status !== 'in_progress') {
            skipped.push({ task_id: t.id, agent_id: agentId, reason: 'task_no_longer_in_progress' });
            continue;
          }

          const t2hb = latestByAgent.get(agentId) || null;
          const t2age = t2hb ? Math.max(0, Math.floor((Date.now() - new Date(t2hb.at).getTime()) / 1000)) : null;
          const t2status = t2hb ? classify(t2age) : 'stale';
          if (!(t2status === 'unhealthy' || t2status === 'stale')) {
            skipped.push({ task_id: t.id, agent_id: agentId, reason: 'agent_recovered_before_task_recovery' });
            continue;
          }

          await updateTask({ id: t.id, status: 'assigned', owner: agentId });
          await addNote(t.id, 'Recovered due to agent health failure after restart attempts exhausted.', 'autopilot');
          await addEvent({ taskId: t.id, type: 'task_recovered', message: 'agent_unhealthy', actor: 'autopilot' });
          await createTaskRecoveryAction({ taskId: t.id, agentId, result: 'recovered', idempotencyKey });
          recovered.push({ task_id: t.id, agent_id: agentId, from: 'in_progress', to: 'assigned', idempotency_key: idempotencyKey });
        }
      }

      return send(res, 200, { ok: true, recovered_count: recovered.length, recovered, skipped_count: skipped.length, skipped });
    }

    if (url.pathname === '/api/plans' && req.method === 'GET') {
      const plans = await listServicePlans();
      const tenantPlan = await getTenantPlan(accessCtx.tenantId);
      return send(res, 200, { ok: true, plans: plans.map((p) => ({ ...p, features: JSON.parse(p.featuresJson || '{}') })), tenantPlan: tenantPlan ? { ...tenantPlan, limits: JSON.parse(tenantPlan.limitsJson || '{}') } : null });
    }

    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const period = String(url.searchParams.get('period') || '24h');
      const usage = await getUsageSummary({ tenantId: accessCtx.tenantId, period });
      return send(res, 200, { ok: true, ...usage });
    }

    if (url.pathname === '/api/teams/catalog' && req.method === 'GET') {
      const tenantPlan = await getTenantPlan(accessCtx.tenantId);
      const plan = tenantPlan ? await getServicePlan(tenantPlan.planKey) : await getServicePlan('professional');
      const all = await listTeamTemplates();
      const rank = { starter: 1, professional: 2, enterprise: 3 };
      const current = rank[plan?.planKey || 'professional'] || 2;
      const items = all
        .filter((t) => !t.planKey || (rank[t.planKey] || 1) <= current)
        .map((t) => {
          const parsed = JSON.parse(t.templateJson || '{}');
          const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
          return {
            team_key: t.name,
            description: `${t.name} template`,
            agents_included: agents.map((a) => a.agentId),
            min_plan: t.planKey || 'starter',
            features: parsed.defaults || {},
            default_wip: parsed.defaults?.wip_limit_in_progress || null,
            max_agents: agents.length
          };
        });
      return send(res, 200, { ok: true, tenantId: accessCtx.tenantId, planKey: plan?.planKey || 'professional', teams: items });
    }

    if (url.pathname === '/api/teams' && req.method === 'GET') {
      const teams = await listTenantTeams(accessCtx.tenantId);
      const agents = await listTenantAgents(accessCtx.tenantId);
      return send(res, 200, { ok: true, tenantId: accessCtx.tenantId, teams, agents });
    }

    if (url.pathname === '/api/teams/activate' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_admin', 'tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const teamKey = String(body.teamKey || '').trim();
      if (!teamKey) return send(res, 400, { error: 'validation_failed', details: ['teamKey required'] });

      const tpl = await getTeamTemplate(teamKey);
      if (!tpl) return send(res, 404, { error: 'team_template_not_found' });

      const tenantPlan = await getTenantPlan(accessCtx.tenantId);
      const plan = tenantPlan ? await getServicePlan(tenantPlan.planKey) : await getServicePlan('professional');
      const rank = { starter: 1, professional: 2, enterprise: 3 };
      if (tpl.planKey && (rank[plan?.planKey || 'professional'] || 2) < (rank[tpl.planKey] || 1)) {
        return send(res, 403, { error: 'team_not_allowed_for_plan', planKey: plan?.planKey, required: tpl.planKey });
      }

      const activeTeams = await countActiveTenantTeams(accessCtx.tenantId);
      const maxTeams = Number(plan?.maxTeams || 1);
      if (activeTeams >= maxTeams) return send(res, 409, { error: 'team_limit_exceeded', limit: maxTeams, current: activeTeams });

      const parsed = JSON.parse(tpl.templateJson || '{}');
      const desired = (Array.isArray(parsed.agents) ? parsed.agents : []);
      const currentAgents = await listTenantAgents(accessCtx.tenantId);
      const currentSet = new Set(currentAgents.map((a) => a.agentId));
      const maxAgents = Number(plan?.maxAgents || 2);
      const remainingSlots = Math.max(0, maxAgents - currentAgents.length);
      const toSeed = desired.filter((a) => !currentSet.has(a.agentId)).slice(0, remainingSlots);
      if (toSeed.length < desired.filter((a) => !currentSet.has(a.agentId)).length) return send(res, 409, { error: 'agent_limit_exceeded', limit: maxAgents, current: currentAgents.length });

      for (const a of toSeed) await addTenantAgent({ tenantId: accessCtx.tenantId, agentId: a.agentId, role: a.role || 'agent', enabled: a.enabled ?? 1 });
      for (const a of desired) await setTenantAgentEnabled({ tenantId: accessCtx.tenantId, agentId: a.agentId, enabled: 1 });
      await upsertTenantTeam({ tenantId: accessCtx.tenantId, teamKey, status: 'active' });
      await recordUsageEvent({ tenantId: accessCtx.tenantId, teamKey, eventType: 'team_activated', computeMs: 10 });
      return send(res, 200, { ok: true, teamKey, status: 'active', agentsAdded: toSeed.length });
    }

    if (url.pathname === '/api/teams/deactivate' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, ['tenant_admin', 'tenant_ops'])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const teamKey = String(body.teamKey || '').trim();
      if (!teamKey) return send(res, 400, { error: 'validation_failed', details: ['teamKey required'] });
      const tpl = await getTeamTemplate(teamKey);
      if (!tpl) return send(res, 404, { error: 'team_template_not_found' });
      const parsed = JSON.parse(tpl.templateJson || '{}');
      const teamAgents = (Array.isArray(parsed.agents) ? parsed.agents : []).map((a) => a.agentId);

      const tasks = await listTasks();
      const activeTasks = tasks.filter((t) => teamAgents.includes(t.owner) && ['in_progress','assigned','review'].includes(t.status));
      if (activeTasks.length > 0) return send(res, 409, { error: 'team_has_active_tasks', activeTaskCount: activeTasks.length });

      for (const agentId of teamAgents) await setTenantAgentEnabled({ tenantId: accessCtx.tenantId, agentId, enabled: 0 });
      await upsertTenantTeam({ tenantId: accessCtx.tenantId, teamKey, status: 'inactive' });
      await recordUsageEvent({ tenantId: accessCtx.tenantId, teamKey, eventType: 'team_deactivated', computeMs: 10 });
      return send(res, 200, { ok: true, teamKey, status: 'inactive', agentsDisabled: teamAgents.length });
    }

    if (url.pathname === '/api/tenant/signup' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const companyName = String(body.companyName || '').trim();
      const adminEmail = String(body.adminEmail || '').trim().toLowerCase();
      const planKey = String(body.planKey || 'starter').trim();
      if (!companyName || !adminEmail || !planKey) return send(res, 400, { error: 'validation_failed', details: ['companyName, adminEmail, planKey required'] });

      const tenantId = String(body.tenantId || companyName.toLowerCase().replace(/[^a-z0-9]+/g, '_')).replace(/^_+|_+$/g, '').slice(0, 64);
      if (!tenantId || !/^[a-z0-9_-]{2,64}$/i.test(tenantId)) return send(res, 400, { error: 'validation_failed', details: ['invalid tenant id derived'] });

      const plan = await getServicePlan(planKey);
      if (!plan) return send(res, 400, { error: 'invalid_plan' });

      const userId = `user_${adminEmail.replace(/[^a-z0-9]/g, '_').slice(0, 40)}`;
      await addTenantUser({ tenantId, userId, email: adminEmail, role: 'tenant_admin' });

      const rec = await createOnboardingRecord({ tenantId, requestedPlan: planKey, requestedTeamType: plan.defaultTeamTemplate || 'general_team', createdBy: adminEmail, notes: `self_serve:${companyName}` });
      await updateOnboardingStatus({ id: rec.id, status: 'provisioning' });

      const tpl = await getTeamTemplate(plan.defaultTeamTemplate || 'general_team');
      const template = tpl ? JSON.parse(tpl.templateJson || '{}') : { agents: ['ultron','ops','codi','scout'].map((agentId) => ({ agentId, role: 'agent', enabled: 1 })) };
      const seeded = (Array.isArray(template.agents) ? template.agents : []).slice(0, Number(plan.maxAgents || 2));
      for (const a of seeded) await addTenantAgent({ tenantId, agentId: a.agentId, role: a.role || 'agent', enabled: a.enabled ?? 1 });

      const sub = await upsertSubscription({ tenantId, planKey, status: 'trial', billingProvider: 'manual', providerCustomerId: `cust_${tenantId}` });
      await setTenantPlan({ tenantId, planKey, subscriptionId: sub?.id || null, status: 'trial', activatedAt: now(), limits: { max_teams: plan.maxTeams, max_agents: plan.maxAgents, max_wip: plan.maxWip, max_tasks: plan.maxTasks } });
      await updateOnboardingStatus({ id: rec.id, status: 'ready_for_validation' });

      const team = await listTenantAgents(tenantId);
      const checks = { tenant_id_valid: true, team_seeded: team.length > 0, tenant_plan_assigned: true, report_write_path_ready: true, canary_ready: true };
      await updateOnboardingStatus({ id: rec.id, status: 'active', activatedAt: now(), validation: checks });
      await updateSubscriptionStatus({ tenantId, status: 'active' });
      const tenantUsers = await listTenantUsers(tenantId);

      await addEvent({ type: 'tenant_signup', message: `${tenantId} plan=${planKey}`, actor: 'self_serve' });
      return send(res, 200, { ok: true, tenantId, onboardingId: rec.id, planKey, subscriptionId: sub?.id || null, status: 'active', tenantAdmin: { userId, email: adminEmail }, seededAgents: seeded.map((a) => a.agentId), tenantUsers: tenantUsers.length });
    }

    if (url.pathname === '/api/onboarding/request' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, [])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const tenantId = String(body.tenantId || '').trim();
      if (!tenantId || !/^[a-z0-9_-]{2,64}$/i.test(tenantId)) return send(res, 400, { error: 'validation_failed', details: ['valid tenantId required'] });
      const requestedPlan = body.requestedPlan || 'starter';
      const plan = await getServicePlan(requestedPlan);
      if (!plan) return send(res, 400, { error: 'invalid_plan' });

      const rec = await createOnboardingRecord({
        tenantId,
        requestedPlan,
        requestedTeamType: body.requestedTeamType || (plan.defaultTeamTemplate || 'general_team'),
        createdBy: body.createdBy || accessCtx.userId || 'platform_admin',
        notes: body.notes || ''
      });
      await addEvent({ type: 'onboarding_requested', message: `${rec.id} tenant=${tenantId}`, actor: 'platform_admin' });
      return send(res, 200, { ok: true, onboardingId: rec.id, tenantId, status: 'requested', createdAt: rec.createdAt });
    }

    if (url.pathname === '/api/onboarding/provision' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, [])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const id = String(body.onboardingId || '').trim();
      if (!id) return send(res, 400, { error: 'validation_failed', details: ['onboardingId is required'] });
      const ob = await getOnboardingRecord(id);
      if (!ob) return send(res, 404, { error: 'onboarding_not_found' });

      await updateOnboardingStatus({ id, status: 'provisioning' });
      const plan = await getServicePlan(ob.requestedPlan || 'starter');
      if (!plan) {
        await updateOnboardingStatus({ id, status: 'failed', notes: 'invalid requested plan' });
        return send(res, 400, { error: 'invalid_plan' });
      }

      const tpl = await getTeamTemplate(ob.requestedTeamType || plan.defaultTeamTemplate || 'general_team');
      const template = tpl ? JSON.parse(tpl.templateJson || '{}') : {
        agents: ['ultron', 'ops', 'codi', 'scout'].map((agentId) => ({ agentId, role: 'agent', enabled: 1 }))
      };
      const seeded = (Array.isArray(template.agents) ? template.agents : []).slice(0, Number(plan.maxAgents || 4));
      for (const a of seeded) {
        await addTenantAgent({ tenantId: ob.tenantId, agentId: a.agentId, role: a.role || 'agent', enabled: a.enabled ?? 1 });
      }

      const sub = await upsertSubscription({
        tenantId: ob.tenantId,
        planKey: plan.planKey,
        status: 'trial',
        billingProvider: 'manual'
      });

      await setTenantPlan({
        tenantId: ob.tenantId,
        planKey: plan.planKey,
        subscriptionId: sub?.id || null,
        status: 'trial',
        activatedAt: now(),
        limits: { max_teams: plan.maxTeams, max_agents: plan.maxAgents, max_wip: plan.maxWip, max_tasks: plan.maxTasks }
      });

      await updateOnboardingStatus({ id, status: 'ready_for_validation' });
      await addEvent({ type: 'onboarding_provisioned', message: `${id} tenant=${ob.tenantId} plan=${plan.planKey} agents=${seeded.length}`, actor: 'platform_admin' });
      return send(res, 200, { ok: true, onboardingId: id, tenantId: ob.tenantId, status: 'ready_for_validation', planKey: plan.planKey, seededAgents: seeded.map((a) => a.agentId) });
    }

    if (url.pathname === '/api/onboarding/validate' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, [])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const id = String(body.onboardingId || '').trim();
      if (!id) return send(res, 400, { error: 'validation_failed', details: ['onboardingId is required'] });
      const ob = await getOnboardingRecord(id);
      if (!ob) return send(res, 404, { error: 'onboarding_not_found' });

      const team = await listTenantAgents(ob.tenantId);
      const tenantPlan = await getTenantPlan(ob.tenantId);
      const checks = {
        tenant_id_valid: /^[a-z0-9_-]{2,64}$/i.test(ob.tenantId),
        team_seeded: team.length > 0,
        tenant_plan_assigned: !!tenantPlan,
        report_write_path_ready: true,
        canary_ready: true
      };
      const pass = Object.values(checks).every(Boolean);

      if (pass) {
        const tp = await getTenantPlan(ob.tenantId);
        if (tp?.planKey) {
          await setTenantPlan({ tenantId: ob.tenantId, planKey: tp.planKey, subscriptionId: tp.subscriptionId || null, status: 'active', activatedAt: now(), limits: JSON.parse(tp.limitsJson || '{}') });
          await updateSubscriptionStatus({ tenantId: ob.tenantId, status: 'active' });
        }
        await updateOnboardingStatus({ id, status: 'active', activatedAt: now(), validation: checks });
        await addEvent({ type: 'onboarding_active', message: `${id} tenant=${ob.tenantId}`, actor: 'platform_admin' });
        return send(res, 200, { ok: true, onboardingId: id, tenantId: ob.tenantId, status: 'active', checks });
      }

      await updateOnboardingStatus({ id, status: 'failed', validation: checks, notes: 'validation_failed' });
      return send(res, 200, { ok: false, onboardingId: id, tenantId: ob.tenantId, status: 'failed', checks });
    }

    if (url.pathname.startsWith('/api/onboarding/') && req.method === 'GET') {
      if (!canAccess(accessCtx.role, [])) return send(res, 403, { error: 'forbidden_role' });
      const id = url.pathname.split('/')[3];
      const ob = await getOnboardingRecord(id);
      if (!ob) return send(res, 404, { error: 'onboarding_not_found' });
      return send(res, 200, { ok: true, onboarding: ob });
    }

    if (url.pathname === '/api/billing/webhook' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      if (!canAccess(accessCtx.role, [])) return send(res, 403, { error: 'forbidden_role' });
      const body = await parseBody(req);
      const tenantId = String(body.tenantId || '').trim();
      const eventType = String(body.eventType || '').trim();
      const nextStatus = String(body.status || '').trim();
      if (!tenantId || !eventType || !nextStatus) return send(res, 400, { error: 'validation_failed', details: ['tenantId,eventType,status required'] });

      const allowed = new Set(['trial','active','past_due','suspended','canceled']);
      if (!allowed.has(nextStatus)) return send(res, 400, { error: 'invalid_status' });

      const tp = await getTenantPlan(tenantId);
      const planKey = tp?.planKey || 'professional';
      const sub = await upsertSubscription({
        tenantId,
        planKey,
        status: nextStatus,
        billingProvider: body.billingProvider || 'manual',
        providerCustomerId: body.providerCustomerId || null,
        providerSubscriptionId: body.providerSubscriptionId || null,
        currentPeriodStart: body.currentPeriodStart || null,
        currentPeriodEnd: body.currentPeriodEnd || null
      });

      await setTenantPlan({
        tenantId,
        planKey,
        subscriptionId: sub?.id || tp?.subscriptionId || null,
        status: nextStatus,
        activatedAt: tp?.activatedAt || now(),
        limits: tp ? JSON.parse(tp.limitsJson || '{}') : {}
      });

      await addEvent({ type: 'billing_webhook', message: `${eventType} tenant=${tenantId} status=${nextStatus}`, actor: 'billing' });
      return send(res, 200, { ok: true, tenantId, status: nextStatus });
    }

    if (url.pathname === '/api/task/assign' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const lifecycle = await assertTenantLifecycleWriteAllowed(accessCtx.tenantId);
      if (!lifecycle.ok) return send(res, 403, lifecycle);
      const body = await parseBody(req);
      if (!body.taskId || !Array.isArray(body.agentIds) || body.agentIds.length === 0) {
        return send(res, 400, { error: 'validation_failed', details: ['taskId and non-empty agentIds[] required'] });
      }
      for (const id of body.agentIds) await assignTask(body.taskId, id);
      await addEvent({ type: 'task_assigned', message: `${body.taskId} assigned to ${body.agentIds.join(', ')}`, taskId: body.taskId, actor: body.actor || 'ui' });
      await recordUsageEvent({ tenantId: accessCtx.tenantId, agentId: body.agentIds[0], eventType: 'task_execution', taskId: body.taskId, tokensUsed: 5, computeMs: 10 });
      return send(res, 200, { ok: true, taskId: body.taskId, assigned: body.agentIds.length });
    }

    if (url.pathname === '/api/task/claim-next' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const lifecycle = await assertTenantLifecycleWriteAllowed(accessCtx.tenantId);
      if (!lifecycle.ok) return send(res, 403, lifecycle);
      const body = await parseBody(req);
      const agentId = String(body.agentId || '').trim();
      if (!agentId) return send(res, 400, { error: 'validation_failed', details: ['agentId required'] });
      if (agentId === 'ultron') return send(res, 409, { error: 'invalid_owner_role', owner: 'ultron', disallowedStates: ['assigned', 'in_progress'] });

      const existingWip = await listTasks();
      const current = existingWip.find((t) => t.owner === agentId && t.status === 'in_progress');
      if (current) return send(res, 200, { ok: true, claimed: false, task: current, reason: 'already_in_progress' });

      const candidate = await claimNext(agentId);
      if (!candidate) return send(res, 404, { error: 'no_assigned_task_available', agentId });

      const ownerInProgress = await countTasksByOwnerAndStatus(agentId, 'in_progress', candidate.id);
      if (ownerInProgress >= 1) return send(res, 409, { error: 'wip_limit_exceeded', scope: 'owner_in_progress', owner: agentId, limit: 1, current: ownerInProgress });

      const tenantPlan = await getTenantPlan(accessCtx.tenantId);
      const planLimits = tenantPlan ? JSON.parse(tenantPlan.limitsJson || '{}') : {};
      const maxWipGlobal = Number(planLimits.max_wip || 4);
      const globalInProgress = await countTasksByStatus('in_progress', candidate.id);
      if (globalInProgress >= maxWipGlobal) return send(res, 409, { error: 'wip_limit_exceeded', scope: 'global_in_progress', limit: maxWipGlobal, current: globalInProgress });

      const moved = await updateTask({ id: candidate.id, status: 'in_progress', owner: agentId });
      await addEvent({ type: 'task_claimed', message: `${candidate.id} claimed by ${agentId}`, taskId: candidate.id, actor: body.actor || agentId });
      await recordUsageEvent({ tenantId: accessCtx.tenantId, agentId, eventType: 'task_execution', taskId: candidate.id, tokensUsed: 5, computeMs: 15 });
      return send(res, 200, { ok: true, claimed: true, task: { id: moved.id, title: moved.title, status: moved.status, owner: moved.owner, priority: moved.priority } });
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
      const lifecycle = await assertTenantLifecycleWriteAllowed(accessCtx.tenantId);
      if (!lifecycle.ok) return send(res, 403, lifecycle);
      const body = await parseBody(req);
      const validation = validateTaskCreate(body);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const targetStatus = body.status || 'inbox';
      const targetOwner = body.owner || (targetStatus === 'inbox' ? 'ops' : 'unassigned');
      if (targetStatus === 'inbox' && targetOwner !== 'ops') {
        await logEvent('task_transition_denied', `create denied -> inbox with owner ${targetOwner} (must be ops)`, null, body.actor || 'ui');
        return send(res, 409, { error: 'inbox_owner_must_be_ops', requiredOwner: 'ops', status: 'inbox' });
      }

      const task = {
        id: `mcl-${randomUUID().slice(0, 8)}`,
        title: body.title.trim(),
        status: targetStatus,
        priority: body.priority || 'p2',
        owner: targetOwner,
        createdAt: now(),
        updatedAt: now()
      };
      await createTask(task);
      await logEvent('task_created', `${task.owner} created ${task.id}: ${task.title}`, task.id, task.owner);
      await recordUsageEvent({ tenantId: accessCtx.tenantId, agentId: task.owner, eventType: 'task_execution', taskId: task.id, tokensUsed: 50, computeMs: 100 });
      return send(res, 200, { ok: true, task });
    }

    if (url.pathname === '/api/task/update' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const lifecycle = await assertTenantLifecycleWriteAllowed(accessCtx.tenantId);
      if (!lifecycle.ok) return send(res, 403, lifecycle);
      const patch = await parseBody(req);
      const validation = validateTaskUpdate(patch);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const existing = await getTaskById(patch.id);
      if (!existing) return send(res, 404, { error: 'task not found' });

      const targetStatus = patch.status || existing.status;
      const targetOwner = patch.owner || existing.owner;
      const actor = String(patch.actor || 'ui');

      if (existing.status === 'review' && targetStatus === 'done' && actor !== 'ultron') {
        await logEvent('task_transition_denied', `${patch.id} denied review->done by ${actor} (actor_not_allowed)`, patch.id, actor);
        return send(res, 403, { error: 'actor_not_allowed', from: 'review', to: 'done', allowed: ['ultron'] });
      }

      if (existing.status === 'review' && targetStatus === 'assigned' && !['ultron','ops'].includes(actor)) {
        await logEvent('task_transition_denied', `${patch.id} denied review->assigned by ${actor} (actor_not_allowed)`, patch.id, actor);
        return send(res, 403, { error: 'actor_not_allowed', from: 'review', to: 'assigned', allowed: ['ultron','ops'] });
      }

      if (existing.status === 'assigned' && targetStatus === 'starting' && !['ops','autopilot'].includes(actor)) {
        await logEvent('task_transition_denied', `${patch.id} denied assigned->starting by ${actor} (actor_not_allowed)`, patch.id, actor);
        return send(res, 403, { error: 'actor_not_allowed', from: 'assigned', to: 'starting', allowed: ['ops','autopilot'] });
      }

      if (existing.status === 'starting' && !['starting', 'in_progress', 'assigned'].includes(targetStatus)) {
        await logEvent('task_transition_denied', `${patch.id} denied starting->${targetStatus} (invalid_transition)`, patch.id, actor);
        return send(res, 409, { error: 'invalid_transition', from: 'starting', to: targetStatus });
      }

      if (existing.status === 'starting' && targetStatus === 'assigned' && !['ops','autopilot'].includes(actor)) {
        await logEvent('task_transition_denied', `${patch.id} denied starting->assigned by ${actor} (actor_not_allowed)`, patch.id, actor);
        return send(res, 403, { error: 'actor_not_allowed', from: 'starting', to: 'assigned', allowed: ['ops','autopilot'] });
      }

      if (existing.status === 'starting' && targetStatus === 'in_progress') {
        if (actor !== existing.owner) {
          await logEvent('task_transition_denied', `${patch.id} denied starting->in_progress by ${actor} (actor_not_allowed owner=${existing.owner})`, patch.id, actor);
          return send(res, 403, { error: 'actor_not_allowed', from: 'starting', to: 'in_progress', allowed: [existing.owner] });
        }
        const ack = await hasWorkerStartAck(patch.id, existing.owner);
        if (!ack) {
          await logEvent('task_transition_denied', `${patch.id} denied starting->in_progress by ${actor} (missing_worker_ack)`, patch.id, actor);
          return send(res, 409, { error: 'missing_worker_ack', taskId: patch.id, owner: existing.owner });
        }
      }

      if (targetStatus === 'inbox' && targetOwner !== 'ops') {
        await logEvent('task_transition_denied', `${patch.id} denied -> inbox with owner ${targetOwner} (must be ops)`, patch.id, patch.actor || 'ui');
        return send(res, 409, { error: 'inbox_owner_must_be_ops', requiredOwner: 'ops', status: 'inbox' });
      }
      if (targetOwner === 'ultron' && (targetStatus === 'assigned' || targetStatus === 'in_progress')) {
        await logEvent('task_transition_denied', `${patch.id} denied -> ${targetStatus} with owner ultron (execution states not allowed)`, patch.id, patch.actor || 'ui');
        return send(res, 409, { error: 'invalid_owner_role', owner: 'ultron', disallowedStates: ['assigned', 'in_progress'] });
      }

      const tenantPlan = await getTenantPlan(accessCtx.tenantId);
      const planLimits = tenantPlan ? JSON.parse(tenantPlan.limitsJson || '{}') : {};
      const maxWipGlobal = Number(planLimits.max_wip || 4);

      // Hard WIP guardrails (control-plane policy)
      if (targetStatus === 'in_progress' && existing.status !== 'in_progress') {
        const globalInProgress = await countTasksByStatus('in_progress', patch.id);
        if (globalInProgress >= maxWipGlobal) {
          await logEvent('task_transition_denied', `${patch.id} denied -> in_progress (global_wip_cap reached: ${globalInProgress}/${maxWipGlobal})`, patch.id, patch.actor || 'ui');
          return send(res, 409, { error: 'wip_limit_exceeded', scope: 'global_in_progress', limit: maxWipGlobal, current: globalInProgress });
        }
        const ownerInProgress = await countTasksByOwnerAndStatus(targetOwner, 'in_progress', patch.id);
        if (ownerInProgress >= 1) {
          await logEvent('task_transition_denied', `${patch.id} denied -> in_progress for ${targetOwner} (agent_wip_cap reached: ${ownerInProgress}/1)`, patch.id, patch.actor || 'ui');
          return send(res, 409, { error: 'wip_limit_exceeded', scope: 'owner_in_progress', owner: targetOwner, limit: 1, current: ownerInProgress });
        }
      }

      if (targetStatus === 'review' && existing.status !== 'review') {
        const reviewCount = await countTasksByStatus('review', patch.id);
        if (reviewCount >= 3) {
          await logEvent('task_transition_denied', `${patch.id} denied -> review (review_cap reached: ${reviewCount}/3)`, patch.id, patch.actor || 'ui');
          return send(res, 409, { error: 'wip_limit_exceeded', scope: 'global_review', limit: 3, current: reviewCount });
        }
      }

      const t = await updateTask({
        id: patch.id,
        status: patch.status,
        owner: patch.owner,
        priority: patch.priority && VALID_PRIORITY.includes(patch.priority) ? patch.priority : undefined
      });

      await logEvent('task_updated', `${t.id} -> ${t.status} (${t.owner})`, t.id, patch.actor || 'ui');
      await recordUsageEvent({ tenantId: accessCtx.tenantId, agentId: t.owner, eventType: t.status === 'done' ? 'task_completed' : 'task_execution', taskId: t.id, tokensUsed: 25, computeMs: 60 });
      return send(res, 200, { ok: true, task: {
        id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner, updatedAt: t.updated_at
      }});
    }

    if (url.pathname === '/api/task/note' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const body = await parseBody(req);
      const existing = await getTaskById(body.id);
      if (!existing) return send(res, 404, { error: 'task not found' });
      await addNote(body.id, body.note || '', body.actor || 'ui');
      await logEvent('task_note', `${body.id}: ${body.note || ''}`, body.id, body.actor || 'ui');
      await recordUsageEvent({ tenantId: accessCtx.tenantId, agentId: body.actor || 'ui', eventType: 'analysis', taskId: body.id, tokensUsed: 10, computeMs: 20 });
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
      const tasks = await listTasks();
      const text = getStandup(tasks);
      const nowMs = Date.now();
      const toMs = (v) => {
        const d = new Date(v || 0).getTime();
        return Number.isFinite(d) ? d : 0;
      };
      const lastActivityMs = (t) => toMs(t.lastActivityAt || t.updatedAt || t.createdAt);
      const snapshot = {
        counts: tasks.reduce((acc, t) => {
          acc[t.status] = (acc[t.status] || 0) + 1;
          return acc;
        }, {}),
        total: tasks.length,
        stale_bins: {
          assigned_gt_24h: tasks.filter((t) => t.status === 'assigned' && (nowMs - lastActivityMs(t)) > 24 * 60 * 60 * 1000).length,
          in_progress_gt_8h: tasks.filter((t) => t.status === 'in_progress' && (nowMs - lastActivityMs(t)) > 8 * 60 * 60 * 1000).length,
          review_gt_12h: tasks.filter((t) => t.status === 'review' && (nowMs - lastActivityMs(t)) > 12 * 60 * 60 * 1000).length
        }
      };
      const runId = `standup-${Date.now()}`;
      const rec = await createStandupRecord({
        tenantId: process.env.MCL_TENANT_ID || 'default',
        content: text,
        snapshot,
        runId
      });
      await logEvent('standup', `Generated standup report ${rec.id}`);
      return send(res, 200, { ok: true, standupId: rec.id, generatedAt: rec.generatedAt, standup: text, snapshot });
    }

    if (url.pathname === '/api/report/weekly' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read_only_mode' });
      const events = await listEvents(5000);
      const nowDate = new Date();
      const day = nowDate.getUTCDay();
      const mondayOffset = (day + 6) % 7;
      const weekStartDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - mondayOffset, 0, 0, 0));
      const weekStart = weekStartDate.toISOString();

      const inWindow = events.filter((e) => new Date(e.at).getTime() >= weekStartDate.getTime());
      const countType = (type) => inWindow.filter((e) => e.type === type).length;

      const metrics = {
        tasks_created: countType('task_created'),
        tasks_completed: countType('task_updated_done') + inWindow.filter((e) => e.type === 'task_updated' && String(e.message || '').includes('-> done')).length,
        tasks_reopened: inWindow.filter((e) => e.type === 'task_updated' && String(e.message || '').includes('done') && !String(e.message || '').includes('-> done')).length,
        tasks_blocked: inWindow.filter((e) => e.type === 'task_updated' && String(e.message || '').includes('-> blocked')).length,
        recovery_events: countType('task_recovered'),
        restart_events: inWindow.filter((e) => e.type === 'heartbeat' && String(e.message || '').includes('restart')).length
      };

      const byActor = inWindow.reduce((acc, e) => {
        const k = e.actor || 'unknown';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});

      const snapshot = {
        week_start: weekStart,
        event_count: inWindow.length,
        metrics,
        agent_utilization: byActor,
        cycle_time: null,
        lead_time: null
      };

      const content = [
        `# WEEKLY THROUGHPUT REPORT — ${weekStart.slice(0, 10)}`,
        '',
        `- Tasks created: ${metrics.tasks_created}`,
        `- Tasks completed: ${metrics.tasks_completed}`,
        `- Tasks reopened: ${metrics.tasks_reopened}`,
        `- Tasks blocked: ${metrics.tasks_blocked}`,
        `- Recovery events: ${metrics.recovery_events}`,
        `- Restart events: ${metrics.restart_events}`,
        '',
        '## Agent Utilization (event counts)',
        ...Object.entries(byActor).map(([actor, n]) => `- ${actor}: ${n}`)
      ].join('\n');

      const rec = await createWeeklyReportRecord({
        tenantId: process.env.MCL_TENANT_ID || 'default',
        weekStart,
        content,
        snapshot
      });

      await logEvent('weekly_report_generated', `Generated weekly report ${rec.id}`, null, 'autopilot');
      return send(res, 200, { ok: true, reportId: rec.id, generatedAt: rec.generatedAt, weekStart, snapshot, content });
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
  });
}
