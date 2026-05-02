// Lazy Supabase client. The extension reads env at build time via Vite.
// We never bundle the service-role key — only the anon key flows here.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anon) {
    throw new Error(
      "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. See README §Setup."
    );
  }
  _client = createClient(url, anon, {
    auth: {
      // Persist session in chrome.storage.local via custom storage adapter.
      storage: chromeStorageAdapter(),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: { headers: { "x-scout-client": "extension/0.1.0" } },
  });
  return _client;
}

// chrome.storage.local works in service worker, popup, and content scripts.
function chromeStorageAdapter() {
  return {
    getItem: async (key: string) => {
      const v = await chrome.storage.local.get(key);
      return (v[key] as string) ?? null;
    },
    setItem: async (key: string, value: string) => {
      await chrome.storage.local.set({ [key]: value });
    },
    removeItem: async (key: string) => {
      await chrome.storage.local.remove(key);
    },
  };
}

// Edge function URL helper. Functions live at <SUPABASE_URL>/functions/v1/<name>.
export function functionUrl(name: string): string {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  return `${url}/functions/v1/${name}`;
}
