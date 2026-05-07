-- Scout v0.1.5 — credential vault for hosted agents.
--
-- Stores encrypted secrets that the cloud runtime injects into agent runs:
-- API keys, OAuth refresh tokens, service login passwords for clients whose
-- agents we host. Encryption is symmetric (pgcrypto pgp_sym_encrypt) with a
-- master key supplied at call time — the key lives in Supabase secrets and
-- the runtime's env, never in any table.
--
-- Access:
--   Direct table SELECT/INSERT/UPDATE/DELETE → admins only via RLS.
--   vault_set / vault_get → SECURITY DEFINER helpers callable by service_role
--                            (Edge Functions, runtime). Bypass RLS by design.

create extension if not exists pgcrypto;

create table if not exists public.agent_credentials (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null,           -- the guest/client these creds belong to
  service         text not null,           -- 'gmail', 'salesforce', 'github', etc.
  label           text not null default 'default',
  value_encrypted bytea not null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_user_id, service, label)
);
create index if not exists agent_credentials_owner_idx
  on public.agent_credentials (owner_user_id, service);

alter table public.agent_credentials enable row level security;

drop policy if exists ac_admin on public.agent_credentials;
create policy ac_admin on public.agent_credentials
  for all
  using (public.scout_role() = 'admin')
  with check (public.scout_role() = 'admin');

-- Set or update a credential. Returns the row id.
-- Caller passes the master key; we never persist it.
create or replace function public.vault_set(
  p_owner_user_id uuid,
  p_service       text,
  p_label         text,
  p_plaintext     text,
  p_master_key    text,
  p_notes         text default null
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.agent_credentials (owner_user_id, service, label, value_encrypted, notes)
  values (p_owner_user_id, p_service, coalesce(p_label, 'default'), pgp_sym_encrypt(p_plaintext, p_master_key), p_notes)
  on conflict (owner_user_id, service, label)
  do update set
    value_encrypted = excluded.value_encrypted,
    notes           = coalesce(excluded.notes, public.agent_credentials.notes),
    updated_at      = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- Decrypt and return a credential value. Returns null if not found.
create or replace function public.vault_get(
  p_owner_user_id uuid,
  p_service       text,
  p_label         text,
  p_master_key    text
) returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_plain text;
begin
  select pgp_sym_decrypt(value_encrypted, p_master_key)::text
    into v_plain
  from public.agent_credentials
  where owner_user_id = p_owner_user_id
    and service       = p_service
    and label         = coalesce(p_label, 'default');
  return v_plain;
end;
$$;

-- Lock down: only authenticated callers using service_role (or admin via RPC
-- gateway) should be able to invoke these. Default execute is granted to
-- public; revoke and re-grant explicitly to service_role.
revoke all on function public.vault_set(uuid, text, text, text, text, text) from public;
revoke all on function public.vault_get(uuid, text, text, text)              from public;
grant execute on function public.vault_set(uuid, text, text, text, text, text) to service_role;
grant execute on function public.vault_get(uuid, text, text, text)              to service_role;
