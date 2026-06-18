// Device-link approval page. Opened by the desktop client; runs inside the
// extension so the user's existing auth session is reused.
//
// Flow:
//   1. Read ?code=XXXX-XXXX from the URL (or accept manual entry).
//   2. If the user isn't signed in, point them at the popup to sign in first.
//   3. Otherwise call /device-link?action=inspect to confirm the code is real
//      and show the client label, then offer Allow / Deny buttons that hit
//      /device-link?action=approve|deny.

import { getAuthSupabase, getDataSupabase, functionUrl } from "../lib/supabase";

interface InspectResp {
  status: string;
  client_label?: string;
  expires_at?: string;
  error?: string;
}

const root = document.getElementById("root")!;

function html(strings: TemplateStringsArray, ...vals: unknown[]): string {
  let out = "";
  strings.forEach((s, i) => {
    out += s + (i < vals.length ? String(vals[i] ?? "") : "");
  });
  return out;
}

function readCodeFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("code") ?? "").toUpperCase().trim();
}

async function getAccessToken(): Promise<string | null> {
  try {
    const auth = getAuthSupabase();
    const { data } = await auth.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function callDeviceLink(
  action: "inspect" | "approve" | "deny",
  userCode: string,
  token: string
): Promise<{ ok: boolean; data?: InspectResp; error?: string }> {
  try {
    const res = await fetch(`${functionUrl("device-link")}?action=${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user_code: userCode }),
    });
    const data = (await res.json().catch(() => ({}))) as InspectResp;
    if (!res.ok) return { ok: false, error: data.error || `${res.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}

function renderSignedOut(): void {
  root.innerHTML = html`
    <h1>Sign in to approve</h1>
    <p>
      Open the Scout extension popup and sign in first, then return to this
      page to approve the desktop app.
    </p>
    <div class="actions">
      <button class="primary" id="retry">I've signed in — refresh</button>
    </div>
  `;
  document.getElementById("retry")?.addEventListener("click", () => {
    void main();
  });
}

function renderManualEntry(): void {
  root.innerHTML = html`
    <h1>Enter device code</h1>
    <p>
      Open the Scout desktop app, click <b>Sign in to Scout</b>, and paste the
      8-character code shown.
    </p>
    <input
      id="code"
      class="code-input"
      placeholder="XXXX-XXXX"
      autocomplete="off"
      maxlength="9"
    />
    <div class="actions">
      <button class="primary" id="go">Continue</button>
    </div>
    <div id="status" class="status"></div>
  `;
  const input = document.getElementById("code") as HTMLInputElement;
  input.focus();
  input.addEventListener("input", () => {
    const v = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    input.value =
      v.length > 4 && !v.includes("-")
        ? `${v.slice(0, 4)}-${v.slice(4, 8)}`
        : v;
  });
  document.getElementById("go")?.addEventListener("click", () => {
    const code = input.value.trim();
    if (code.length < 8) {
      showStatus("Enter the full 8-character code.", "err");
      return;
    }
    void renderConfirm(code);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("go")?.click();
  });
}

function showStatus(text: string, kind: "ok" | "err"): void {
  const el = document.getElementById("status");
  if (!el) return;
  el.className = `status show ${kind}`;
  el.textContent = text;
}

async function renderConfirm(userCode: string): Promise<void> {
  root.innerHTML = `<div class="signed-out">Verifying code…</div>`;
  const token = await getAccessToken();
  if (!token) {
    renderSignedOut();
    return;
  }
  const inspect = await callDeviceLink("inspect", userCode, token);
  if (!inspect.ok) {
    root.innerHTML = html`
      <h1>That code didn't work</h1>
      <p>${inspect.error ?? "Unknown error."}</p>
      <div class="actions">
        <button class="primary" id="retry">Try another code</button>
      </div>
    `;
    document.getElementById("retry")?.addEventListener("click", renderManualEntry);
    return;
  }
  const status = inspect.data?.status ?? "unknown";
  if (status !== "pending") {
    root.innerHTML = html`
      <h1>Code already ${status}</h1>
      <p>This code has been ${status}. Restart the desktop sign-in flow to get a new one.</p>
    `;
    return;
  }

  const label = inspect.data?.client_label ?? "Unknown device";
  root.innerHTML = html`
    <h1>Approve desktop sign-in</h1>
    <p>
      A device is asking to sign in to your Scout account:
    </p>
    <div class="meta">
      <div><b>${escapeHtml(label)}</b></div>
      <div style="margin-top: 4px; color: #808088; font-size: 11px;">Code: ${userCode}</div>
    </div>
    <p>
      If you didn't start this sign-in, click Deny. Approving grants the
      desktop app full access to your recordings.
    </p>
    <div class="actions">
      <button class="danger" id="deny">Deny</button>
      <button class="primary" id="allow">Allow</button>
    </div>
    <div id="status" class="status"></div>
  `;
  document.getElementById("allow")?.addEventListener("click", async () => {
    const btn = document.getElementById("allow") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Approving…";
    const fresh = (await getAccessToken()) ?? token;
    const r = await callDeviceLink("approve", userCode, fresh);
    if (r.ok) {
      root.innerHTML = html`
        <h1>Connected</h1>
        <p>
          The desktop app should pick this up within a few seconds. You can
          close this tab.
        </p>
      `;
    } else {
      showStatus(r.error ?? "approve failed", "err");
      btn.disabled = false;
      btn.textContent = "Allow";
    }
  });
  document.getElementById("deny")?.addEventListener("click", async () => {
    const r = await callDeviceLink("deny", userCode, token);
    if (r.ok) {
      root.innerHTML = html`
        <h1>Denied</h1>
        <p>The sign-in request was rejected. You can close this tab.</p>
      `;
    } else {
      showStatus(r.error ?? "deny failed", "err");
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;"
  );
}

async function main(): Promise<void> {
  // Touch getDataSupabase to ensure the auth bridge is installed in this page
  // context — the popup normally does this, but the device-approve page is a
  // separate document.
  try {
    getDataSupabase();
  } catch {
    /* env not configured — fall through to manual entry */
  }

  const token = await getAccessToken();
  if (!token) {
    renderSignedOut();
    return;
  }
  const code = readCodeFromUrl();
  if (code) {
    await renderConfirm(code);
  } else {
    renderManualEntry();
  }
}

void main();
