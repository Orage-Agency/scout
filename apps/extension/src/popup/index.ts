// Popup UI — vanilla TS rendering. Three tabs: Record, Library, Settings.
// On open we hydrate from chrome.storage.session so the right state shows.

import { getSupabase, functionUrl } from "../lib/supabase";
import type { RecordingRow, SkillRow, RecordingSessionState, RuntimeMessage } from "../lib/types";
import { marked } from "marked";
import { zipSync, strToU8 } from "fflate";

type View =
  | { kind: "loading" }
  | { kind: "signed_out"; mode: "signin" | "signup" }
  | { kind: "idle"; tab: "record" | "library" | "settings" }
  | { kind: "recording"; state: RecordingSessionState }
  | { kind: "skill"; recording: RecordingRow; skill: SkillRow | null };

const root = document.getElementById("app")!;
let view: View = { kind: "loading" };

async function init(): Promise<void> {
  const sb = getSupabase();
  const { data: sess } = await sb.auth.getSession();
  if (!sess.session) {
    view = { kind: "signed_out", mode: "signin" };
    return render();
  }
  const { state } = (await chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage)) ?? {};
  if (state) view = { kind: "recording", state };
  else view = { kind: "idle", tab: "record" };
  render();
}

function render(): void {
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "min-h-[480px] flex flex-col";
  switch (view.kind) {
    case "loading":
      wrap.appendChild(loadingView());
      break;
    case "signed_out":
      wrap.appendChild(signedOutView(view.mode));
      break;
    case "idle":
      wrap.appendChild(header(view.tab));
      wrap.appendChild(idleView(view.tab));
      break;
    case "recording":
      wrap.appendChild(header(null));
      wrap.appendChild(recordingView(view.state));
      break;
    case "skill":
      wrap.appendChild(header(null));
      wrap.appendChild(skillView(view.recording, view.skill));
      break;
  }
  root.appendChild(wrap);
}

// ---- Header / tabs ----

function header(active: "record" | "library" | "settings" | null): HTMLElement {
  const h = document.createElement("header");
  h.className = "px-4 py-3 border-b border-line flex items-center gap-3";
  h.innerHTML = `
    <span class="font-semibold tracking-tight">Scout</span>
    <span class="text-muted text-xs">v0.1.0</span>
    <span class="ml-auto"></span>
  `;
  if (active) {
    const nav = document.createElement("nav");
    nav.className = "flex gap-1 text-xs";
    for (const t of ["record", "library", "settings"] as const) {
      const b = document.createElement("button");
      b.className = `px-2 py-1 rounded-sm ${active === t ? "bg-elevated text-primary" : "text-muted hover:text-primary"}`;
      b.textContent = t[0].toUpperCase() + t.slice(1);
      b.onclick = () => {
        view = { kind: "idle", tab: t };
        render();
      };
      nav.appendChild(b);
    }
    h.appendChild(nav);
  }
  return h;
}

// ---- Loading ----

function loadingView(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 flex items-center justify-center text-muted text-sm";
  d.textContent = "Loading…";
  return d;
}

// ---- Auth ----

function signedOutView(mode: "signin" | "signup"): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 flex flex-col items-center justify-center px-8 gap-3 text-center";
  const isSignup = mode === "signup";
  const cta = isSignup ? "Create account" : "Sign in";
  const altLabel = isSignup ? "Already have an account? Sign in" : "New here? Create an account";
  d.innerHTML = `
    <div class="text-2xl font-semibold tracking-tight">Scout</div>
    <p class="text-muted text-sm leading-relaxed">Capture your workflows. Generate skill files for AI agents.</p>
    <input id="email" type="email" autocomplete="email" placeholder="you@company.com" class="input mt-2" />
    <input id="pw" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" placeholder="Password" class="input" />
    <button id="go" class="btn btn-primary w-full">${cta}</button>
    <button id="alt" class="btn btn-ghost mt-1 text-xs">${altLabel}</button>
    <p id="err" class="text-accent text-xs"></p>
  `;
  const emailEl = d.querySelector<HTMLInputElement>("#email")!;
  const pwEl = d.querySelector<HTMLInputElement>("#pw")!;
  const errEl = d.querySelector<HTMLParagraphElement>("#err")!;
  const submit = async () => {
    const email = emailEl.value.trim();
    const password = pwEl.value;
    if (!email) { errEl.textContent = "Enter your email."; return; }
    if (password.length < 8) { errEl.textContent = "Password must be at least 8 characters."; return; }
    errEl.textContent = "";
    try {
      const sb = getSupabase();
      const { error } = isSignup
        ? await sb.auth.signUp({ email, password })
        : await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // onAuthStateChange flips the view to idle.
    } catch (e) {
      errEl.textContent = String((e as Error).message ?? e);
    }
  };
  d.querySelector<HTMLButtonElement>("#go")!.onclick = () => void submit();
  pwEl.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
  d.querySelector<HTMLButtonElement>("#alt")!.onclick = () => {
    view = { kind: "signed_out", mode: isSignup ? "signin" : "signup" };
    render();
  };
  return d;
}

