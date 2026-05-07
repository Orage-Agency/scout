// Tiny helper: build a Supabase client scoped to the calling user, plus an
// admin client for storage signed-URL access. Used by all Edge Functions.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function userClient(authHeader: string | null): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, anon, {
    global: { headers: { Authorization: authHeader ?? "" } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Verify the bearer token against the AUTH (universal) project. Since v0.1.4
// users live in a separate Supabase project, we cannot validate the token
// against THIS data project — its auth.users table doesn't have these rows.
// We point getUser() at the auth project, which has the row and returns the
// user. RLS in the data project still works because auth.uid() reads the
// JWT's sub claim (which is project-agnostic as long as JWT secrets match).
//
// Returns the user, or null if the token is missing/invalid.
export async function verifyAuthUser(authHeader: string | null): Promise<{ id: string; email?: string } | null> {
  if (!authHeader) return null;
  const url = Deno.env.get("AUTH_SUPABASE_URL");
  const anon = Deno.env.get("AUTH_SUPABASE_ANON_KEY");
  if (!url || !anon) {
    // Backwards-compat: if the auth env isn't set, fall back to the data
    // project (single-project mode). This preserves the old behaviour for
    // anyone who hasn't migrated yet.
    const sb = userClient(authHeader);
    const { data } = await sb.auth.getUser();
    return data.user ?? null;
  }
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
