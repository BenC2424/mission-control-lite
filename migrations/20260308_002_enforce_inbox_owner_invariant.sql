-- PR-1 migration B: enforce DB invariant
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_inbox_owner_must_be_ops_chk;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_inbox_owner_must_be_ops_chk
  CHECK (status <> 'inbox' OR owner = 'ops');
