# Escalation & Approval Rules

## Always require Ben approval
- Any destructive action (delete/reset/force push/data wipe).
- External/public messaging or publishing.
- Production deployment affecting users.
- New credential/token grants.

## Ultron approval required before merge/deploy
- Codi code changes marked high risk.
- Scout findings with low confidence (<0.7) used for decisions.
- Any policy/config changes in `.github/workflows` or `policy/`.

## Escalation format
- `BLOCKED: <reason>`
- `NEED_APPROVAL: <action> | impact | rollback`
- `UNBLOCKED: <what changed>`