// ---- Idle (tabbed) ----

function idleView(tab: "record" | "library" | "settings"): HTMLElement {
  if (tab === "record") return recordTab();
  if (tab === "library") return libraryTab();
  return settingsTab();
}

function recordTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 flex flex-col items-center justify-center gap-3 px-8 py-10 text-center";
  d.innerHTML = `
    <button id="rec" class="w-24 h-24 rounded-full bg-accent hover:bg-accent-quiet transition-colors flex items-center justify-center text-primary text-3xl">●</button>
    <div class="text-sm font-medium">Start Recording</div>
    <p class="text-muted text-xs leading-relaxed">Press to begin. We'll capture clicks, key presses, screenshots, and your voice while you narrate.</p>
    <p id="warn" class="text-warning text-xs leading-snug hidden"></p>
  `;
  const warnEl = d.querySelector<HTMLParagraphElement>("#warn")!;
  // Show a hint if the active tab is one Chrome blocks content scripts on —
  // recording technically still runs (audio + tab events) but no clicks/keys
  // are captured, which looks like "nothing's happening".
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.url) return;
    const blocked = /^(chrome|chrome-extension|edge|about|view-source):/i.test(tab.url)
      || /^https:\/\/chrome\.google\.com\/webstore/i.test(tab.url)
      || /^https:\/\/chromewebstore\.google\.com/i.test(tab.url);
    if (blocked) {
      warnEl.textContent = "Chrome blocks recording on this page. Open a regular site (gmail.com, your CRM, etc.) first.";
      warnEl.classList.remove("hidden");
    }
  });
  d.querySelector<HTMLButtonElement>("#rec")!.onclick = async () => {
    const resp = await chrome.runtime.sendMessage({ type: "popup:start_recording" } satisfies RuntimeMessage);
    if (resp?.state) {
      view = { kind: "recording", state: resp.state };
      render();
    } else {
      warnEl.textContent = "Could not start recording. Are you signed in?";
      warnEl.classList.remove("hidden");
    }
  };
  return d;
}

function libraryTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-4 py-4 overflow-y-auto";
  d.innerHTML = `<div class="label mb-2">Library</div><div id="list" class="space-y-2"></div>`;
  loadLibrary(d.querySelector<HTMLDivElement>("#list")!);
  return d;
}

async function loadLibrary(container: HTMLDivElement): Promise<void> {
  container.innerHTML = `<div class="text-muted text-xs">Loading…</div>`;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("recordings")
    .select("*, skills(id,version,title,created_at)")
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) {
    container.innerHTML = `<div class="text-accent text-xs">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data?.length) {
    container.innerHTML = `<div class="text-muted text-xs">No recordings yet. Hit record to make your first one.</div>`;
    return;
  }
  container.innerHTML = "";
  for (const r of data as Array<RecordingRow & { skills: SkillRow[] }>) {
    const card = document.createElement("button");
    card.className = "w-full card text-left hover:bg-line/30 transition-colors";
    const title = r.title || "Untitled recording";
    const date = new Date(r.started_at).toLocaleString();
    const dur = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : "—";
    const status = r.status;
    const hasSkill = (r.skills?.length ?? 0) > 0;
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium truncate">${escapeHtml(title)}</div>
          <div class="text-xs text-muted mt-0.5">${escapeHtml(date)} · ${dur}</div>
        </div>
        <span class="text-[10px] uppercase tracking-wide ${statusColor(status)}">${status}</span>
      </div>
      <div class="mt-2 text-xs text-muted">${hasSkill ? "Skill ready" : "No skill yet"}</div>
    `;
    card.onclick = () => {
      view = { kind: "skill", recording: r, skill: r.skills?.[0] ?? null };
      render();
    };
    container.appendChild(card);
  }
}

function statusColor(s: string): string {
  if (s === "ready") return "text-success";
  if (s === "failed") return "text-accent";
  if (s === "transcribing" || s === "uploading") return "text-warning";
  return "text-muted";
}

function settingsTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-4 py-4 space-y-4";
  d.innerHTML = `
    <div class="label">Account</div>
    <div id="who" class="text-sm text-muted">…</div>
    <button id="signout" class="btn">Sign out</button>
    <div class="label pt-4">Data</div>
    <button id="del" class="btn">Delete all my data</button>
    <p class="text-muted text-xs">Cascades through recordings, events, screenshots, audio, and skills.</p>
  `;
  const sb = getSupabase();
  sb.auth.getUser().then(({ data }) => {
    d.querySelector<HTMLDivElement>("#who")!.textContent = data.user?.email ?? "—";
  });
  d.querySelector<HTMLButtonElement>("#signout")!.onclick = async () => {
    await sb.auth.signOut();
    view = { kind: "signed_out", mode: "signin" };
    render();
  };
  d.querySelector<HTMLButtonElement>("#del")!.onclick = async () => {
    if (!confirm("Permanently delete all of your recordings and skills?")) return;
    const { data: auth } = await sb.auth.getUser();
    if (!auth.user) return;
    await sb.from("recordings").delete().eq("user_id", auth.user.id);
    alert("Deleted.");
  };
  return d;
}

// ---- Recording state ----

function recordingView(s: RecordingSessionState): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-4 py-6 flex flex-col gap-3";
  const startedMs = s.started_at;
  const audioBadge = s.audio_supported
    ? `<span class="text-[10px] uppercase tracking-wide text-success">audio on</span>`
    : `<span class="text-[10px] uppercase tracking-wide text-warning" title="Mic denied or unavailable. Recording continues without narration.">audio off</span>`;
  const tabTitle = s.active_tab_title?.trim() || (s.active_tab_url ? new URL(s.active_tab_url).hostname : "—");
  d.innerHTML = `
    <div class="card">
      <div class="flex items-center gap-2">
        <span class="record-dot"></span>
        <span class="text-sm font-medium">Recording</span>
        ${audioBadge}
        <span id="t" class="ml-auto font-mono tabular-nums text-sm">00:00</span>
      </div>
      <div id="tabname" class="text-xs text-muted mt-2 truncate" title="${escapeHtml(tabTitle)}">on ${escapeHtml(tabTitle)}</div>
      <div id="evcount" class="text-xs text-muted mt-1">${s.event_count ?? 0} events · ${s.shot_count ?? 0} screenshots</div>
    </div>
    <div class="flex gap-2">
      <button id="pause" class="btn flex-1">${s.is_paused ? "Resume" : "Pause"}</button>
      <button id="stop" class="btn btn-primary flex-1">Stop</button>
    </div>
    <p class="text-muted text-xs leading-relaxed">Switch tabs freely. The control bar in the page is also yours.</p>
  `;
  const tEl = d.querySelector<HTMLSpanElement>("#t")!;
  setInterval(() => {
    const ms = Date.now() - startedMs;
    const sec = Math.floor(ms / 1000) % 60;
    const min = Math.floor(ms / 60000);
    tEl.textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }, 500);
  d.querySelector<HTMLButtonElement>("#pause")!.onclick = async () => {
    const t = s.is_paused ? "popup:resume_recording" : "popup:pause_recording";
    await chrome.runtime.sendMessage({ type: t } satisfies RuntimeMessage);
    s.is_paused = !s.is_paused;
    render();
  };
  d.querySelector<HTMLButtonElement>("#stop")!.onclick = async () => {
    const recordingId = s.recording_id;
    await chrome.runtime.sendMessage({ type: "popup:stop_recording" } satisfies RuntimeMessage);
    // Pull the freshly-updated recording row (status is now 'uploading' or
    // later) and drop straight into the skill view. Generate Skill is
    // available immediately even before transcribe finishes — events are
    // already flushed.
    const sb = getSupabase();
    const { data: rec } = await sb.from("recordings").select("*").eq("id", recordingId).single();
    if (rec) {
      view = { kind: "skill", recording: rec as RecordingRow, skill: null };
    } else {
      // Edge case: row vanished. Fall back to library so the user has a path.
      view = { kind: "idle", tab: "library" };
    }
    render();
  };
  return d;
}

// ---- Skill side-panel view ----

