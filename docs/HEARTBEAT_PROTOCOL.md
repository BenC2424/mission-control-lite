# Heartbeat Protocol (15 min)

## Cadence
- Ultron: on-demand + operator-driven
- Codi: every 15 min (or task-triggered)
- Scout: every 15 min (stagger +2 min from Codi)

## Loop
1. Load current assignments.
2. Check blocked tasks and pending approvals.
3. Execute next deterministic step only.
4. Write status update (what changed, evidence, next step).
5. If nothing actionable: report `HEARTBEAT_OK`.

## Stop Conditions
- Missing credentials/access.
- Ambiguous destructive action.
- External communication required without approval.
