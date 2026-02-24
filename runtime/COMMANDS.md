# Mission Control Lite Commands

## Add task
`node scripts/tasks.mjs add "<title>" <owner: ultron|codi|scout> [priority:p0|p1|p2|p3]`

## Update task status
`node scripts/tasks.mjs status <taskId> <inbox|assigned|in_progress|review|blocked|done>`

## Add note/evidence
`node scripts/tasks.mjs note <taskId> "<note>"`

## Generate standup
`node scripts/tasks.mjs standup`
