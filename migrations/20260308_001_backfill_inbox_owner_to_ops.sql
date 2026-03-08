-- PR-1 migration A: backfill inbox owners to ops
UPDATE tasks
SET owner = 'ops', updated_at = NOW()::text
WHERE status = 'inbox' AND owner <> 'ops';

-- Optional assignment normalization for inbox tasks
UPDATE task_assignments ta
SET agent_id = 'ops'
WHERE ta.task_id IN (
  SELECT id FROM tasks WHERE status = 'inbox'
) AND ta.agent_id <> 'ops';
