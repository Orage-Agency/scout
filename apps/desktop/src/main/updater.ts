// Thin wrapper around electron-updater. Wired into bootstrap so packaged
// builds check the `generic` publish channel declared in electron-builder.yml.
//
// In dev (when the app is run via `electron .` without an installer) the
// updater silently no-ops because electron-updater can't compare against a
// known install. Same for unsigned builds on macOS — Squirrel.Mac refuses to
// apply unsigned updates and we'd just log a noisy error per check.

import { app } from "electron";
import { logLine } from "./logger";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let timer: NodeJS.Timeout | null = null;
let started = false;

export function startUpdater(): void {
  if (started) return;
  started = true;

  if (!app.isPackaged) {
    void logLine("[updater] dev build — skipping auto-update");
    return;
  }

  let autoUpdater: typeof import("electron-updater").autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    void logLine(`[updater] electron-updater not available: ${String(err)}`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => void logLine(`[updater] ${String(m)}`),
    warn: (m: unknown) => void logLine(`[updater:warn] ${String(m)}`),
    error: (m: unknown) => void logLine(`[updater:error] ${String(m)}`),
    debug: () => undefined,
  } as never;

  autoUpdater.on("update-available", (info) => {
    void logLine(`[updater] update available: ${info?.version ?? "?"}`);
  });
  autoUpdater.on("update-not-available", () => {
    void logLine("[updater] up to date");
  });
  autoUpdater.on("update-downloaded", (info) => {
    void logLine(`[updater] downloaded ${info?.version ?? "?"} — will install on quit`);
  });
  autoUpdater.on("error", (err) => {
    void logLine(`[updater] error: ${String(err)}`);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => {
      void logLine(`[updater] checkForUpdates failed: ${String(err)}`);
    });
  };

  // First check ~10s after launch so we don't compete with bootstrap I/O.
  setTimeout(check, 10_000);
  timer = setInterval(check, CHECK_INTERVAL_MS);
}

export function stopUpdater(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
