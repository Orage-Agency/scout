#!/usr/bin/env node
// Register the Chrome native-messaging host so the Scout extension can call
// chrome.runtime.connectNative("com.scout.desktop").
//
// Writes a JSON manifest in the location Chrome/Chromium expects per platform,
// pointing at scripts/native-host.js. On Windows we additionally write a
// registry value (HKCU). All paths are absolute so the registration survives
// the installer's working directory.
//
// Run via: node scripts/install-native-host.js [--extension-id <id>]
//
// If --extension-id is omitted the default below is used. Multiple IDs may
// be comma-separated. For unpacked dev extensions Chrome assigns a stable ID
// once you set "key" in the manifest, or you can pin one in the dev URL.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");

const HOST_NAME = "com.scout.desktop";
const DEFAULT_EXTENSION_IDS = [
  // Replace at build time with your actual Chrome Web Store extension id.
  "REPLACE_AT_BUILD_EXTENSION_ID",
];

function parseArgs() {
  const out = { ids: DEFAULT_EXTENSION_IDS };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--extension-id") {
      out.ids = (process.argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

function hostScriptPath() {
  return path.resolve(__dirname, "native-host.js");
}

function findNode() {
  // Prefer the same node that ran this installer. On packaged installs we'll
  // replace this with a bundled binary path.
  return process.execPath;
}

function manifest(ids) {
  const script = hostScriptPath();
  // On Windows we point Chrome at a tiny .cmd wrapper that invokes node so
  // we don't have to register a separate "interpreter" key (Chrome doesn't
  // support one). On *nix the script is marked executable + has a shebang.
  const exePath =
    process.platform === "win32"
      ? path.join(path.dirname(script), "native-host.cmd")
      : script;
  return {
    name: HOST_NAME,
    description: "Scout desktop native messaging host",
    path: exePath,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

function writeFileEnsure(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function installWindows(man) {
  const home = os.homedir();
  const manifestDir = path.join(home, "AppData", "Local", "Scout", "NativeMessaging");
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
  writeFileEnsure(manifestPath, JSON.stringify(man, null, 2));

  // Wrapper .cmd that runs node with the script.
  const cmdPath = path.join(path.dirname(hostScriptPath()), "native-host.cmd");
  const cmdBody = `@echo off\r\n"${findNode()}" "${hostScriptPath()}" %*\r\n`;
  writeFileEnsure(cmdPath, cmdBody);

  // HKCU registry pointer. Use reg.exe so we don't need extra deps. Chrome
  // and Chromium share the same key.
  const keys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  ];
  for (const k of keys) {
    try {
      execSync(`reg add "${k}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: "ignore" });
    } catch (err) {
      console.error(`reg add ${k} failed: ${err.message}`);
    }
  }
  return manifestPath;
}

function installPosix(man) {
  // Make the script executable.
  try {
    fs.chmodSync(hostScriptPath(), 0o755);
  } catch {
    /* ignore */
  }
  const home = os.homedir();
  const dirs = [];
  if (process.platform === "darwin") {
    dirs.push(
      path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      path.join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts")
    );
  } else {
    dirs.push(
      path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      path.join(home, ".config", "chromium", "NativeMessagingHosts"),
      path.join(home, ".config", "microsoft-edge", "NativeMessagingHosts")
    );
  }
  const written = [];
  for (const d of dirs) {
    const p = path.join(d, `${HOST_NAME}.json`);
    try {
      writeFileEnsure(p, JSON.stringify(man, null, 2));
      written.push(p);
    } catch (err) {
      console.error(`write ${p} failed: ${err.message}`);
    }
  }
  return written.join("\n");
}

function main() {
  const args = parseArgs();
  if (!args.ids.length || args.ids.includes("REPLACE_AT_BUILD_EXTENSION_ID")) {
    console.warn(
      "Warning: using placeholder extension id. Re-run with --extension-id <id> for production."
    );
  }
  const man = manifest(args.ids);
  let written;
  if (process.platform === "win32") {
    written = installWindows(man);
  } else {
    written = installPosix(man);
  }
  console.log("Installed Scout native-messaging host.");
  console.log("Manifest:\n  " + written);
  console.log(`Host name: ${HOST_NAME}`);
  console.log(`Allowed origins: ${man.allowed_origins.join(", ")}`);
}

main();
