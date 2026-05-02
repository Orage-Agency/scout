-- Scout v1 — initial schema. RLS enabled on every table; policies scope to auth.uid().

-- ============================================================================
-- Tables
-- ============================================================================

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  display_name text,
  created_at  timestamptz not null default now()
);

create table if not exists public.recordings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text,
  status       text not null default 'recording'
                 check (status in ('recording','uploading','transcribing','ready','failed')),
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  duration_ms  integer,
  audio_path   text,
  transcript   jsonb,
  meta         jsonb default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists recordings_user_started_idx
  on public.recordings (user_id, started_at desc);

create table if not exists public.events (
  id              bigserial primary key,
  recording_id    uuid not null references public.recordings(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  ts_ms           integer not null,
  kind            text not null,
  data            jsonb not null,
  screenshot_path text
);
create index if not exists events_recording_idx on public.events (recording_id, ts_ms);

create table if not exists public.skills (
  id            uuid primary key default gen_random_uuid(),
  recording_id  uuid not null references public.recordings(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  version       integer not null default 1,
  title         text,
  body_md       text not null,
  prompt_used   text,
  created_at    timestamptz not null default now()
);
create index if not exists skills_recording_idx on public.skills (recording_id, version desc);

create table if not exists public.coach_log (
  id              bigserial primary key,
  recording_id    uuid not null references public.recordings(id) on delete cascade,
  asked_at_ms     integer not null,
  ask_text        text not null,
  reply_transcript text,
  reply_ts_range  int4range
);
create index if not exists coach_log_recording_idx on public.coach_log (recording_id, asked_at_ms);

-- ============================================================================
-- Row-Level Security
-- ============================================================================

alter table public.profiles   enable row level security;
alter table public.recordings enable row level security;
alter table public.events     enable row level security;
alter table public.skills     enable row level security;
alter table public.coach_log  enable row level security;

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists rec_self on public.recordings;
create policy rec_self on public.recordings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ev_self on public.events;
create policy ev_self on public.events
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists sk_self on public.skills;
create policy sk_self on public.skills
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cl_self on public.coach_log;
create policy cl_self on public.coach_log
  for all using (
    exists (
      select 1 from public.recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Auto-create profile on signup
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Storage bucket policies
-- These run only after the buckets are created via the dashboard or `storage.create_bucket()`.
-- Path convention: <user_id>/<recording_id>/<event_id>.{jpg|webm}
-- ============================================================================

do $$
begin
  -- screenshots
  if exists (select 1 from storage.buckets where id = 'screenshots') then
    drop policy if exists screenshots_user_read on storage.objects;
    create policy screenshots_user_read on storage.objects
      for select using (
        bucket_id = 'screenshots'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
    drop policy if exists screenshots_user_write on storage.objects;
    create policy screenshots_user_write on storage.objects
      for insert with check (
        bucket_id = 'screenshots'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
    drop policy if exists screenshots_user_delete on storage.objects;
    create policy screenshots_user_delete on storage.objects
      for delete using (
        bucket_id = 'screenshots'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  -- audio
  if exists (select 1 from storage.buckets where id = 'audio') then
    drop policy if exists audio_user_read on storage.objects;
    create policy audio_user_read on storage.objects
      for select using (
        bucket_id = 'audio'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
    drop policy if exists audio_user_write on storage.objects;
    create policy audio_user_write on storage.objects
      for insert with check (
        bucket_id = 'audio'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
    drop policy if exists audio_user_delete on storage.objects;
    create policy audio_user_delete on storage.objects
      for delete using (
        bucket_id = 'audio'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  -- skills (optional bucket; only if storing .md exports)
  if exists (select 1 from storage.buckets where id = 'skills') then
    drop policy if exists skills_user_read on storage.objects;
    create policy skills_user_read on storage.objects
      for select using (
        bucket_id = 'skills'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
    drop policy if exists skills_user_write on storage.objects;
    create policy skills_user_write on storage.objects
      for insert with check (
        bucket_id = 'skills'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end $$;
