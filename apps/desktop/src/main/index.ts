import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  nativeImage,
  shell,
} from "electron";
import * as path from "node:path";
import { initLogger, logLine, getLogPath } from "./logger";
import {
  getActiveSession,
  isCapturing,
  onEvent,
  startCapture,
  stopCapture,
} from "./capture";
import {
  getReplayProgress,
  isReplaying,
  onReplayProgress,
  requestAbort,
  runEvents,
} from "./replay";
import { getLastRecording, listRecordings, loadEvents } from "./recordings";
import {
  isConfigured,
  loadSettings,
  onSettingsChange,
  settingsPath,
} from "./settings";
import {
  getSyncStatus,
  onSyncStatus,
  syncAllPending,
  uploadRecording,
} from "./sync";
import { openAuthWindow } from "./auth-window";
import { clearTokenRefresh, refreshTokens, scheduleTokenRefresh } from "./device-link";
import {
  openReviewWindow,
  pushReviewRecordings,
  pushReviewState,
} from "./review-window";
import {
  broadcastBridgeState,
  startBridgeServer,
  stopBridgeServer,
} from "./native-bridge";
import { startUpdater, stopUpdater } from "./updater";

app.setName("scout-desktop");

let tray: Tray | null = null;

const TRAY_ICON_FALLBACK = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAEklEQVR42mNk+M9QwwAEjBQAAH8AA9zX4iEAAAAASUVORK5CYII=",
  "base64"
);

function buildTrayIcon(): Electron.NativeImage {
  const candidate = path.join(__dirname, "..", "..", "assets", "tray-icon.png");
  try {
    const img = nativeImage.createFromPath(candidate);
    if (!img.isEmpty()) return img;
  } catch {
    // fall through
  }
  return nativeImage.createFromBuffer(TRAY_ICON_FALLBACK);
}

async function toggleCapture(): Promise<void> {
  if (isReplaying()) {
    dialog.showErrorBox("Scout", "Cannot start/stop capture while replay is running.");
    return;
  }
  try {
    if (isCapturing()) {
      const done = await stopCapture();
      await logLine(`[stop] events=${done?.event_count ?? 0} id=${done?.recording_id}`);
      rebuildMenu();
      void pushReviewRecordings();
      if (done && isConfigured()) {
        void (async () => {
          const last = await getLastRecording();
          if (last && last.recording_id === done.recording_id) {
            await uploadRecording(last);
            rebuildMenu();
            void pushReviewRecordings();
          }
        })();
      }
    } else {
      const s = await startCapture();
      await logLine(`[start] id=${s.recording_id}`);
      rebuildMenu();
    }
  } catch (err) {
    await logLine(`[error] toggle failed: ${String(err)}`);
    dialog.showErrorBox("Scout", `Capture toggle failed: ${String(err)}`);
    rebuildMenu();
  }
}

async function replayLast(): Promise<void> {
  if (isCapturing()) {
    dialog.showErrorBox("Scout", "Stop recording before replaying.");
    return;
  }
  if (isReplaying()) return;

  const last = await getLastRecording();
  if (!last) {
    dialog.showErrorBox("Scout", "No recordings found. Record something first.");
    return;
  }

  const events = await loadEvents(last.events_file);
  if (events.length === 0) {
    dialog.showErrorBox("Scout", "Last recording has no events.");
    return;
  }

  const choice = await dialog.showMessageBox({
    type: "question",
    buttons: ["Cancel", "Replay"],
    defaultId: 1,
    cancelId: 0,
    title: "Scout — replay",
    message: `Replay ${events.length} events from ${last.recording_id.slice(0, 8)}?`,
    detail:
      `A 3-second countdown begins after you click Replay. Switch to the target app.\n\n` +
      `Press Ctrl+Shift+X (Cmd+Shift+X on macOS) to abort.`,
  });
  if (choice.response !== 1) return;

  rebuildMenu();
  try {
    await runEvents(events, last.recording_id, last.dir);
  } catch (err) {
    dialog.showErrorBox("Scout", `Replay failed: ${String(err)}`);
  }
  rebuildMenu();
}

