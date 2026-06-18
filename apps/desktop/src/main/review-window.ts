// Review window. Single BrowserWindow surfacing the things that used to live
// only in the tray menu: live status, the recordings list, replay/sync/delete
// actions, and the sign-in shortcut.
//
// The window is intentionally optional — the tray remains the primary affordance
// for users who treat Scout as a background daemon. We open it on demand and
// keep it cheap to dispose (closing tears down the page; no in-memory state to
// preserve).

import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import { app } from "electron";
import { getActiveSession, isCapturing } from "./capture";
import {
  getReplayProgress,
  isReplaying,
  requestAbort,
  runEvents,
} from "./replay";
import {
  deleteRecording,
  getLastRecording,
  listRecordings,
  loadEvents,
  type RecordingMeta,
} from "./recordings";
import {
  getSettings,
  isConfigured,
  saveSettings,
} from "./settings";
import { getSyncStatus, syncAllPending, uploadRecording } from "./sync";
import { openAuthWindow } from "./auth-window";
import { logLine } from "./logger";

let win: BrowserWindow | null = null;
let ipcRegistered = false;

interface RecordingSummary {
  recording_id: string;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  duration_ms: number | null;
  event_count: number | null;
  synced: boolean;
  has_video: boolean;
  dir: string;
}

async function summarize(meta: RecordingMeta): Promise<RecordingSummary> {
  let hasVideo = false;
  try {
    const { promises: fs } = await import("node:fs");
    const st = await fs.stat(path.join(meta.dir, "video.mp4"));
    hasVideo = st.size > 0;
  } catch {
    hasVideo = false;
  }
  const synced = getSettings().synced_recording_ids?.includes(meta.recording_id) ?? false;
  return {
    recording_id: meta.recording_id,
    started_at_ms: meta.session?.started_at_ms ?? null,
    ended_at_ms: meta.session?.ended_at_ms ?? null,
    duration_ms:
      meta.session?.ended_at_ms && meta.session?.started_at_ms
        ? meta.session.ended_at_ms - meta.session.started_at_ms
        : null,
    event_count: meta.session?.event_count ?? null,
    synced,
    has_video: hasVideo,
    dir: meta.dir,
  };
}

interface AppState {
  capturing: boolean;
  capturing_event_count: number;
  replaying: boolean;
  replay_progress: ReturnType<typeof getReplayProgress>;
  sync_status: ReturnType<typeof getSyncStatus>;
  configured: boolean;
  user_id: string | null;
  supabase_url: string | null;
}

function snapshotState(): AppState {
  const s = getSettings();
  return {
    capturing: isCapturing(),
    capturing_event_count: getActiveSession()?.event_count ?? 0,
    replaying: isReplaying(),
    replay_progress: getReplayProgress(),
    sync_status: getSyncStatus(),
    configured: isConfigured(),
    user_id: s.user_id ?? null,
    supabase_url: s.supabase_url ?? null,
  };
}

export function pushReviewState(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("scout:state", snapshotState());
}

export async function pushReviewRecordings(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const all = await listRecordings();
  const summaries = await Promise.all(all.map(summarize));
  if (win && !win.isDestroyed()) {
    win.webContents.send("scout:recordings", summaries);
  }
}

