-- Scout v0.1.4 — universal login.
--
-- Auth lives in a separate Supabase project ("universal" identity hub) so a
-- single login can be reused across Orage apps. This data project still
-- enforces row-level security via auth.uid(), which reads the JWT's `sub`
-- claim — that works as long as the data project's JWT secret matches the
-- auth project's (set in Supabase dashboard → Settings → API → JWT Secret).
--
-- But the user UUIDs in tokens are foreign to THIS project's auth.users
-- table. So the existing FKs on recordings/events/skills/profiles → auth.users
-- would block every insert. This migration removes those FKs and the
-- handle_new_user trigger (it relied on local auth.users inserts that no
-- longer happen). RLS policies are unchanged — auth.uid() = user_id still
-- gates access correctly.

-- 1. Drop FKs to auth.users.

alter table public.recordings
  drop constraint if exists recordings_user_id_fkey;

alter table public.events
  drop constraint if exists events_user_id_fkey;

alter table public.skills
  drop constraint if exists skills_user_id_fkey;

alter table public.profiles
  drop constraint if exists profiles_id_fkey;

-- 2. Drop the local-signup trigger. With universal auth, no rows are
--    inserted into THIS project's auth.users table; profiles are upserted
--    lazily by the extension on first sign-in instead.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
