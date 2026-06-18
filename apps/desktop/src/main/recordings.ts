import { promises as fs } from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { CaptureSession, OsEvent } from "../shared/types";

export interface RecordingMeta {
  recording_id: string;
  dir: string;
  events_file: string;
  session: CaptureSession | null;
  mtime_ms: number;
}

export function recordingsRoot(): string {
  return path.join(app.getPath("userData"), "recordings");
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const root = recordingsRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: RecordingMeta[] = [];
  for (const id of entries) {
    const dir = path.join(root, id);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const eventsFile = path.join(dir, "events.ndjson");
    let evStat;
    try {
      evStat = await fs.stat(eventsFile);
    } catch {
      continue;
    }

    let session: CaptureSession | null = null;
    try {
      const text = await fs.readFile(path.join(dir, "session.json"), "utf8");
      session = JSON.parse(text) as CaptureSession;
    } catch {
      session = null;
    }
    out.push({
      recording_id: id,
      dir,
      events_file: eventsFile,
      session,
      mtime_ms: evStat.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out;
}

export async function getLastRecording(): Promise<RecordingMeta | null> {
  const all = await listRecordings();
  return all[0] ?? null;
}

export async function loadEvents(filePath: string): Promise<OsEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const out: OsEvent[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as OsEvent);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export async function deleteRecording(recordingId: string): Promise<boolean> {
  // Bound the delete to the recordings root to guard against ../ traversal in a
  // bad recording_id. We only accept the hex/UUID-shaped IDs we mint ourselves.
  if (!/^[a-zA-Z0-9_-]+$/.test(recordingId)) return false;
  const dir = path.join(recordingsRoot(), recordingId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
