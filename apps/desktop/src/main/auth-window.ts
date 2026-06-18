// Device-link sign-in window.
//
// Opens a small BrowserWindow that mints a user_code via the /device-link
// edge function, shows it to the user, opens the verification URL in the
// system browser, and polls until approval. On approval the access + refresh
// tokens are saved and the window closes itself.
//
// An "advanced" disclosure exposes the legacy paste-token flow as a fallback
// for installs where the device-link function isn't deployed (self-hosted,
// dev).

import { BrowserWindow, ipcMain, shell, clipboard } from "electron";
import * as os from "node:os";
import { saveSettings } from "./settings";
import {
  pollDeviceFlow,
  scheduleTokenRefresh,
  startDeviceFlow,
  type DeviceCodeResp,
} from "./device-link";
import { logLine } from "./logger";

let win: BrowserWindow | null = null;
let ipcRegistered = false;
let pollAbort = false;

const HTML = `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Scout — Sign in</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 24px; background: #1a1a1d; color: #f0f0f0; margin: 0; min-height: 100vh; }
  h1 { font-size: 16px; margin: 0 0 6px; font-weight: 600; }
  p { font-size: 12px; color: #a0a0a8; margin: 0 0 18px; line-height: 1.5; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 30px; letter-spacing: 0.18em; text-align: center; padding: 22px 12px; background: #26262b; border: 1px solid #3a3a42; border-radius: 8px; font-weight: 600; }
  .code small { display: block; font-size: 10px; color: #808088; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 8px; font-weight: 500; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { background: #6366f1; color: white; border: 0; padding: 10px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; flex: 1; }
  button:hover { background: #5258ee; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: transparent; color: #c0c0c8; border: 1px solid #3a3a42; }
  button.secondary:hover { background: #26262b; }
  .status { margin-top: 18px; font-size: 12px; color: #a0a0a8; min-height: 18px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #6366f1; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
  .dot.ok { background: #22c55e; animation: none; }
  .dot.err { background: #ef4444; animation: none; }
  .toggle { font-size: 11px; color: #6366f1; cursor: pointer; user-select: none; margin-top: 18px; display: inline-block; }
  .toggle:hover { text-decoration: underline; }
  .advanced { display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid #3a3a42; }
  .advanced.open { display: block; }
  .advanced label { display: block; font-size: 11px; margin-bottom: 4px; color: #c0c0c8; text-transform: uppercase; letter-spacing: 0.04em; }
  .advanced input { width: 100%; padding: 7px 9px; background: #26262b; border: 1px solid #3a3a42; color: #f0f0f0; border-radius: 5px; margin-bottom: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .advanced input:focus { outline: 0; border-color: #6366f1; }
  .error-box { background: #2b1a1d; border: 1px solid #5a2a30; color: #fca5a5; padding: 10px 12px; border-radius: 6px; font-size: 11px; margin-top: 16px; line-height: 1.5; display: none; }
  .error-box.show { display: block; }
</style>
</head><body>
<h1>Connect Scout</h1>
<p id="intro">Enter this code in your browser to link this device to your Scout account.</p>

<div class="code" id="code-box">
  <small>Verification code</small>
  <span id="user-code">––––-––––</span>
</div>

<div class="actions">
  <button class="secondary" id="copy-btn" disabled>Copy code</button>
  <button id="open-btn" disabled>Open verify page</button>
</div>

<div class="status" id="status">
  <span class="dot" id="status-dot"></span>
  <span id="status-text">Requesting code…</span>
</div>

<div class="error-box" id="error-box"></div>

<span class="toggle" id="adv-toggle">Advanced: paste tokens manually</span>

<div class="advanced" id="advanced">
  <p>For self-hosted setups without the device-link function deployed.</p>
  <label>Project URL</label>
  <input id="m-url" placeholder="https://abc.supabase.co" autocomplete="off" />
  <label>Anon key</label>
  <input id="m-key" placeholder="eyJ…" autocomplete="off" />
  <label>Access token</label>
  <input id="m-token" placeholder="eyJ…" autocomplete="off" />
  <label>Refresh token (optional)</label>
  <input id="m-refresh" placeholder="optional" autocomplete="off" />
  <div class="actions">
    <button class="secondary" id="m-cancel">Cancel</button>
    <button id="m-save">Save</button>
  </div>
</div>

<script>
  const { ipcRenderer } = require('electron');
  const els = {
    userCode: document.getElementById('user-code'),
    copyBtn:  document.getElementById('copy-btn'),
    openBtn:  document.getElementById('open-btn'),
    statusDot:document.getElementById('status-dot'),
    statusTxt:document.getElementById('status-text'),
    intro:    document.getElementById('intro'),
    errorBox: document.getElementById('error-box'),
    advToggle:document.getElementById('adv-toggle'),
    advanced: document.getElementById('advanced'),
    mUrl:     document.getElementById('m-url'),
    mKey:     document.getElementById('m-key'),
    mTok:     document.getElementById('m-token'),
    mRef:     document.getElementById('m-refresh'),
    mSave:    document.getElementById('m-save'),
    mCancel:  document.getElementById('m-cancel'),
  };

  let verifyUrl = '';
  let userCode = '';

  function setStatus(text, kind) {
    els.statusTxt.textContent = text;
    els.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  }
  function setError(text) {
    if (!text) { els.errorBox.classList.remove('show'); els.errorBox.textContent = ''; return; }
    els.errorBox.classList.add('show');
    els.errorBox.textContent = text;
  }

  async function start() {
    setStatus('Requesting code…');
    const resp = await ipcRenderer.invoke('auth:start-device');
    if (!resp.ok) {
      setStatus('Could not get a device code', 'err');
      setError(resp.error || 'unknown error');
      return;
    }
    userCode = resp.user_code;
    verifyUrl = resp.verification_url_complete;
    els.userCode.textContent = userCode;
    els.copyBtn.disabled = false;
    els.openBtn.disabled = false;
    setStatus('Waiting for you to approve in the browser…');
    // Auto-open the browser to make it one-click.
    ipcRenderer.send('auth:open-url', verifyUrl);
  }

  els.copyBtn.onclick = () => {
    ipcRenderer.send('auth:copy', userCode);
    const orig = els.copyBtn.textContent;
    els.copyBtn.textContent = 'Copied!';
    setTimeout(() => { els.copyBtn.textContent = orig; }, 1200);
  };
  els.openBtn.onclick = () => ipcRenderer.send('auth:open-url', verifyUrl);

  els.advToggle.onclick = () => {
    els.advanced.classList.toggle('open');
    els.advToggle.textContent = els.advanced.classList.contains('open')
      ? 'Hide advanced'
      : 'Advanced: paste tokens manually';
  };
  els.mCancel.onclick = () => ipcRenderer.send('auth:cancel');
  els.mSave.onclick = () => {
    ipcRenderer.send('auth:manual-save', {
      url: els.mUrl.value.trim(),
      key: els.mKey.value.trim(),
      token: els.mTok.value.trim(),
      refresh: els.mRef.value.trim(),
    });
  };

  ipcRenderer.on('auth:device-status', (_e, msg) => {
    if (msg.status === 'approved') {
      setStatus('Connected. Closing…', 'ok');
      setError('');
    } else if (msg.status === 'expired') {
      setStatus('Code expired', 'err');
      setError('This code is no longer valid. Click Retry to get a new one.');
      els.copyBtn.disabled = true;
      els.openBtn.disabled = true;
      const r = document.createElement('button');
      r.textContent = 'Retry'; r.onclick = () => { setError(''); start(); };
      document.querySelector('.actions').appendChild(r);
    } else if (msg.status === 'denied') {
      setStatus('Approval denied', 'err');
      setError('The request was rejected in the browser.');
    } else if (msg.status === 'not_found') {
      setStatus('Code missing', 'err');
      setError('The server did not recognize the device code.');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipcRenderer.send('auth:cancel');
  });

  start();
</script>
</body></html>`;

