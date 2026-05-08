-- Scout v0.1.11 — TEMPORARY: every signed-in user is treated as admin.
--
-- Override scout_role() to always return 'admin' so anyone signed in can
-- SELECT every row across recordings/events/skills/coach_log. Mutations
-- still scope to the calling user (each policy keeps its with-check on
-- user_id = auth.uid()), so users still only WRITE under their own id.
--
-- Why: testing phase — we want every tester to be able to download and
-- revise generated artifacts without manually flipping each account's
-- app_metadata.role. The original JWT-based check is preserved as a
-- comment below for the eventual revert.
--
-- TO REVERT (when admin/guest split comes back):
--   create or replace function public.scout_role()
--   returns text language sql stable as $$
--     select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), null);
--   $$;
-- Or drop this migration's effect by re-applying 0003_admin_role.sql.

create or replace function public.scout_role()
returns text
language sql stable
as $$
  -- TEMP override: everyone is admin during testing.
  -- Original check (preserved for revert):
  --   select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), null);
  select 'admin'::text;
$$;