function skillView(rec: RecordingRow, skill: SkillRow | null): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-4 py-4 overflow-y-auto";

  const back = document.createElement("button");
  back.className = "btn btn-ghost mb-3";
  back.textContent = "← Back to library";
  back.onclick = () => {
    view = { kind: "idle", tab: "library" };
    render();
  };
  d.appendChild(back);

  const meta = document.createElement("div");
  meta.className = "card mb-3";
  meta.innerHTML = `
    <div class="text-sm font-medium">${escapeHtml(rec.title || "Untitled recording")}</div>
    <div class="text-xs text-muted mt-1">${escapeHtml(new Date(rec.started_at).toLocaleString())} · ${
    rec.duration_ms ? Math.round(rec.duration_ms / 1000) + "s" : "—"
  } · ${rec.status}</div>
  `;
  d.appendChild(meta);

  if (!skill) {
    const gen = document.createElement("div");
    gen.className = "card";
    gen.innerHTML = `
      <div class="text-sm mb-2">No skill generated for this recording.</div>
      <button id="gen" class="btn btn-primary w-full">Generate Skill</button>
      <div id="genstatus" class="text-xs text-muted mt-2"></div>
    `;
    gen.querySelector<HTMLButtonElement>("#gen")!.onclick = () => generate(rec.id, gen);
    d.appendChild(gen);
    return d;
  }

  // Skill ready: render markdown + actions.
  const actions = document.createElement("div");
  actions.className = "grid grid-cols-2 gap-2 mb-3";
  actions.innerHTML = `
    <button id="claude" class="btn btn-primary col-span-2">Save as Claude Code skill (.zip)</button>
    <button id="cp" class="btn">Copy</button>
    <button id="dl" class="btn">Save .md</button>
    <button id="rg" class="btn col-span-2">Regenerate</button>
  `;
  actions.querySelector<HTMLButtonElement>("#claude")!.onclick = () => downloadClaudeSkill(skill);
  actions.querySelector<HTMLButtonElement>("#dl")!.onclick = () => downloadMd(skill);
  actions.querySelector<HTMLButtonElement>("#cp")!.onclick = async () => {
    await navigator.clipboard.writeText(skill.body_md);
    actions.querySelector<HTMLButtonElement>("#cp")!.textContent = "Copied";
  };
  actions.querySelector<HTMLButtonElement>("#rg")!.onclick = () => {
    const extra = prompt("Optional: extra guidance for regeneration", "");
    generate(rec.id, d, extra ?? undefined);
  };
  d.appendChild(actions);

  // One-line install hint so the user knows where the zip goes.
  const slug = (skill.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? "skill").trim();
  const hint = document.createElement("div");
  hint.className = "card text-xs text-muted leading-relaxed mb-3";
  hint.innerHTML = `
    <div class="text-primary font-medium mb-1">To use with Claude Code</div>
    <div>Click <b>Save as Claude Code skill</b>, then extract the zip into <code class="text-primary">~/.claude/skills/</code>. The skill will be available in your next Claude Code session as <code class="text-primary">${escapeHtml(slug)}</code>.</div>
  `;
  d.appendChild(hint);

  // Split YAML frontmatter from the markdown body so marked() doesn't mangle
  // the `---\nname: ...\n---` block into a horizontal-rule + heading. We
  // render the frontmatter as a small metadata strip above the prose.
  // Also strip any `![](step_N.png)` placeholders the model may have added
  // despite the system prompt — those resolve to non-existent paths inside
  // the chrome-extension:// origin and would 404.
  const { frontmatter, body } = splitFrontmatter(stripImageRefs(skill.body_md));
  if (frontmatter) {
    const fm = document.createElement("div");
    // whitespace-pre-wrap preserves newlines but lets long lines wrap inside
    // the 380px popup column. break-words handles long URL-like values too.
    fm.className = "card mb-3 text-xs font-mono leading-relaxed text-muted whitespace-pre-wrap break-words";
    fm.textContent = frontmatter;
    d.appendChild(fm);
  }

  const md = document.createElement("article");
  md.className = "skill-md text-primary";
  md.innerHTML = marked.parse(body, { async: false }) as string;
  d.appendChild(md);
  return d;
}

// Strip the leading YAML frontmatter (a `---` ... `---` block) and return the
// raw frontmatter text + the remaining body. If no frontmatter is present,
// returns an empty frontmatter string and the original input as body.
function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: "", body: md };
  return { frontmatter: m[1].trim(), body: md.slice(m[0].length) };
}

// Remove `![alt](path)` markdown image references from the body. The Edge
// Function's system prompt asks Claude not to emit these, but it sometimes
// does — and there's no real image to load in the popup anyway.
function stripImageRefs(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[ \t]+\n/g, "\n");
}

