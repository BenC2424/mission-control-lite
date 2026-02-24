#!/usr/bin/env node
const agentId = process.argv[2];
if (!agentId) {
  console.error('Usage: node scripts/agent-wake.mjs <agentId>');
  process.exit(1);
}

const base = process.env.MCL_BASE_URL || 'http://127.0.0.1:8787';

async function run() {
  const wake = await fetch(`${base}/api/agent/${agentId}/wake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const result = await wake.json();
  if (!wake.ok) {
    console.error(JSON.stringify(result));
    process.exit(2);
  }

  if (!result.task) {
    console.log(`HEARTBEAT_OK ${agentId}: no actionable tasks`);
    return;
  }

  console.log(`AGENT_WAKE ${agentId}: claimed ${result.task.id} (${result.task.title})`);
}

run().catch((e) => {
  console.error(String(e.message || e));
  process.exit(3);
});
