-- Device-link auth (RFC 8628-style device authorization grant).
--
-- Desktop client mints a (device_code, user_code) pair, opens the verification
-- URL with the user_code prefilled, and polls until a signed-in user approves
-- the request. The approval endpoint mints a fresh Supabase session for that
-- user (via admin generateLink + verify) and stores the tokens on the row so
-- the next poll can hand them back to the desktop.
--
-- Tokens live on the row only between approval and the next poll. Once the
-- desktop reads them the row flips to 'consumed' and is purged by a periodic
-- job (or just left to age out — expires_at bounds storage).

create table if not exists device_codes (
  id              uuid primary key default gen_random_uuid(),
  device_code     text not null unique,
  user_code       text not null unique,
  user_id         uuid references auth.users(id) on delete cascade,
  access_token    text,
  refresh_token   text,
  status          text not null default 'pending'
                    check (status in ('pending','approved','denied','expired','consumed')),
  client_label    text,
  expires_at      timestamptz not null default (now() + interval '10 minutes'),
  approved_at     timestamptz,
  polled_at       timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists device_codes_user_code_idx   on device_codes(user_code);
create index if not exists device_codes_device_code_idx on device_codes(device_code);
create index if not exists device_codes_expires_idx     on device_codes(expires_at);

-- Service role only. No RLS policies are intentional: the device-link edge
-- function uses the service role key. End-user clients should never touch
-- this table directly.
alter table device_codes enable row level security;