async function syncNow(): Promise<void> {
  if (!isConfigured()) {
    const choice = await dialog.showMessageBox({
      type: "info",
      buttons: ["Sign in…", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      title: "Scout — sync",
      message: "Sign in to Supabase first.",
      detail: "Recordings stay local until you connect Scout to a Supabase project.",
    });
    if (choice.response === 0) openAuthWindow();
    return;
  }
  const result = await syncAllPending(() => listRecordings());
  rebuildMenu();
  await logLine(
    `[sync-now] uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`
  );
  if (result.failed > 0) {
    dialog.showErrorBox(
      "Scout",
      `${result.failed} recording(s) failed to upload. Check the log.`
    );
  }
}

function rebuildMenu(): void {
  if (!tray) return;
  const capturing = isCapturing();
  const replaying = isReplaying();
  const sess = getActiveSession();
  const rp = getReplayProgress();
  const sync = getSyncStatus();
  const configured = isConfigured();

  let statusLabel: string;
  if (replaying) {
    statusLabel = `▶ Replaying ${rp.current}/${rp.total}${rp.message ? ` — ${rp.message}` : ""}`;
  } else if (capturing) {
    statusLabel = `● Recording (${sess?.event_count ?? 0} events)`;
  } else if (sync.kind === "syncing") {
    statusLabel = `↑ Syncing ${sync.uploaded}/${sync.total}`;
  } else if (sync.kind === "error") {
    statusLabel = `! Sync failed`;
  } else {
    statusLabel = configured ? "Idle (signed in)" : "Idle (not signed in)";
  }

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    {
      label: "Open Scout window…",
      accelerator: "CommandOrControl+Shift+S",
      click: () => {
        openReviewWindow();
      },
    },
    { type: "separator" },
    {
      label: capturing ? "Stop recording" : "Start recording",
      accelerator: "CommandOrControl+Shift+R",
      enabled: !replaying,
      click: () => {
        void toggleCapture();
      },
    },
    {
      label: replaying ? "Abort replay" : "Replay last recording…",
      accelerator: replaying ? "CommandOrControl+Shift+X" : "CommandOrControl+Shift+P",
      enabled: !capturing,
      click: () => {
        if (replaying) requestAbort();
        else void replayLast();
      },
    },
    { type: "separator" },
    {
      label: configured ? "Sync now" : "Sync now (sign in first)",
      enabled: !capturing && sync.kind !== "syncing",
      click: () => {
        void syncNow();
      },
    },
    {
      label: configured ? "Re-configure Supabase…" : "Sign in to Supabase…",
      click: () => {
        openAuthWindow();
      },
    },
    {
      label: "Open settings file",
      click: () => {
        shell.openPath(settingsPath()).catch(() => undefined);
      },
    },
    { type: "separator" },
    {
      label: "Open recordings folder",
      click: () => {
        shell.openPath(path.join(app.getPath("userData"), "recordings")).catch(() => undefined);
      },
    },
    {
      label: "Open log",
      click: () => {
        const p = getLogPath();
        if (p) shell.openPath(p).catch(() => undefined);
      },
    },
    { type: "separator" },
    { label: "Quit Scout", role: "quit" },
  ]);

  tray.setContextMenu(menu);
  if (replaying) tray.setToolTip(`Scout — replaying ${rp.current}/${rp.total}`);
  else if (capturing) tray.setToolTip("Scout — recording");
  else if (sync.kind === "syncing") tray.setToolTip(`Scout — syncing ${sync.uploaded}/${sync.total}`);
  else tray.setToolTip(configured ? "Scout — idle (signed in)" : "Scout — idle");
}

function registerShortcuts(): void {
  globalShortcut.register("CommandOrControl+Shift+R", () => {
    void toggleCapture();
  });
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    void replayLast();
  });
  globalShortcut.register("CommandOrControl+Shift+X", () => {
    requestAbort();
    rebuildMenu();
  });
  globalShortcut.register("CommandOrControl+Shift+S", () => {
    openReviewWindow();
  });
}

async function bootstrap(): Promise<void> {
  await initLogger();
  await loadSettings();
  await logLine(
    `[boot] platform=${process.platform} arch=${process.arch} ` +
      `electron=${process.versions.electron} node=${process.versions.node} ` +
      `configured=${isConfigured()}`
  );

  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  tray = new Tray(buildTrayIcon());
  rebuildMenu();
  registerShortcuts();

  onEvent(() => {
    const s = getActiveSession();
    if (s && s.event_count % 25 === 0) {
      rebuildMenu();
      pushReviewState();
    }
  });
  onReplayProgress(() => {
    rebuildMenu();
    pushReviewState();
    broadcastBridgeState();
  });
  onSyncStatus(() => {
    rebuildMenu();
    pushReviewState();
    broadcastBridgeState();
  });
  onSettingsChange(() => {
    rebuildMenu();
    pushReviewState();
    void pushReviewRecordings();
    broadcastBridgeState();
  });

  startBridgeServer();
  startUpdater();

  // Schedule auto-refresh of the access token if we already have a session,
  // and do an opportunistic refresh on boot to catch tokens that expired
  // while the app was closed.
  if (isConfigured()) {
    void refreshTokens().finally(() => scheduleTokenRefresh());
  }
}

app
  .whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error("bootstrap failed", err);
    dialog.showErrorBox("Scout failed to start", String(err?.stack || err));
    app.quit();
  });

app.on("window-all-closed", () => {
  // Tray-only app.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  clearTokenRefresh();
  stopBridgeServer();
  stopUpdater();
});

app.on("before-quit", async () => {
  if (isCapturing()) await stopCapture();
  if (isReplaying()) requestAbort();
});

void BrowserWindow;