// HTML kept inline to avoid a separate renderer-side bundling step; the tray
// app stays single-process from a build-tooling standpoint. contextIsolation
// is off here because the page only ever loads our own template — no third
// party content is fetched — and the IPC surface is small and explicit.
const HTML = `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Scout</title>
<style>
  :root { color-scheme: dark light; --bg: #0e0e11; --panel: #15151a; --line: #26262d; --text: #f0f0f0; --muted: #a0a0a8; --brand: #6366f1; --ok: #22c55e; --warn: #eab308; --err: #ef4444; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 13px; display: grid; grid-template-rows: auto 1fr auto; }
  header { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; background: var(--panel); }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  header .grow { flex: 1; }
  .pill { font-size: 11px; padding: 4px 9px; border-radius: 999px; background: #26262b; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .pill.recording { color: #fca5a5; background: #2b1a1d; }
  .pill.recording .dot { background: var(--err); animation: pulse 1.4s ease-in-out infinite; }
  .pill.replaying { color: #c7d2fe; background: #1d1e2e; }
  .pill.replaying .dot { background: var(--brand); animation: pulse 1.4s ease-in-out infinite; }
  .pill.syncing { color: #fde68a; background: #2a2618; }
  .pill.syncing .dot { background: var(--warn); animation: pulse 1.4s ease-in-out infinite; }
  .pill.idle.ok .dot { background: var(--ok); }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }

  .toolbar { padding: 12px 18px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 7px; padding: 7px 13px; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; }
  button:hover { background: #1d1d23; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: var(--brand); border-color: var(--brand); color: white; }
  button.primary:hover { background: #5258ee; }
  button.danger:hover { background: #2b1a1d; border-color: #5a2a30; color: #fca5a5; }
  button.recording { background: var(--err); border-color: var(--err); color: white; }
  button.recording:hover { background: #d34a4e; }

  main { overflow: auto; padding: 12px 18px 18px; }
  .empty { text-align: center; color: var(--muted); padding: 64px 20px; }
  .empty h2 { font-size: 15px; margin: 0 0 8px; color: var(--text); }
  .empty p { margin: 0; font-size: 12px; max-width: 380px; margin: 0 auto; line-height: 1.55; }

  .row { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); background: var(--panel); border-radius: 9px; margin-bottom: 8px; align-items: center; }
  .row .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); }
  .row .title { font-weight: 500; font-size: 13px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
  .row .meta { font-size: 11px; color: var(--muted); }
  .row .actions { display: flex; gap: 6px; }
  .row .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #1f1f25; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 500; }
  .row .badge.ok { background: #14322a; color: #86efac; }
  .row .badge.video { background: #1d1e2e; color: #c7d2fe; }
  .row.current { border-color: var(--brand); }

  footer { padding: 10px 18px; border-top: 1px solid var(--line); background: var(--panel); display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--muted); }
  footer .grow { flex: 1; }
  footer code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .progress { font-size: 11px; color: var(--muted); margin-left: 8px; }
</style>
</head><body>
<header>
  <h1>Scout</h1>
  <span class="pill idle" id="status-pill"><span class="dot"></span><span id="status-text">Idle</span></span>
  <span class="progress" id="progress"></span>
  <span class="grow"></span>
  <button id="open-folder">Open recordings folder</button>
</header>

<div class="toolbar">
  <button id="record-btn" class="primary">Start recording</button>
  <button id="replay-btn">Replay last</button>
  <button id="abort-btn" class="danger" style="display:none">Abort replay</button>
  <button id="sync-btn">Sync now</button>
  <span class="grow" style="flex:1"></span>
  <button id="auth-btn">Sign in</button>
</div>

<main>
  <div id="list"></div>
</main>

<footer>
  <span id="footer-text">Loading…</span>
  <span class="grow"></span>
  <span><code>Ctrl+Shift+R</code> record · <code>Ctrl+Shift+P</code> replay · <code>Ctrl+Shift+S</code> show window</span>
</footer>

<script>
  const { ipcRenderer } = require('electron');

  const els = {
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    progress:   document.getElementById('progress'),
    recordBtn:  document.getElementById('record-btn'),
    replayBtn:  document.getElementById('replay-btn'),
    abortBtn:   document.getElementById('abort-btn'),
    syncBtn:    document.getElementById('sync-btn'),
    authBtn:    document.getElementById('auth-btn'),
    openFolder: document.getElementById('open-folder'),
    list:       document.getElementById('list'),
    footer:     document.getElementById('footer-text'),
  };

  let state = null;
  let recordings = [];

  function fmtDate(ms) {
    if (!ms) return '–';
    const d = new Date(ms);
    return d.toLocaleString();
  }
  function fmtDur(ms) {
    if (ms == null) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + 'm ' + r + 's';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function render() {
    if (!state) return;
    const pill = els.statusPill;
    pill.className = 'pill';
    if (state.replaying) {
      pill.classList.add('replaying');
      els.statusText.textContent = 'Replaying';
      const rp = state.replay_progress;
      els.progress.textContent = rp.total ? rp.current + '/' + rp.total + (rp.message ? ' — ' + rp.message : '') : '';
    } else if (state.capturing) {
      pill.classList.add('recording');
      els.statusText.textContent = 'Recording';
      els.progress.textContent = state.capturing_event_count + ' events';
    } else if (state.sync_status.kind === 'syncing') {
      pill.classList.add('syncing');
      els.statusText.textContent = 'Syncing';
      els.progress.textContent = state.sync_status.uploaded + '/' + state.sync_status.total + ' (' + state.sync_status.phase + ')';
    } else {
      pill.classList.add('idle');
      if (state.configured) pill.classList.add('ok');
      els.statusText.textContent = 'Idle';
      els.progress.textContent = '';
    }

    els.recordBtn.textContent = state.capturing ? 'Stop recording' : 'Start recording';
    els.recordBtn.classList.toggle('recording', state.capturing);
    els.recordBtn.disabled = state.replaying;
    els.replayBtn.disabled = state.capturing || state.replaying;
    els.abortBtn.style.display = state.replaying ? '' : 'none';
    els.syncBtn.disabled = state.capturing || state.sync_status.kind === 'syncing';
    els.syncBtn.textContent = state.configured ? 'Sync now' : 'Sync now (sign in first)';
    els.authBtn.textContent = state.configured ? 'Re-link' : 'Sign in';

    if (state.configured) {
      const uid = state.user_id ? state.user_id.slice(0, 8) + '…' : '?';
      els.footer.textContent = 'Signed in as ' + uid + ' · ' + (state.supabase_url || '');
    } else {
      els.footer.textContent = 'Not signed in — sync stays disabled';
    }

    renderList();
  }

  function renderList() {
    if (!recordings || recordings.length === 0) {
      els.list.innerHTML = '<div class="empty"><h2>No recordings yet</h2><p>Click <b>Start recording</b> or press <code>Ctrl+Shift+R</code>. Switch to whichever app you want to capture — Scout records globally.</p></div>';
      return;
    }
    const rows = recordings.map((r, i) => {
      const idShort = r.recording_id.slice(0, 8);
      const started = r.started_at_ms ? fmtDate(r.started_at_ms) : 'No session metadata';
      const dur = fmtDur(r.duration_ms);
      const ev = r.event_count == null ? '–' : r.event_count + ' events';
      const isLast = i === 0;
      const badges = [];
      if (r.synced) badges.push('<span class="badge ok">Synced</span>');
      if (r.has_video) badges.push('<span class="badge video">Video</span>');
      if (isLast) badges.push('<span class="badge">Latest</span>');
      return '<div class="row' + (isLast ? ' current' : '') + '">'
        + '<div>'
        + '<div class="title">' + badges.join(' ') + ' <span class="id">' + escapeHtml(idShort) + '</span></div>'
        + '<div class="meta">' + escapeHtml(started) + ' · ' + dur + ' · ' + ev + '</div>'
        + '</div>'
        + '<div class="actions">'
        + '<button data-act="replay" data-id="' + escapeHtml(r.recording_id) + '"' + (state && (state.capturing || state.replaying) ? ' disabled' : '') + '>Replay</button>'
        + '<button data-act="sync" data-id="' + escapeHtml(r.recording_id) + '"' + (r.synced || !state || !state.configured ? ' disabled' : '') + '>' + (r.synced ? 'Synced' : 'Sync') + '</button>'
        + '<button data-act="reveal" data-id="' + escapeHtml(r.recording_id) + '">Open</button>'
        + '<button class="danger" data-act="delete" data-id="' + escapeHtml(r.recording_id) + '">Delete</button>'
        + '</div></div>';
    }).join('');
    els.list.innerHTML = rows;
  }

  els.list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    if (act === 'replay') ipcRenderer.send('scout:replay', id);
    if (act === 'sync')   ipcRenderer.send('scout:sync-one', id);
    if (act === 'reveal') ipcRenderer.send('scout:reveal', id);
    if (act === 'delete') {
      const ok = await ipcRenderer.invoke('scout:confirm-delete', id);
      if (ok) ipcRenderer.send('scout:delete', id);
    }
  });

  els.recordBtn.onclick = () => ipcRenderer.send('scout:toggle-record');
  els.replayBtn.onclick = () => ipcRenderer.send('scout:replay-last');
  els.abortBtn.onclick  = () => ipcRenderer.send('scout:abort-replay');
  els.syncBtn.onclick   = () => ipcRenderer.send('scout:sync-all');
  els.authBtn.onclick   = () => ipcRenderer.send('scout:auth');
  els.openFolder.onclick = () => ipcRenderer.send('scout:open-folder');

  ipcRenderer.on('scout:state', (_e, s) => { state = s; render(); });
  ipcRenderer.on('scout:recordings', (_e, r) => { recordings = r; renderList(); });

  // Boot — ask main for an initial snapshot.
  ipcRenderer.invoke('scout:initial').then((init) => {
    state = init.state;
    recordings = init.recordings;
    render();
  });
</script>
</body></html>`;

function ensureIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("scout:initial", async () => {
    const all = await listRecordings();
    const recordings = await Promise.all(all.map(summarize));
    return { state: snapshotState(), recordings };
  });

  ipcMain.handle("scout:confirm-delete", async (_e, id: string) => {
    const choice = await dialog.showMessageBox(win ?? new BrowserWindow({ show: false }), {
      type: "warning",
      buttons: ["Cancel", "Delete"],
      defaultId: 0,
      cancelId: 0,
      title: "Scout — delete recording",
      message: `Delete recording ${id.slice(0, 8)}?`,
      detail:
        "Local files (events, screen video, anchors) will be removed. Already-synced copies stay in Supabase.",
    });
    return choice.response === 1;
  });

  ipcMain.on("scout:toggle-record", async () => {
    // Delegate to the tray's existing function via index.ts? Re-implementing
    // here keeps the IPC module standalone — both paths converge on the same
    // capture API.
    const { startCapture, stopCapture, isCapturing } = await import("./capture");
    if (isReplaying()) {
      dialog.showErrorBox("Scout", "Cannot start/stop capture while replay is running.");
      return;
    }
    if (isCapturing()) {
      const done = await stopCapture();
      await logLine(`[review] stop events=${done?.event_count ?? 0}`);
      if (done && isConfigured()) {
        const last = await getLastRecording();
        if (last && last.recording_id === done.recording_id) {
          void uploadRecording(last);
        }
      }
    } else {
      const s = await startCapture();
      await logLine(`[review] start id=${s.recording_id}`);
    }
    pushReviewState();
    await pushReviewRecordings();
  });

  ipcMain.on("scout:replay-last", async () => {
    const last = await getLastRecording();
    if (!last) {
      dialog.showErrorBox("Scout", "No recordings found.");
      return;
    }
    await replayMeta(last);
  });

  ipcMain.on("scout:replay", async (_e, id: string) => {
    const all = await listRecordings();
    const meta = all.find((r) => r.recording_id === id);
    if (!meta) return;
    await replayMeta(meta);
  });

  ipcMain.on("scout:abort-replay", () => {
    if (isReplaying()) requestAbort();
  });

  ipcMain.on("scout:sync-all", async () => {
    if (!isConfigured()) {
      openAuthWindow();
      return;
    }
    const r = await syncAllPending(() => listRecordings());
    await logLine(`[review] sync-all uploaded=${r.uploaded} skipped=${r.skipped} failed=${r.failed}`);
    pushReviewState();
    await pushReviewRecordings();
  });

  ipcMain.on("scout:sync-one", async (_e, id: string) => {
    if (!isConfigured()) {
      openAuthWindow();
      return;
    }
    const all = await listRecordings();
    const meta = all.find((r) => r.recording_id === id);
    if (!meta) return;
    await uploadRecording(meta);
    pushReviewState();
    await pushReviewRecordings();
  });

  ipcMain.on("scout:reveal", async (_e, id: string) => {
    const all = await listRecordings();
    const meta = all.find((r) => r.recording_id === id);
    if (!meta) return;
    shell.openPath(meta.dir).catch(() => undefined);
  });

  ipcMain.on("scout:delete", async (_e, id: string) => {
    const ok = await deleteRecording(id);
    if (ok) {
      // Forget the synced marker so it doesn't linger forever.
      const ids = (getSettings().synced_recording_ids ?? []).filter((x) => x !== id);
      if (ids.length !== (getSettings().synced_recording_ids?.length ?? 0)) {
        await saveSettings({ synced_recording_ids: ids });
      }
      await logLine(`[review] deleted ${id}`);
    }
    await pushReviewRecordings();
  });

  ipcMain.on("scout:auth", () => {
    openAuthWindow();
  });

  ipcMain.on("scout:open-folder", () => {
    shell.openPath(path.join(app.getPath("userData"), "recordings")).catch(() => undefined);
  });
}

