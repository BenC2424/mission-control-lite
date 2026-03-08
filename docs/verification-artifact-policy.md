# Verification Artifact Cleanup Policy

Permanent rule: tasks created for scheduler/handshake/WIP/proof/canary/seed/test verification must not remain active once verification is complete.

## Detection markers

Included title markers (any match):
- scheduler
- handshake
- wip
- proof
- canary
- seed
- test verification
- verification artifact
- sched-step
- pr3a-step
- ack-proof
- worker cap
- global cap

Included note markers (any match):
- archived_test_seed_artifact
- test_seed
- verification run
- canary
- proof run
- scheduler test
- handshake test
- wip gate test

Exclusion title markers (any match blocks cleanup):
- customer
- prod / production
- incident
- hotfix
- billing
- invoice
- payment
- security
- auth
- migration
- release

## Cleanup action

For matching tasks in `review`, `in_progress`, or `starting`:
- transition to `archived`
- append note: `archived_test_seed_artifact`
- emit event reason code in message: `reason_code=archived_test_seed_artifact`

## Runtime hooks

- Manual/automation endpoint: `POST /api/autopilot/verification-artifact-cleanup-run` (`mode=dry_run|apply`)
- Automatic execution integrated into `POST /api/autopilot/stale-run`
