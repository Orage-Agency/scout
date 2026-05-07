-- Scout v0.1.4 — admin/guest role split.
--
-- Two roles, encoded in JWT app_metadata.role (set via service_role when
-- promoting a user):
--   admin → can SELECT every row across all users (Orage owns the skills)
--   guest → only sees their own (default; no app_metadata.role required)
--
-- Mutations (insert/update/delete) stay scoped to the calling user. We don't
-- want admins accidentally writing into someone else's user_id namespace.

-- Helper: pull the role claim out of the JWT. Returns NULL for guests.
create or replace function public.scout_role()
returns text
language sql stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role'),
    null
  );
$$;

-- recordings — admin can SELECT all, guest sees own.
drop policy if exists rec_self on public.recordings;
drop policy if exists rec_select on public.recordings;
drop policy if exists rec_modify on public.recordings;

create policy rec_select on public.recordings
  for select
  using (user_id = auth.uid() or public.scout_role() = 'admin');

create policy rec_modify on public.recordings
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- events
drop policy if exists ev_self on public.events;
drop policy if exists ev_select on public.events;
drop policy if exists ev_modify on public.events;

create policy ev_select on public.events
  for select
  using (user_id = auth.uid() or public.scout_role() = 'admin');

create policy ev_modify on public.events
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- skills
drop policy if exists sk_self on public.skills;
drop policy if exists sk_select on public.skills;
drop policy if exists sk_modify on public.skills;

create policy sk_select on public.skills
  for select
  using (user_id = auth.uid() or public.scout_role() = 'admin');

create policy sk_modify on public.skills
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- coach_log — keyed by recording, so the SELECT policy joins through
-- recordings. Admin sees all; guest sees their own.
drop policy if exists cl_self on public.coach_log;
drop policy if exists cl_select on public.coach_log;
drop policy if exists cl_modify on public.coach_log;

create policy cl_select on public.coach_log
  for select
  using (
    public.scout_role() = 'admin'
    or exists (
      select 1 from public.recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );

create policy cl_modify on public.coach_log
  for all
  using (
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

-- Storage buckets (screenshots/audio): admins also need read across all users
-- so they can fetch artifacts for skill review. Writes stay user-scoped.
do $$
begin
  if exists (select 1 from storage.buckets where id = 'screenshots') then
    drop policy if exists screenshots_user_read on storage.objects;
    drop policy if exists screenshots_read on storage.objects;
    create policy screenshots_read on storage.objects
      for select using (
        bucket_id = 'screenshots'
        and (
          (storage.foldername(name))[1] = auth.uid()::text
          or public.scout_role() = 'admin'
        )
      );
  end if;
  if exists (select 1 from storage.buckets where id = 'audio') then
    drop policy if exists audio_user_read on storage.objects;
    drop policy if exists audio_read on storage.objects;
    create policy audio_read on storage.objects
      for select using (
        bucket_id = 'audio'
        and (
          (storage.foldername(name))[1] = auth.uid()::text
          or public.scout_role() = 'admin'
        )
      );
  end if;
end $$;