async function generate(recordingId: string, container: HTMLElement, extra?: string): Promise<void> {
  const status = container.querySelector<HTMLDivElement>("#genstatus") ?? container;
  status.textContent = "Generating skill… this can take 30–60s.";
  try {
    const sb = getSupabase();
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(functionUrl("generate-skill"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ recording_id: recordingId, extra }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const skill = (await res.json()) as SkillRow;
    // Refresh: load recording + skill into view.
    const { data: rec } = await sb.from("recordings").select("*").eq("id", recordingId).single();
    view = { kind: "skill", recording: rec as RecordingRow, skill };
    render();
  } catch (e) {
    status.textContent = `Error: ${(e as Error).message}`;
  }
}

function downloadMd(skill: SkillRow): void {
  const blob = new Blob([skill.body_md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${skill.title || "skill"}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Build a zip with the structure Claude Code expects:
//   <slug>/SKILL.md
//   <slug>/README.txt   (one-line note about where this came from)
// User extracts the zip into ~/.claude/skills/ and the skill is available
// in their next Claude Code session.
function downloadClaudeSkill(skill: SkillRow): void {
  const slug = (skill.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? "scout-skill").trim();
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "-");
  const readme = [
    `Generated by Scout — ${new Date().toISOString().slice(0, 10)}`,
    `Recording title: ${skill.title ?? "(untitled)"}`,
    ``,
    `To use this skill with Claude Code:`,
    `  1. Extract this zip into ~/.claude/skills/   (so the skill ends up at ~/.claude/skills/${safeSlug}/SKILL.md)`,
    `  2. Restart Claude Code (or start a new session)`,
    `  3. Claude will discover this skill via its frontmatter`,
    ``,
  ].join("\n");
  const zip = zipSync({
    [`${safeSlug}/SKILL.md`]: strToU8(skill.body_md),
    [`${safeSlug}/README.txt`]: strToU8(readme),
  });
  const blob = new Blob([zip as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeSlug}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ---- Boot ----

void init();

// Re-render if auth state flips (e.g. magic link click in another tab).
const sb = getSupabase();
sb.auth.onAuthStateChange((_evt, sess) => {
  if (!sess && view.kind !== "signed_out") {
    view = { kind: "signed_out", mode: "signin" };
    render();
  } else if (sess && (view.kind === "signed_out" || view.kind === "loading")) {
    // signInWithPassword / signUp success lands here.
    view = { kind: "idle", tab: "record" };
    render();
  }
});

// Listen for live updates pushed by the service worker so the popup never
// shows a stale view (recording status, audio availability, etc).
chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === "popup:state") {
    // Audio support or pause state changed mid-recording. Only refresh if
    // we're actually showing the recording view for that session.
    if (view.kind === "recording" && msg.state && msg.state.recording_id === view.state.recording_id) {
      view = { kind: "recording", state: msg.state };
      render();
    }
    return;
  }
  if (msg.type === "popup:counts") {
    // Update counters in place without a full re-render so the timer doesn't
    // reset every time an event lands.
    if (view.kind === "recording") {
      view.state.event_count = msg.event_count;
      view.state.shot_count = msg.shot_count;
      const el = document.getElementById("evcount");
      if (el) el.textContent = `${msg.event_count} events · ${msg.shot_count} screenshots`;
    }
    return;
  }
  if (msg.type === "popup:recording_changed") {
    // Skill view of the affected recording — pull a fresh row so status,
    // duration, and any newly-attached skill all reflect reality.
    if (view.kind === "skill" && view.recording.id === msg.recording_id) {
      void refreshSkillView(msg.recording_id);
      return;
    }
    // Library tab — re-render to pull fresh statuses.
    if (view.kind === "idle" && view.tab === "library") {
      render();
    }
  }
});

async function refreshSkillView(recordingId: string): Promise<void> {
  const sb2 = getSupabase();
  const { data: rec } = await sb2
    .from("recordings")
    .select("*, skills(id,recording_id,user_id,version,title,body_md,prompt_used,created_at)")
    .eq("id", recordingId)
    .single();
  if (!rec) return;
  const skills = (rec as RecordingRow & { skills?: SkillRow[] }).skills ?? [];
  const newest = skills.length
    ? [...skills].sort((a, b) => b.version - a.version)[0]
    : null;
  view = { kind: "skill", recording: rec as RecordingRow, skill: newest };
  render();
}
