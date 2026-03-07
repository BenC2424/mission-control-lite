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
  createOnboardingRecord,
  getOnboardingRecord,
  updateOnboardingStatus,
  listServicePlans,
  getServicePlan,
  setTenantPlan,
  getTenantPlan,
  upsertSubscription,
  updateSubscriptionStatus,
  getSubscriptionByTenant
} from './lib/db.mjs';
import { loadPolicies, buildOrchestrationPlan } from './lib/orchestration.mjs';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const READ_ONLY = ['1','true','yes','on'].includes(String(process.env.READ_ONLY || '').trim().toLowerCase());

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

const DEFAULT_TENANT_ID = process.env.MCL_TENANT_ID || 'internal';
const VALID_ROLES = new Set(['tenant_user', 'tenant_ops', 'platform_admin']);

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

    if (url.pathname === '/api/heartbeat/run' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.agentId) return send(res, 400, { error: 'validation_failed', details: ['agentId is required'] });
      await recordHeartbeat(body.agentId, body.status || 'ok', body.summary || '');
      return send(res, 200, { ok: true });
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

    if (url.pathname === '/api/autopilot/board-health' && req.method === 'GET') {
      const tasks = await listTasks();
      const nowMs = Date.now();
      const toMs = (v) => {
        const d = new Date(v || 0).getTime();
        return Number.isFinite(d) ? d : 0;
      };
      const lastActivityMs = (t) => toMs(t.lastActivityAt || t.updatedAt || t.createdAt);

      const byStatus = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
      const byOwner = tasks.reduce((acc, t) => { acc[t.owner] = (acc[t.owner] || 0) + 1; return acc; }, {});
      const tenantTeam = await listTenantAgents();
      const teamIds = new Set(tenantTeam.map((a) => a.agentId));
      const teamWip = tasks.filter((t) => teamIds.has(t.owner)).reduce((acc, t) => {
        if (!acc[t.owner]) acc[t.owner] = { in_progress: 0, assigned: 0, review: 0 };
        if (t.status === 'in_progress') acc[t.owner].in_progress += 1;
        if (t.status === 'assigned') acc[t.owner].assigned += 1;
        if (t.status === 'review') acc[t.owner].review += 1;
        return acc;
      }, {});

      const assignedStale = tasks.filter((t) => t.status === 'assigned' && (nowMs - lastActivityMs(t)) > 24 * 60 * 60 * 1000).length;
      const inProgressStale = tasks.filter((t) => t.status === 'in_progress' && (nowMs - lastActivityMs(t)) > 8 * 60 * 60 * 1000).length;
      const reviewStale = tasks.filter((t) => t.status === 'review' && (nowMs - lastActivityMs(t)) > 12 * 60 * 60 * 1000).length;

      const inProgressTotal = byStatus.in_progress || 0;
      const reviewTotal = byStatus.review || 0;

      return send(res, 200, {
        ok: true,
        generated_at: now(),
        open_total: tasks.filter((t) => t.status !== 'done' && t.status !== 'archived').length,
        in_progress_total: inProgressTotal,
        review_total: reviewTotal,
        blocked_total: byStatus.blocked || 0,
        by_status: byStatus,
        by_owner: byOwner,
        tenant_team: tenantTeam.map((a) => ({ agent_id: a.agentId, role: a.role })),
        team_wip: teamWip,
        stale_bins: {
          assigned_gt_24h: assignedStale,
          in_progress_gt_8h: inProgressStale,
          review_gt_12h: reviewStale
        },
        review_pressure: reviewTotal > 3 ? 'high' : reviewTotal > 1 ? 'medium' : 'low',
        wip_pressure: inProgressTotal > 4 ? 'high' : inProgressTotal > 2 ? 'medium' : 'low'
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
        limits: { max_agents: plan.maxAgents, max_wip: plan.maxWip, max_tasks: plan.maxTasks }
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
      const lifecycle = await assertTenantLifecycleWriteAllowed(accessCtx.tenantId);
      if (!lifecycle.ok) return send(res, 403, lifecycle);
      const body = await parseBody(req);
      const validation = validateTaskCreate(body);
      if (!validation.ok) return send(res, 400, { error: 'validation_failed', details: validation.errors });

      const task = {
        id: `mcl-${randomUUID().slice(0, 8)}`,
        title: body.title.trim(),
        status: body.status || 'inbox',
        priority: body.priority || 'p2',
        owner: body.owner || 'unassigned',
        createdAt: now(),
        updatedAt: now()
      };
      await createTask(task);
      await logEvent('task_created', `${task.owner} created ${task.id}: ${task.title}`, task.id, task.owner);
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
