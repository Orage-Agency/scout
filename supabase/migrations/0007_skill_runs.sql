-- skill_runs: tracks every time a SKILL.md is executed via /run-skill.
-- One row per run; steps is a JSON array of {n, status, output?, error?}.

create table if not exists skill_runs (
  id          uuid        default gen_random_uuid() primary key,
  skill_id    uuid        not null references skills(id) on delete cascade,
  user_id     uuid        not null,
  inputs      jsonb       not null default '{}',
  status      text        not null default 'running'
                          check (status in ('running', 'completed', 'failed')),
  steps       jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

alter table skill_runs enable row level security;

-- Users can see and manage their own runs only.
create policy "users see own runs"
  on skill_runs for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Admins (via scout_role() = 'admin') can read all runs for support purposes.
-- This mirrors the pattern used in 0003_admin_role.sql.
create policy "admins read all runs"
  on skill_runs for select
  using (scout_role() = 'admin');
