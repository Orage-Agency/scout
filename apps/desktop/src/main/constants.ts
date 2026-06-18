// Bundle-time Supabase configuration so end users don't have to paste a URL
// and anon key on first run. electron-builder injects SCOUT_SUPABASE_URL and
// SCOUT_SUPABASE_ANON_KEY at compile time via the build env; the placeholders
// below are used only in unconfigured dev checkouts.
//
// These are PUBLIC values (the anon key is meant to be shipped to clients —
// it's gated by RLS, not by secrecy). Embedding them is the same model
// supabase-js itself uses in any client app.

const PLACEHOLDER_URL = "https://REPLACE_AT_BUILD.supabase.co";
const PLACEHOLDER_ANON = "REPLACE_AT_BUILD";

export function defaultSupabaseUrl(): string {
  return process.env.SCOUT_SUPABASE_URL || PLACEHOLDER_URL;
}

export function defaultSupabaseAnonKey(): string {
  return process.env.SCOUT_SUPABASE_ANON_KEY || PLACEHOLDER_ANON;
}

export function hasBundledConfig(): boolean {
  const url = defaultSupabaseUrl();
  const key = defaultSupabaseAnonKey();
  return (
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) &&
    key.length > 40 &&
    !key.includes("REPLACE")
  );
}
