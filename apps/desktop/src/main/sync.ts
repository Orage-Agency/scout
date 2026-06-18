import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  getSettings,
  isConfigured,
  saveSettings,
} from "./settings";
import {
  insertEvents,
  patchRecording,
  uploadToStorage,
  upsertRecording,
  type EventRow,
} from "./supabase-rest";
import { loadEvents, type RecordingMeta } from "./recordings";
import { logLine } from "./logger";

const BATCH_SIZE = 200;
const MAX_RETRIES = 5;
const ANCHOR_PARALLEL = 4;

export type SyncStatus =
  | { kind: "idle" }
  | { kind: "syncing"; recording_id: string; phase: string; uploaded: number; total: number }
  | { kind: "error"; recording_id: string; error: string }
  | { kind: "skipped"; recording_id: string; reason: string };

let status: SyncStatus = { kind: "idle" };
let listeners: Array<(s: SyncStatus) => void> = [];

export function getSyncStatus(): SyncStatus {
  return status;
}

export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function setStatus(next: SyncStatus): void {
  status = next;
  for (const l of listeners) l(next);
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = Math.min(1000 * Math.pow(2, i), 30_000);
      await logLine(
        `[sync] retry ${label} attempt=${i + 1} err=${String(err)} wait=${wait}ms`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function uploadVideoIfPresent(
  recordingId: string,
  userId: string,
  recordingDir: string
): Promise<string | null> {
  const localPath = path.join(recordingDir, "video.mp4");
  try {
    const stat = await fs.stat(localPath);
    if (stat.size === 0) return null;
  } catch {
    return null;
  }
  const objectPath = `${userId}/${recordingId}/video.mp4`;
  const body = await fs.readFile(localPath);
  await withRetry(
    () => uploadToStorage("videos", objectPath, body, "video/mp4"),
    `upload video ${recordingId}`
  );
  return objectPath;
}

async function uploadAnchors(
  recordingId: string,
  userId: string,
  recordingDir: string
): Promise<number> {
  const anchorsDir = path.join(recordingDir, "anchors");
  let entries: string[];
  try {
    entries = await fs.readdir(anchorsDir);
  } catch {
    return 0;
  }
  const pngs = entries.filter((n) => n.toLowerCase().endsWith(".png"));
  if (pngs.length === 0) return 0;

  let uploaded = 0;
  for (let i = 0; i < pngs.length; i += ANCHOR_PARALLEL) {
    const slice = pngs.slice(i, i + ANCHOR_PARALLEL);
    await Promise.all(
      slice.map(async (name) => {
        const body = await fs.readFile(path.join(anchorsDir, name));
        const objectPath = `${userId}/${recordingId}/anchors/${name}`;
        await withRetry(
          () => uploadToStorage("anchors", objectPath, body, "image/png"),
          `upload anchor ${name}`
        );
        uploaded += 1;
      })
    );
  }
  return uploaded;
}

export async function uploadRecording(meta: RecordingMeta): Promise<void> {
  if (!isConfigured()) {
    setStatus({
      kind: "skipped",
      recording_id: meta.recording_id,
      reason: "not configured",
    });
    await logLine(`[sync] skip ${meta.recording_id} — not configured`);
    return;
  }
  const settings = getSettings();
  const userId = settings.user_id;
  if (!userId) {
    setStatus({
      kind: "skipped",
      recording_id: meta.recording_id,
      reason: "no user_id in token",
    });
    await logLine(`[sync] skip ${meta.recording_id} — no user_id in token`);
    return;
  }
  if (settings.synced_recording_ids?.includes(meta.recording_id)) {
    setStatus({
      kind: "skipped",
      recording_id: meta.recording_id,
      reason: "already synced",
    });
    return;
  }

  const events = await loadEvents(meta.events_file);
  const session = meta.session;
  const startedAt = session?.started_at_ms
    ? new Date(session.started_at_ms).toISOString()
    : new Date(meta.mtime_ms).toISOString();
  const endedAt = session?.ended_at_ms
    ? new Date(session.ended_at_ms).toISOString()
    : undefined;
  const duration =
    session?.ended_at_ms && session?.started_at_ms
      ? session.ended_at_ms - session.started_at_ms
      : undefined;

  setStatus({
    kind: "syncing",
    recording_id: meta.recording_id,
    phase: "events",
    uploaded: 0,
    total: events.length,
  });
  await logLine(
    `[sync] start recording=${meta.recording_id} events=${events.length}`
  );

  try {
    await withRetry(
      () =>
        upsertRecording({
          id: meta.recording_id,
          user_id: userId,
          status: "uploading",
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: duration,
        }),
      "upsertRecording"
    );

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const slice: EventRow[] = events
        .slice(i, i + BATCH_SIZE)
        .map((ev) => ({
          id: ev.id,
          recording_id: ev.recording_id,
          user_id: userId,
          ts_ms: ev.ts_ms,
          kind: ev.kind,
          data: { ...ev.data, source: "desktop" },
        }));
      await withRetry(() => insertEvents(slice), `insertEvents[${i}]`);
      setStatus({
        kind: "syncing",
        recording_id: meta.recording_id,
        phase: "events",
        uploaded: i + slice.length,
        total: events.length,
      });
    }

    setStatus({
      kind: "syncing",
      recording_id: meta.recording_id,
      phase: "video",
      uploaded: 0,
      total: 1,
    });
    const videoPath = await uploadVideoIfPresent(
      meta.recording_id,
      userId,
      meta.dir
    );

    setStatus({
      kind: "syncing",
      recording_id: meta.recording_id,
      phase: "anchors",
      uploaded: 0,
      total: 0,
    });
    const anchorCount = await uploadAnchors(meta.recording_id, userId, meta.dir);

    await withRetry(
      () =>
        patchRecording(meta.recording_id, {
          status: "ready",
          video_path: videoPath,
        }),
      "patchRecording"
    );

    const ids = new Set(settings.synced_recording_ids ?? []);
    ids.add(meta.recording_id);
    await saveSettings({
      synced_recording_ids: [...ids],
      last_sync_at_ms: Date.now(),
    });
    setStatus({ kind: "idle" });
    await logLine(
      `[sync] done recording=${meta.recording_id} events=${events.length} ` +
        `video=${videoPath ? "y" : "n"} anchors=${anchorCount}`
    );
  } catch (err) {
    setStatus({
      kind: "error",
      recording_id: meta.recording_id,
      error: String(err),
    });
    await logLine(
      `[sync] failed recording=${meta.recording_id} err=${String(err)}`
    );
  }
}

export async function syncAllPending(
  getAll: () => Promise<RecordingMeta[]>
): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const all = await getAll();
  const synced = new Set(getSettings().synced_recording_ids ?? []);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of all) {
    if (synced.has(r.recording_id)) {
      skipped++;
      continue;
    }
    await uploadRecording(r);
    if (status.kind === "error") failed++;
    else uploaded++;
  }
  return { uploaded, skipped, failed };
}
