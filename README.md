# Mission Control Lite v0.6

Lean local-first multi-agent operating system for Ultron + Codi + Scout.

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

## Run
```bash
npm install
npm run start
```

Open: `http://localhost:8787/ui/index.html`

## v0.6 highlights
- Health endpoint: `GET /api/health`
- Stronger API validation for task create/update
- Activity persistence: `runtime/activity.json`
- UI task create modal + filters + detail drawer edits
- Drag-and-drop task status updates across kanban columns
- Drawer task activity timeline (task-scoped events)
- Keyboard shortcuts: `n` new task, `r` refresh, `g` standup, `Esc` close drawers
- Search filter (task title/id) for faster triage
- Delete task action with confirmation prompt
- Snapshot export/import (local JSON backup/restore)
- API integration tests for health + invalid create + delete + export flow (`npm test`)

## Two-week rollout
- Week 1: run with 3 agents, no autonomous deploys.
- Week 2: enable guarded remediation loops and tighter SLAs.
