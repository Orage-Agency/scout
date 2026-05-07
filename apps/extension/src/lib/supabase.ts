// Two Supabase clients in one extension:
//
//   getAuthSupabase()  → "universal" identity hub. Manages the session
//                        (login/signup/refresh). Other Orage apps point at
//                        this same project so a single login works everywhere.
//
//   getDataSupabase()  → Scout's own backend. Hosts the recordings/events/
//                        skills tables, storage buckets, and Edge Functions.
//                        Receives the access token from the auth client and
//                        is kept in sync via onAuthStateChange.
//
// For RLS in the data project to read auth.uid() off a token issued by the
// auth project, the data project's JWT secret must equal the auth project's.
// (Supabase dashboard → Settings → API → JWT Settings → JWT Secret.)

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _auth: SupabaseClient | null = null;
let _data: SupabaseClient | null = null;
let _bridgeInstalled = false;

export function getAuthSupabase(): SupabaseClient {
  if (_auth) return _auth;
  // Auth project is optional. When the dedicated auth env vars aren't set
  // we fall back to the data project — the same Supabase project handles
  // both auth and data (single-project mode). The dual-client architecture
  // still applies; the two clients just happen to point at the same URL.
  const url = (import.meta.env.VITE_AUTH_SUPABASE_URL as string | undefined) ?? (import.meta.env.VITE_SUPABASE_URL as string | undefined);
  const anon = (import.meta.env.VITE_AUTH_SUPABASE_ANON_KEY as string | undefined) ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);
  if (!url || !anon) {
    throw new Error(
      "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. See README §Setup."
    );
  }
  _auth = createClient(url, anon, {
    auth: {
      storage: chromeStorageAdapter("scout:auth"),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: { headers: { "x-scout-client": "extension/0.1.4-auth" } },
  });
  // Ensure data client also exists so the bridge can attach. Calling
  // getDataSupabase here is safe — it short-circuits if _data is set, and
  // if not, it creates _data and re-enters installAuthBridge() which will
  // then find both clients and install.
  if (!_data) getDataSupabase();
  installAuthBridge();
  return _auth;
}

export function getDataSupabase(): SupabaseClient {
  if (_data) return _data;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anon) {
    throw new Error(
      "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. See README §Setup."
    );
  }
  // The data client never persists or refreshes its own session — the auth
  // client owns that lifecycle. We mirror the access token in via setSession.
  _data = createClient(url, anon, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "x-scout-client": "extension/0.1.4-data" } },
  });
  // Ensure auth client exists so the bridge can attach. This guards the
  // service-worker wake-up case where the first call after rehydration is
  // a data-only path (e.g. flushing the event buffer) — without this,
  // _auth never gets created and the data client never receives a session.
  if (!_auth) getAuthSupabase();
  installAuthBridge();
  return _data;
}

// Mirror the auth client's session into the data client whenever it changes.
// Idempotent — only attaches once even if both getters are called.
function installAuthBridge(): void {
  if (_bridgeInstalled) return;
  if (!_auth || !_data) return; // wait until both exist
  _bridgeInstalled = true;
  // Seed once on install.
  void (async () => {
    const { data } = await _auth!.auth.getSession();
    if (data.session) {
      await _data!.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    }
  })();
  _auth.auth.onAuthStateChange(async (_evt, session) => {
    if (!_data) return;
    if (session) {
      await _data.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    } else {
      await _data.auth.signOut();
    }
  });
}

// chrome.storage.local works in service worker, popup, and content scripts.
// Namespaced so the auth client's session can't collide with the data
// client's (or with any session left behind by the v0.1.3 single-client build).
function chromeStorageAdapter(prefix: string) {
  return {
    getItem: async (key: string) => {
      const k = `${prefix}:${key}`;
      const v = await chrome.storage.local.get(k);
      return (v[k] as string) ?? null;
    },
    setItem: async (key: string, value: string) => {
      await chrome.storage.local.set({ [`${prefix}:${key}`]: value });
    },
    removeItem: async (key: string) => {
      await chrome.storage.local.remove(`${prefix}:${key}`);
    },
  };
}

// Edge function URL helper. Functions live in the DATA project.
export function functionUrl(name: string): string {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  return `${url}/functions/v1/${name}`;
}
