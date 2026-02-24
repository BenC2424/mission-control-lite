# Mission Control Lite v1

Lean multi-agent operating system for Ultron + Codi + Scout.

## Components
- `config/agents.json` — registry, roles, capability boundaries
- `schemas/task.schema.json` — canonical task contract
- `docs/HEARTBEAT_PROTOCOL.md` — deterministic wake/check/action loop
- `docs/APPROVAL_RULES.md` — escalation and human approval policy
- `templates/DAILY_STANDUP.md` — operator summary format

## Operating Model
1. Tasks are created in a canonical schema.
2. Ultron assigns owner + watchers.
3. Codi/Scout execute deterministic steps, attach evidence.
4. Approval gates block risky actions.
5. Standup summarizes outcomes + blockers daily.

## Two-week rollout
- Week 1: run with 3 agents, no autonomous deploys.
- Week 2: enable guarded remediation loops and tighter SLAs.
