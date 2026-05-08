-- Scout v0.1.8 — recording mode (skill vs improvement).
--
-- Two flavours of recording:
--   'skill'        — the existing flow: capture a workflow, generate a
--                    SKILL.md the cloud runtime can replay against new inputs.
--   'improvement'  — capture a critique of an existing app: narrate what's
--                    wrong, point at things, generate a change brief that
--                    can be pasted directly into Claude Code.
--
-- Both live in the same recordings + skills tables; mode is carried as a
-- column so the popup and Edge Function can dispatch correctly without
-- needing a second schema.

alter table public.recordings
  add column if not exists mode text not null default 'skill'
    check (mode in ('skill', 'improvement'));

alter table public.skills
  add column if not exists kind text not null default 'skill'
    check (kind in ('skill', 'improvement'));
