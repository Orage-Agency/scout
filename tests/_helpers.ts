// Shared test setup. v0.1.4 split auth and data into two Supabase projects;
// these helpers route admin user-management calls to the AUTH project and
// keep DB queries against the DATA project. Both fall back to the data
// project's env vars in single-project mode (pre-v0.1.4) so older test
// runs don't break.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";

let _envLoaded = false;

export function loadEnv(): void {
  if (_envLoaded) return;
  _envLoaded = true;
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function authUrl(): string {
  loadEnv();
  return process.env.AUTH_SUPABASE_URL || process.env.VITE_AUTH_SUPABASE_URL || process.env.SUPABASE_URL!;
}
function authAnon(): string {
  loadEnv();
  return process.env.AUTH_SUPABASE_ANON_KEY || process.env.VITE_AUTH_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!;
}
function authService(): string {
  loadEnv();
  return process.env.AUTH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
}
function dataUrl(): string {
  loadEnv();
  return process.env.SUPABASE_URL!;
}
function dataService(): string {
  loadEnv();
  return process.env.SUPABASE_SERVICE_ROLE_KEY!;
}

// Service-role client against the AUTH (universal) project. Use for
// admin.auth.admin.createUser / deleteUser / listUsers.
export function adminAuthClient(): SupabaseClient {
  return createClient(authUrl(), authService(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Service-role client against the DATA (Scout) project. Use for direct
// DB queries (recordings/events/skills) and storage admin operations.
export function adminDataClient(): SupabaseClient {
  return createClient(dataUrl(), dataService(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Anon client against the AUTH project. Use for signInWithPassword to mint
// a real session JWT for a test user.
export function userAuthClient(): SupabaseClient {
  return createClient(authUrl(), authAnon(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
