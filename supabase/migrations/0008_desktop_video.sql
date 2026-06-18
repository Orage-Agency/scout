-- Scout v0.3.0 — desktop OS-level capture support.
--
-- Adds:
--   1. recordings.video_path — pointer to uploaded screen video in storage
--   2. videos bucket for screen recordings
--   3. anchors bucket for per-click image anchors used by self-healing replay

alter table recordings
  add column if not exists video_path text;

comment on column recordings.video_path is
  'Path within the videos storage bucket. Set for desktop recordings; null for browser recordings (which use screenshot_path on events instead).';

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('videos',  'videos',  false, 5368709120),  -- 5 GB per video
  ('anchors', 'anchors', false, 10485760)     -- 10 MB per anchor PNG (usually <50 KB)
on conflict (id) do nothing;

-- Folder-scoped policies: a user may only touch objects under <auth.uid()>/.
drop policy if exists "scout videos upload"  on storage.objects;
drop policy if exists "scout videos read"    on storage.objects;
drop policy if exists "scout anchors upload" on storage.objects;
drop policy if exists "scout anchors read"   on storage.objects;

create policy "scout videos upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "scout videos read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "scout anchors upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'anchors'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "scout anchors read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'anchors'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