async function replayMeta(meta: RecordingMeta): Promise<void> {
  if (isCapturing()) {
    dialog.showErrorBox("Scout", "Stop recording before replaying.");
    return;
  }
  if (isReplaying()) return;

  const events = await loadEvents(meta.events_file);
  if (events.length === 0) {
    dialog.showErrorBox("Scout", "Recording has no events.");
    return;
  }
  const choice = await dialog.showMessageBox(win ?? new BrowserWindow({ show: false }), {
    type: "question",
    buttons: ["Cancel", "Replay"],
    defaultId: 1,
    cancelId: 0,
    title: "Scout — replay",
    message: `Replay ${events.length} events from ${meta.recording_id.slice(0, 8)}?`,
    detail:
      `A 3-second countdown begins after you click Replay. Switch to the target app.\n\n` +
      `Press Ctrl+Shift+X (Cmd+Shift+X on macOS) to abort.`,
  });
  if (choice.response !== 1) return;

  try {
    await runEvents(events, meta.recording_id, meta.dir);
  } catch (err) {
    dialog.showErrorBox("Scout", `Replay failed: ${String(err)}`);
  }
}

export function openReviewWindow(): void {
  ensureIpc();
  if (win && !win.isDestroyed()) {
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 600,
    minHeight: 400,
    title: "Scout",
    autoHideMenuBar: true,
    backgroundColor: "#0e0e11",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
    show: false,
  });
  win.removeMenu();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  win.once("ready-to-show", () => {
    win?.show();
  });
  win.on("closed", () => {
    win = null;
  });
}

export function isReviewWindowOpen(): boolean {
  return !!win && !win.isDestroyed();
}