async function pollLoop(
  resp: DeviceCodeResp,
  webContents: Electron.WebContents
): Promise<void> {
  const startTime = Date.now();
  const deadline = startTime + resp.expires_in * 1000;
  const intervalMs = Math.max(2, resp.interval) * 1000;

  while (!pollAbort) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (pollAbort) return;
    if (Date.now() > deadline) {
      if (!webContents.isDestroyed()) {
        webContents.send("auth:device-status", { status: "expired" });
      }
      return;
    }
    try {
      const r = await pollDeviceFlow(resp.device_code);
      if (r.status === "approved" && r.access_token && r.refresh_token) {
        await saveSettings({
          access_token: r.access_token,
          refresh_token: r.refresh_token,
          user_id: undefined,
        });
        scheduleTokenRefresh();
        await logLine(`[auth] device-link approved user=${r.user_id ?? "?"}`);
        if (!webContents.isDestroyed()) {
          webContents.send("auth:device-status", { status: "approved" });
        }
        setTimeout(() => {
          if (win && !win.isDestroyed()) win.close();
        }, 1500);
        return;
      }
      if (r.status === "denied" || r.status === "expired" || r.status === "not_found") {
        if (!webContents.isDestroyed()) {
          webContents.send("auth:device-status", { status: r.status });
        }
        return;
      }
      // pending → keep going
    } catch (err) {
      await logLine(`[auth] poll error: ${String(err)}`);
    }
  }
}

function ensureIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("auth:start-device", async (e) => {
    pollAbort = false;
    try {
      const label = `${os.hostname()} (${process.platform})`;
      const resp = await startDeviceFlow(label);
      await logLine(`[auth] device-link started user_code=${resp.user_code}`);
      void pollLoop(resp, e.sender);
      return {
        ok: true,
        user_code: resp.user_code,
        verification_url: resp.verification_url,
        verification_url_complete: resp.verification_url_complete,
        expires_in: resp.expires_in,
      };
    } catch (err) {
      await logLine(`[auth] device-link start failed: ${String(err)}`);
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  });

  ipcMain.on("auth:open-url", (_e, url: string) => {
    if (typeof url === "string" && url.startsWith("http")) {
      shell.openExternal(url).catch(() => undefined);
    }
  });

  ipcMain.on("auth:copy", (_e, text: string) => {
    if (typeof text === "string") clipboard.writeText(text);
  });

  ipcMain.on("auth:cancel", () => {
    pollAbort = true;
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on(
    "auth:manual-save",
    async (
      _e,
      payload: { url?: string; key?: string; token?: string; refresh?: string }
    ) => {
      pollAbort = true;
      await saveSettings({
        supabase_url: payload.url || undefined,
        supabase_anon_key: payload.key || undefined,
        access_token: payload.token || undefined,
        refresh_token: payload.refresh || undefined,
        user_id: undefined,
      });
      scheduleTokenRefresh();
      if (win && !win.isDestroyed()) win.close();
    }
  );
}

export function openAuthWindow(): void {
  ensureIpc();
  if (win && !win.isDestroyed()) {
    win.focus();
    return;
  }
  pollAbort = false;
  win = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Scout — Sign in",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  win.on("closed", () => {
    pollAbort = true;
    win = null;
  });
}
