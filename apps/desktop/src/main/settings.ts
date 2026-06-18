import { promises as fs } from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logLine } from "./logger";
import { defaultSupabaseUrl, defaultSupabaseAnonKey } from "./constants";

export interface Settings {
  supabase_url?: string;
  supabase_anon_key?: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  synced_recording_ids?: string[];
  last_sync_at_ms?: number;
  record_screen?: boolean;
  capture_anchors?: boolean;
}

let cached: Settings = {};
let settingsFile: string | null = null;
let listeners: Array<(s: Settings) => void> = [];

export function settingsPath(): string {
  if (!settingsFile) {
    settingsFile = path.join(app.getPath("userData"), "settings.json");
  }
  return settingsFile;
}

export async function loadSettings(): Promise<Settings> {
  const file = settingsPath();
  try {
    const text = await fs.readFile(file, "utf8");
    cached = JSON.parse(text) as Settings;
  } catch {
    cached = {};
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({}, null, 2));
    await logLine(`[settings] empty file initialised at ${file}`);
  }
  // Default to the bundled Supabase project. Users that explicitly point at a
  // self-hosted instance keep their override; everyone else gets the prod
  // values shipped with the build.
  if (!cached.supabase_url) cached.supabase_url = defaultSupabaseUrl();
  if (!cached.supabase_anon_key) cached.supabase_anon_key = defaultSupabaseAnonKey();
  if (cached.access_token && !cached.user_id) {
    const sub = extractSub(cached.access_token);
    if (sub) cached.user_id = sub;
  }
  return cached;
}

export function getSettings(): Settings {
  return cached;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  cached = { ...cached, ...patch };
  if (cached.access_token && !cached.user_id) {
    const sub = extractSub(cached.access_token);
    if (sub) cached.user_id = sub;
  }
  await fs.writeFile(settingsPath(), JSON.stringify(cached, null, 2));
  const snapshot = { ...cached };
  for (const l of listeners) l(snapshot);
  return cached;
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function isConfigured(): boolean {
  const s = cached;
  return Boolean(s.supabase_url && s.supabase_anon_key && s.access_token);
}

function extractSub(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
