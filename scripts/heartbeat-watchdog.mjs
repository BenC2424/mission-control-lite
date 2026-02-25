#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.MCL_BASE_URL || 'http://127.0.0.1:8787';
const policyPath = join(process.cwd(), 'config', 'alert-policy.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

function minutesSince(ts) {
  return (Date.now() - new Date(ts).getTime()) / 60000;
}

const res = await fetch(`${base}/api/metrics`);
if (!res.ok) {
  console.error(`ALERT: metrics endpoint failed (${res.status})`);
  process.exit(2);
}
const metrics = await res.json();

const alerts = [];

for (const agentId of policy.agents) {
  const latest = (metrics.latestHeartbeats || []).find((h) => h.agentId === agentId);
  if (!latest) {
    alerts.push(`missing heartbeat history for ${agentId}`);
    continue;
  }
  const age = minutesSince(latest.at);
  if (age > policy.heartbeatMaxAgeMinutes) {
    alerts.push(`${agentId} heartbeat stale: ${Math.round(age)}m > ${policy.heartbeatMaxAgeMinutes}m`);
  }

  const streak = (metrics.latestHeartbeats || [])
    .filter((h) => h.agentId === agentId)
    .slice(0, policy.maxNoActionableStreak)
    .filter((h) => String(h.summary || '').includes('no_actionable_tasks')).length;
  if (streak >= policy.maxNoActionableStreak) {
    alerts.push(`${agentId} no_actionable streak ${streak}/${policy.maxNoActionableStreak}`);
  }
}

if ((metrics.escalationCount || 0) > policy.maxEscalations) {
  alerts.push(`escalations ${metrics.escalationCount} > ${policy.maxEscalations}`);
}
if ((metrics.staleOpen || 0) > policy.maxStaleOpen) {
  alerts.push(`staleOpen ${metrics.staleOpen} > ${policy.maxStaleOpen}`);
}

if (alerts.length) {
  console.log(`ALERT: Mission Control watchdog triggered\n- ${alerts.join('\n- ')}`);
  process.exit(2);
}

console.log('WATCHDOG_OK: heartbeat and workflow thresholds healthy');
