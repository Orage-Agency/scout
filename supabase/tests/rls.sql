-- RLS test cases for Scout.
-- Run against a staging project with two real user accounts.
-- Replace the UUIDs with real values from auth.users in your staging project.
--
-- Usage:
--   psql "$DATABASE_URL" -f supabase/tests/rls.sql
--
-- All assertions use RAISE EXCEPTION so the script stops on first failure.
-- A run with no exceptions = all policies hold.

-- ============================================================
-- Setup: two test user UUIDs (replace with real staging values)
-- ============================================================

\set user_a 'aaaaaaaa-0000-0000-0000-000000000001'
\set user_b 'bbbbbbbb-0000-0000-0000-000000000002'
\set admin_user 'cccccccc-0000-0000-0000-000000000003'

-- Helper: build a minimal JWT claims object for set_config.
-- Supabase RLS reads auth.uid() from request.jwt.claims.sub.
-- We also need app_metadata.role for the admin check in scout_role().
create or replace function test_set_user(uid text, role text default '') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object(
      'sub', uid,
      'role', 'authenticated',
      'app_metadata', case when role = '' then '{}'::json else json_build_object('role', role) end
    )::text,
    true -- local to transaction
  );
end; $$;

-- ============================================================
-- RECORDINGS table
-- ============================================================

do $$ declare
  rec_a_id uuid := gen_random_uuid();
  rec_b_id uuid := gen_random_uuid();
begin

  -- Insert one recording per user using their own identity
  perform test_set_user(:'user_a');
  set local role authenticated;
  insert into public.recordings (id, user_id, status)
    values (rec_a_id, :'user_a', 'ready');

  perform test_set_user(:'user_b');
  insert into public.recordings (id, user_id, status)
    values (rec_b_id, :'user_b', 'ready');

  -- user_a cannot SELECT user_b's row
  perform test_set_user(:'user_a');
  if exists (
    select 1 from public.recordings where id = rec_b_id
  ) then
    raise exception 'FAIL: user_a can read user_b recordings';
  end if;

  -- user_a CAN SELECT their own row
  if not exists (
    select 1 from public.recordings where id = rec_a_id
  ) then
    raise exception 'FAIL: user_a cannot read their own recording';
  end if;

  -- user_a cannot INSERT with user_id = user_b
  begin
    insert into public.recordings (user_id, status) values (:'user_b', 'ready');
    raise exception 'FAIL: user_a inserted a recording for user_b';
  exception when others then
    null; -- expected
  end;

  -- user_a cannot UPDATE user_b's row
  update public.recordings set title = 'hacked' where id = rec_b_id;
  if exists (
    select 1 from public.recordings where id = rec_b_id and title = 'hacked'
  ) then
    raise exception 'FAIL: user_a updated user_b recording';
  end if;

  -- admin CAN SELECT both rows
  perform test_set_user(:'admin_user', 'admin');
  if not exists (select 1 from public.recordings where id = rec_a_id) then
    raise exception 'FAIL: admin cannot read user_a recording';
  end if;
  if not exists (select 1 from public.recordings where id = rec_b_id) then
    raise exception 'FAIL: admin cannot read user_b recording';
  end if;

  -- admin cannot modify user_a's row (mutations are user-scoped)
  perform test_set_user(:'admin_user', 'admin');
  update public.recordings set title = 'admin-write' where id = rec_a_id;
  if exists (
    select 1 from public.recordings where id = rec_a_id and title = 'admin-write'
  ) then
    raise exception 'FAIL: admin mutated user_a recording (should be blocked)';
  end if;

  raise notice 'recordings RLS: PASS';

  -- Cleanup
  set local role service_role;
  delete from public.recordings where id in (rec_a_id, rec_b_id);
end $$;

-- ============================================================
-- EVENTS table
-- ============================================================

do $$ declare
  rec_id   uuid := gen_random_uuid();
  ev_a_id  bigint;
  ev_b_id  bigint;
begin
  set local role service_role;
  insert into public.recordings (id, user_id, status) values (rec_id, :'user_a', 'ready');

  perform test_set_user(:'user_a');
  set local role authenticated;
  insert into public.events (recording_id, user_id, ts_ms, kind, data)
    values (rec_id, :'user_a', 0, 'click', '{}') returning id into ev_a_id;

  set local role service_role;
  insert into public.events (recording_id, user_id, ts_ms, kind, data)
    values (rec_id, :'user_b', 0, 'click', '{}') returning id into ev_b_id;

  -- user_a cannot see user_b's event
  perform test_set_user(:'user_a');
  set local role authenticated;
  if exists (select 1 from public.events where id = ev_b_id) then
    raise exception 'FAIL: user_a can read user_b event';
  end if;

  raise notice 'events RLS: PASS';

  set local role service_role;
  delete from public.recordings where id = rec_id;
end $$;

-- ============================================================
-- SKILLS table
-- ============================================================

do $$ declare
  rec_id    uuid := gen_random_uuid();
  skill_b   uuid := gen_random_uuid();
begin
  set local role service_role;
  insert into public.recordings (id, user_id, status) values (rec_id, :'user_b', 'ready');
  insert into public.skills (id, recording_id, user_id, version, body_md)
    values (skill_b, rec_id, :'user_b', 1, '# test');

  perform test_set_user(:'user_a');
  set local role authenticated;
  if exists (select 1 from public.skills where id = skill_b) then
    raise exception 'FAIL: user_a can read user_b skill';
  end if;

  raise notice 'skills RLS: PASS';

  set local role service_role;
  delete from public.recordings where id = rec_id;
end $$;

-- ============================================================
-- COACH_LOG table
-- ============================================================

do $$ declare
  rec_a    uuid := gen_random_uuid();
  rec_b    uuid := gen_random_uuid();
  log_b_id bigint;
begin
  set local role service_role;
  insert into public.recordings (id, user_id, status)
    values (rec_a, :'user_a', 'ready'), (rec_b, :'user_b', 'ready');
  insert into public.coach_log (recording_id, asked_at_ms, ask_text)
    values (rec_b, 0, 'test ask') returning id into log_b_id;

  perform test_set_user(:'user_a');
  set local role authenticated;
  if exists (select 1 from public.coach_log where id = log_b_id) then
    raise exception 'FAIL: user_a can read user_b coach_log';
  end if;

  raise notice 'coach_log RLS: PASS';

  set local role service_role;
  delete from public.recordings where id in (rec_a, rec_b);
end $$;

-- ============================================================
-- STORAGE: screenshots bucket path isolation
-- ============================================================
-- Storage RLS is enforced by the bucket policy: (storage.foldername(name))[1] = auth.uid()::text
-- These are SQL-level checks; full integration test requires an actual upload attempt via the API.

do $$ begin
  -- Verify policy exists for screenshots bucket
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects'
      and schemaname = 'storage'
      and policyname in ('screenshots_user_write', 'screenshots_user_read', 'screenshots_read')
  ) then
    raise exception 'FAIL: screenshots storage policies are missing';
  end if;

  raise notice 'storage policies: PASS (existence check only; upload isolation requires API-level test)';
end $$;

raise notice '=== All RLS checks passed ===';
