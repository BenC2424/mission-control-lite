begin;

-- Enable RLS on PostgREST-exposed public tables.
alter table if exists public.idempotency_keys      enable row level security;
alter table if exists public.tenant_users          enable row level security;
alter table if exists public.tenant_agents         enable row level security;
alter table if exists public.tenant_teams          enable row level security;
alter table if exists public.tenant_onboarding     enable row level security;
alter table if exists public.team_templates        enable row level security;
alter table if exists public.usage_events          enable row level security;
alter table if exists public.tenant_plans          enable row level security;
alter table if exists public.service_plans         enable row level security;
alter table if exists public.usage_rollups_daily   enable row level security;
alter table if exists public.subscriptions         enable row level security;
alter table if exists public.task_start_acks       enable row level security;

-- Recreate policies deterministically.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname='public'
      and tablename in (
        'idempotency_keys','tenant_users','tenant_agents','tenant_teams','tenant_onboarding','team_templates',
        'usage_events','tenant_plans','service_plans','usage_rollups_daily','subscriptions','task_start_acks'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- Tenant-scoped read policies.
create policy tenant_users_select
on public.tenant_users for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy tenant_agents_select
on public.tenant_agents for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy tenant_teams_select
on public.tenant_teams for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy tenant_onboarding_select
on public.tenant_onboarding for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy tenant_plans_select
on public.tenant_plans for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy subscriptions_select
on public.subscriptions for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy usage_events_select
on public.usage_events for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy usage_rollups_daily_select
on public.usage_rollups_daily for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

create policy task_start_acks_select
on public.task_start_acks for select to authenticated
using (tenant_id = auth.jwt()->>'tenant_id');

-- team_templates may be global (tenant_id null) or tenant-scoped.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='team_templates' and column_name='tenant_id'
  ) then
    execute 'create policy team_templates_select on public.team_templates for select to authenticated using ((tenant_id is not null and tenant_id = auth.jwt()->>''tenant_id'') or tenant_id is null)';
  else
    execute 'create policy team_templates_select on public.team_templates for select to authenticated using (true)';
  end if;
end $$;

-- Service catalog is globally readable by authenticated users.
create policy service_plans_select
on public.service_plans for select to authenticated
using (true);

-- idempotency_keys remains backend-managed; no authenticated read policy.

commit;
