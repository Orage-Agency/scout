#!/usr/bin/env node
// Chrome Native Messaging broker.
//
// Chrome launches this process whenever the extension calls
// chrome.runtime.connectNative("com.scout.desktop"). We translate between
// Chrome's stdio framing (4-byte LE length + UTF-8 JSON) and the tray app's
// newline-delimited JSON socket on 127.0.0.1:5391.
//
// Tray-not-running behavior: we exit with a single error message so the
// extension sees a clean disconnect with reason. The extension can then prompt
// the user to launch the desktop app.

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const BRIDGE_PORT = 5391;
const LOG = process.env.SCOUT_NATIVE_HOST_LOG;

function log(msg) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  try {
    process.stdout.write(header);
    process.stdout.write(json);
  } catch (err) {
    log(`stdout write failed: ${err}`);
  }
}

function fatal(message) {
  writeMessage({ type: "error", error: message });
  process.exit(0);
}

// Connect to the tray app first; if it's not there, exit clean.
const socket = net.createConnection({ host: "127.0.0.1", port: BRIDGE_PORT }, () => {
  log("connected to tray");
});

socket.setEncoding("utf8");

let socketBuf = "";
socket.on("data", (chunk) => {
  socketBuf += chunk;
  let i = socketBuf.indexOf("\n");
  while (i !== -1) {
    const line = socketBuf.slice(0, i).trim();
    socketBuf = socketBuf.slice(i + 1);
    if (line) {
      try {
        writeMessage(JSON.parse(line));
      } catch (err) {
        log(`bad socket frame: ${err}`);
      }
    }
    i = socketBuf.indexOf("\n");
  }
});

socket.on("error", (err) => {
  log(`socket error: ${err.message}`);
  fatal(
    err.code === "ECONNREFUSED"
      ? "Scout desktop app is not running"
      : `socket error: ${err.message}`
  );
});

socket.on("close", () => {
  log("socket closed by tray");
  process.exit(0);
});

// Read Chrome stdin in NM framing.
let stdinBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const body = stdinBuf.slice(4, 4 + len).toString("utf8");
    stdinBuf = stdinBuf.slice(4 + len);
    try {
      const obj = JSON.parse(body);
      socket.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      log(`bad chrome frame: ${err}`);
    }
  }
});

process.stdin.on("end", () => {
  log("stdin closed by chrome");
  socket.end();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.stack || err.message}`);
  fatal(`uncaught: ${err.message}`);
});

// Note: the path of this script is recorded in the install step. Don't move
// it without re-running install-native-host.js.
void path;
