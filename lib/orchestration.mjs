import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const POLICY_PATH = join(process.cwd(), 'orchestration', 'policies.json');

export function loadPolicies() {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
}

export function buildOrchestrationPlan({ taskId, template, title = '' }) {
  const policy = loadPolicies();
  const def = policy.templates?.[template];
  if (!def) throw new Error(`unknown template: ${template}`);

  const maxWorkers = Math.min(def.maxWorkers ?? policy.defaults.maxWorkers ?? 3, def.workers.length);
  const workers = def.workers.slice(0, maxWorkers);

  return {
    version: policy.version,
    taskId,
    template,
    title,
    orchestrator: policy.defaults.orchestrator,
    singleWriter: policy.defaults.singleWriter,
    timeoutMinutes: def.timeoutMinutes ?? policy.defaults.timeoutMinutes,
    requireEvidence: policy.defaults.requireEvidence,
    workers,
    evidence: def.evidence || []
  };
}
