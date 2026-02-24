# Rollout Plan (2 Weeks)

## Week 1 — Stabilize Core Loop
- Day 1: finalize registry + task schema.
- Day 2: run 5 pilot tasks (2 code, 2 research, 1 mixed).
- Day 3: enforce evidence fields on all completed tasks.
- Day 4: tune heartbeat cadence and reduce no-op wakeups.
- Day 5: first daily standup with metrics baseline.

Exit criteria:
- >=80% tasks have complete evidence.
- <10% heartbeats are noisy/non-actionable.
- zero unapproved external/destructive actions.

## Week 2 — Controlled Autonomy
- Enable codi remediation loop for low-risk PR fixes.
- Add scout source confidence scoring to research outputs.
- Add blocked-task SLA alerts (>24h).
- Add weekly retro + lessons log updates.

Exit criteria:
- median task cycle time reduced by 20% vs Week 1.
- blocked >24h count trending down.
- no policy violations.
