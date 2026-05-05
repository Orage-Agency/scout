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
  // Single transitional state covering everything between Stop and Skill-Ready.
  // The popup shows a single staged progress UI; the user does nothing.
  | { kind: "processing"; recording: RecordingRow; stage: "uploading" | "transcribing" | "drafting"; error?: string }
  | { kind: "skill"; recording: RecordingRow; skill: SkillRow | null; autoDownloaded?: boolean };

const root = document.getElementById("app")!;
let view: View = { kind: "loading" };

// chrome.storage.local key for the most recent recording's id. Lets the popup
// resume its processing/skill view if the user closes the popup mid-wait.
const RECENT_KEY = "scout:recent_recording_id";

async function init(): Promise<void> {
  const sb = getSupabase();
  const { data: sess } = await sb.auth.getSession();
  if (!sess.session) {
    view = { kind: "signed_out", mode: "signin" };
    return render();
  }
  const { state } = (await chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage)) ?? {};
  if (state) {
    view = { kind: "recording", state };
    return render();
  }
  // No active recording — but maybe one just finished and the user reopened
  // the popup to see the result. Pick up the most recent one if its status
  // suggests it still needs the user's attention.
  const stored = await chrome.storage.local.get(RECENT_KEY);
  const recentId = stored[RECENT_KEY] as string | undefined;
  if (recentId) {
    const { data: rec } = await sb.from("recordings").select("*, skills(*)").eq("id", recentId).single();
    if (rec) {
      const skills = (rec as RecordingRow & { skills?: SkillRow[] }).skills ?? [];
      const newest = skills.length ? [...skills].sort((a, b) => b.version - a.version)[0] : null;
      if (newest) {
        view = { kind: "skill", recording: rec as RecordingRow, skill: newest };
        return render();
      }
      if (rec.status === "uploading" || rec.status === "transcribing") {
        view = { kind: "processing", recording: rec as RecordingRow, stage: rec.status as "uploading" | "transcribing" };
        render();
        void runAutoGenerate(rec as RecordingRow);
        return;
      }
      if (rec.status === "ready") {
        // Transcribe done but no skill yet — kick off generation.
        view = { kind: "processing", recording: rec as RecordingRow, stage: "drafting" };
        render();
        void runAutoGenerate(rec as RecordingRow);
        return;
      }
    }
  }
  view = { kind: "idle", tab: "record" };
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
    case "processing":
      wrap.appendChild(header(null));
      wrap.appendChild(processingView(view.recording, view.stage, view.error));
      break;
    case "skill":
      wrap.appendChild(header(null));
      wrap.appendChild(skillView(view.recording, view.skill, view.autoDownloaded));
      break;
  }
  root.appendChild(wrap);
}

// ---- Header / tabs ----

function header(active: "record" | "library" | "settings" | null): HTMLElement {
  const h = document.createElement("header");
  h.className = "px-5 pt-5 pb-3 flex flex-col gap-3 relative";
  h.innerHTML = `
    <div class="flex items-baseline gap-3">
      <span class="display text-[28px]" style="color:#E4AF7A;">SCOUT</span>
      <span class="label" style="font-size:9px;">v0.1.1 · Orage AI</span>
    </div>
    <div class="divider-gold"></div>
  `;
  if (active) {
    const nav = document.createElement("nav");
    nav.className = "flex gap-1.5 mt-1";
    for (const t of ["record", "library", "settings"] as const) {
      const b = document.createElement("button");
      b.className = `tab-pill${active === t ? " active" : ""}`;
      b.textContent = t;
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
  d.className = "flex-1 flex flex-col items-center justify-center min-h-[480px] gap-3";
  d.innerHTML = `
    <div class="display text-[36px]" style="color:#E4AF7A;">SCOUT</div>
    <div class="text-[11px]" style="color:rgba(255,232,199,0.5);font-family:'Bebas Neue',sans-serif;letter-spacing:0.18em;text-transform:uppercase;">Loading</div>
  `;
  return d;
}

// ---- Auth ----

function signedOutView(_mode: "signin" | "signup"): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 flex flex-col items-center justify-center px-7 gap-2.5 text-center min-h-[480px]";
  // Single unified form: tries sign-in first, falls back to sign-up if the
  // user doesn't exist. The user shouldn't have to know whether they have
  // an account — they have an email + password, that's enough.
  d.innerHTML = `
    <div class="display text-[44px] mb-1" style="color:#E4AF7A;">SCOUT</div>
    <div class="label mb-3" style="color:#B68039;">By Orage AI</div>
    <p class="text-[13px] leading-relaxed mb-4" style="color:rgba(255,232,199,0.65); max-width:280px;">Capture human workflows. Generate skill files for AI agents.</p>
    <div class="glass w-full p-4 flex flex-col gap-2.5">
      <input id="email" type="email" autocomplete="email" placeholder="you@company.com" class="input" />
      <input id="pw" type="password" autocomplete="current-password" placeholder="Password (min 8 chars)" class="input" />
      <button id="go" class="btn btn-primary w-full mt-1">Continue</button>
    </div>
    <p class="text-[10px] mt-2" style="color:rgba(255,232,199,0.4);">New here? We'll create your account automatically.</p>
    <p id="err" class="text-xs mt-1" style="color:#DC2626;"></p>
  `;
  const emailEl = d.querySelector<HTMLInputElement>("#email")!;
  const pwEl = d.querySelector<HTMLInputElement>("#pw")!;
  const errEl = d.querySelector<HTMLParagraphElement>("#err")!;
  const goBtn = d.querySelector<HTMLButtonElement>("#go")!;
  const submit = async () => {
    const email = emailEl.value.trim();
    const password = pwEl.value;
    if (!email) { errEl.textContent = "Enter your email."; return; }
    if (password.length < 8) { errEl.textContent = "Password must be at least 8 characters."; return; }
    errEl.textContent = "";
    goBtn.disabled = true;
    goBtn.textContent = "Signing in…";
    try {
      const sb = getSupabase();
      // Try sign-in first.
      let { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        const msg = String(error.message || "").toLowerCase();
        // "Invalid login credentials" is what Supabase returns for both
        // wrong password AND non-existent user. Try sign-up; if THAT
        // fails with "already registered", we know the password was wrong.
        if (msg.includes("invalid") || msg.includes("not found")) {
          goBtn.textContent = "Creating account…";
          const su = await sb.auth.signUp({ email, password });
          if (su.error) throw new Error(su.error.message);
        } else {
          throw error;
        }
      }
      // onAuthStateChange flips the view to idle.
    } catch (e) {
      errEl.textContent = String((e as Error).message ?? e);
      goBtn.disabled = false;
      goBtn.textContent = "Continue";
    }
  };
  goBtn.onclick = () => void submit();
  pwEl.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
  emailEl.onkeydown = (e) => { if (e.key === "Enter") pwEl.focus(); };
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
  d.className = "flex-1 flex flex-col items-center justify-center gap-4 px-8 py-10 text-center";
  d.innerHTML = `
    <div class="relative">
      <div class="absolute inset-0 rounded-full" style="background:radial-gradient(circle, rgba(182,128,57,0.35) 0%, transparent 70%); transform:scale(1.5); pointer-events:none;"></div>
      <button id="rec"
        class="relative w-[104px] h-[104px] rounded-full transition-all duration-200 flex items-center justify-center"
        style="background:linear-gradient(180deg,#C68A41 0%,#8B5E2A 100%); border:1px solid rgba(228,175,122,0.7); box-shadow:0 1px 0 rgba(255,255,255,0.18) inset, 0 -2px 0 rgba(0,0,0,0.3) inset, 0 8px 30px rgba(182,128,57,0.40);">
        <span class="block w-7 h-7 rounded-full" style="background:#1a0e02;"></span>
      </button>
    </div>
    <div class="display text-[18px] mt-3" style="color:#E4AF7A;">Start Recording</div>
    <p class="text-[12px] leading-relaxed max-w-[280px]" style="color:rgba(255,232,199,0.55);">We'll capture clicks, keystrokes, screenshots, and your narration. Talk through the <em style="color:#E4AF7A;font-style:normal;">why</em> and the skill writes itself.</p>
    <p id="warn" class="text-[11px] leading-snug hidden glass px-3 py-2 mt-1" style="color:#B45309;"></p>
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
  d.className = "flex-1 px-5 py-4 overflow-y-auto";
  d.innerHTML = `<div class="label mb-3">Recordings</div><div id="list" class="space-y-2"></div>`;
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
    container.innerHTML = `<div class="glass p-5 text-center">
      <div class="text-[12px] mb-1" style="color:rgba(255,232,199,0.55);">Nothing here yet.</div>
      <div class="text-[11px]" style="color:rgba(255,232,199,0.4);">Hit Record on a real web page to make your first one.</div>
    </div>`;
    return;
  }
  container.innerHTML = "";
  for (const r of data as Array<RecordingRow & { skills: SkillRow[] }>) {
    const card = document.createElement("button");
    card.className = "w-full glass text-left p-3.5 transition-all hover:scale-[1.01]";
    card.style.cursor = "pointer";
    const title = r.title || "Untitled recording";
    const date = new Date(r.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const dur = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : "—";
    const status = r.status;
    const hasSkill = (r.skills?.length ?? 0) > 0;
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium truncate" style="color:#FFE8C7;">${escapeHtml(title)}</div>
          <div class="text-[11px] mt-1" style="color:rgba(255,232,199,0.45);">${escapeHtml(date)} · ${dur}</div>
        </div>
        <span class="${statusColor(status)}" style="font-family:'Bebas Neue',sans-serif; font-size:10px; letter-spacing:0.18em; text-transform:uppercase;">${status}</span>
      </div>
      <div class="mt-2 text-[11px]" style="color:${hasSkill ? "#E4AF7A" : "rgba(255,232,199,0.4)"};">${hasSkill ? "✦ Skill ready" : "No skill yet"}</div>
    `;
    card.onclick = () => {
      view = { kind: "skill", recording: r, skill: r.skills?.[0] ?? null };
      render();
    };
    container.appendChild(card);
  }
}

function statusColor(s: string): string {
  if (s === "ready") return "status-ready";
  if (s === "failed") return "status-failed";
  if (s === "transcribing" || s === "uploading") return "status-progress";
  return "status-idle";
}

function settingsTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-5 py-4 space-y-4";
  d.innerHTML = `
    <div class="glass p-4">
      <div class="label mb-2">Account</div>
      <div id="who" class="text-[13px]" style="color:#FFE8C7;">…</div>
      <button id="signout" class="btn w-full mt-3">Sign out</button>
    </div>
    <div class="glass p-4">
      <div class="label mb-2">Data</div>
      <button id="del" class="btn w-full">Delete all my data</button>
      <p class="text-[11px] leading-relaxed mt-2" style="color:rgba(255,232,199,0.45);">Cascades through recordings, events, screenshots, audio, and skills. This cannot be undone.</p>
    </div>
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
  d.className = "flex-1 px-5 py-5 flex flex-col gap-3";
  const startedMs = s.started_at;
  const audioBadge = s.audio_supported
    ? `<span class="label" style="font-size:9px;color:#15803D;">audio on</span>`
    : `<span class="label" style="font-size:9px;color:#B45309;" title="Mic denied or unavailable. Recording continues without narration.">audio off</span>`;
  const tabTitle = s.active_tab_title?.trim() || (s.active_tab_url ? new URL(s.active_tab_url).hostname : "—");
  d.innerHTML = `
    <div class="glass p-4">
      <div class="flex items-center gap-2">
        <span class="record-dot"></span>
        <span class="display text-[15px]" style="color:#E4AF7A;">Recording</span>
        ${audioBadge}
        <span id="t" class="ml-auto font-mono tabular-nums text-[13px]" style="color:#E4AF7A;">00:00</span>
      </div>
      <div id="tabname" class="text-[11px] mt-3 truncate" style="color:rgba(255,232,199,0.55);" title="${escapeHtml(tabTitle)}">on <span style="color:#FFE8C7;">${escapeHtml(tabTitle)}</span></div>
      <div id="evcount" class="text-[11px] mt-1" style="color:rgba(255,232,199,0.45);">${s.event_count ?? 0} events · ${s.shot_count ?? 0} screenshots</div>
    </div>
    <div class="flex gap-2">
      <button id="pause" class="btn flex-1">${s.is_paused ? "Resume" : "Pause"}</button>
      <button id="stop" class="btn btn-primary flex-1">Stop</button>
    </div>
    <p class="text-[11px] leading-relaxed mt-1" style="color:rgba(255,232,199,0.45);">Switch tabs freely — the floating control bar in the page is also yours.</p>
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
    // Persist so re-opening the popup picks up where we left off.
    await chrome.storage.local.set({ [RECENT_KEY]: recordingId });
    await chrome.runtime.sendMessage({ type: "popup:stop_recording" } satisfies RuntimeMessage);
    const sb = getSupabase();
    const { data: rec } = await sb.from("recordings").select("*").eq("id", recordingId).single();
    if (rec) {
      view = { kind: "processing", recording: rec as RecordingRow, stage: "uploading" };
      render();
      void runAutoGenerate(rec as RecordingRow);
    } else {
      view = { kind: "idle", tab: "library" };
      render();
    }
  };
  return d;
}

// Auto-generate flow: poll the recording row through its statuses, then call
// /generate-skill. Updates the popup's stage label as we go.
async function runAutoGenerate(rec: RecordingRow): Promise<void> {
  const sb = getSupabase();
  const deadline = Date.now() + 180_000;
  // Phase 1 — wait for status='ready' (transcribe finished).
  while (Date.now() < deadline) {
    const { data } = await sb.from("recordings").select("status").eq("id", rec.id).single();
    const status = data?.status as string | undefined;
    if (view.kind !== "processing" || view.recording.id !== rec.id) return;
    if (status === "uploading") view.stage = "uploading";
    else if (status === "transcribing") view.stage = "transcribing";
    else if (status === "ready") break;
    else if (status === "failed") {
      view.error = "Recording failed during upload or transcription.";
      render();
      return;
    }
    render();
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (view.kind !== "processing" || view.recording.id !== rec.id) return;

  // Phase 2 — generate the skill.
  view.stage = "drafting";
  render();
  try {
    const { data: sess } = await sb.auth.getSession();
    const res = await fetch(functionUrl("generate-skill"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ recording_id: rec.id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const skill = (await res.json()) as SkillRow;
    const { data: refreshed } = await sb.from("recordings").select("*").eq("id", rec.id).single();
    if (view.kind === "processing" && view.recording.id === rec.id) {
      // Auto-download the Claude Code skill zip the moment it's ready.
      // The user came here for the skill — give it to them without an extra click.
      try { downloadClaudeSkill(skill); } catch (e) { console.warn("[scout] auto-download failed", e); }
      view = { kind: "skill", recording: (refreshed as RecordingRow) ?? rec, skill, autoDownloaded: true };
      render();
    }
  } catch (e) {
    if (view.kind === "processing" && view.recording.id === rec.id) {
      view.error = String((e as Error).message ?? e);
      render();
    }
  }
}

function processingView(rec: RecordingRow, stage: "uploading" | "transcribing" | "drafting", error?: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-5 py-6 flex flex-col gap-4";
  const stages: Array<{ id: typeof stage; label: string }> = [
    { id: "uploading", label: "Uploading audio + screenshots" },
    { id: "transcribing", label: "Transcribing narration" },
    { id: "drafting", label: "Drafting your skill" },
  ];
  const currentIdx = stages.findIndex((s) => s.id === stage);
  const stageHtml = stages
    .map((s, i) => {
      const done = i < currentIdx;
      const active = i === currentIdx;
      const dotColor = done ? "#15803D" : active ? "#E4AF7A" : "rgba(255,232,199,0.20)";
      const dotInner = active ? `<span style="position:absolute;inset:0;border-radius:50%;border:2px solid #E4AF7A;animation:scout-spin 1.4s linear infinite;border-top-color:transparent;"></span>` : "";
      const labelColor = done ? "rgba(255,232,199,0.75)" : active ? "#FFE8C7" : "rgba(255,232,199,0.35)";
      return `
        <div class="flex items-center gap-3">
          <span style="position:relative;display:inline-block;width:14px;height:14px;border-radius:50%;background:${dotColor};">${dotInner}</span>
          <span class="text-[13px]" style="color:${labelColor};">${s.label}</span>
        </div>`;
    })
    .join("");
  d.innerHTML = `
    <div class="glass p-5">
      <div class="display text-[16px] mb-1" style="color:#E4AF7A;">${error ? "Something went wrong" : "Finishing up"}</div>
      <div class="text-[11px] mb-4" style="color:rgba(255,232,199,0.5);">${error ? "We saved your recording — you can retry from the library." : `${rec.duration_ms ? Math.round(rec.duration_ms/1000) + "s recording" : "Processing recording"} · this usually takes 30–60s`}</div>
      ${error ? `<div class="text-[12px] glass-strong p-3 mb-3" style="color:#DC2626;">${escapeHtml(error)}</div>` : `<div class="flex flex-col gap-3">${stageHtml}</div>`}
    </div>
    ${error ? `<button id="back" class="btn">Back to Library</button>` : `
      <div class="glass p-3 flex items-start gap-2.5">
        <span style="color:#B68039;font-size:14px;flex-shrink:0;">⓵</span>
        <div class="flex-1 text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.55);">
          You can close this popup. We'll save the skill to your Downloads when it's ready, and the popup picks up here when you reopen it.
        </div>
      </div>`}
  `;
  if (error) {
    d.querySelector<HTMLButtonElement>("#back")!.onclick = () => {
      view = { kind: "idle", tab: "library" };
      render();
    };
  }
  return d;
}

// ---- Skill side-panel view ----

function skillView(rec: RecordingRow, skill: SkillRow | null, autoDownloaded = false): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 px-5 py-4 overflow-y-auto";

  const back = document.createElement("button");
  back.className = "btn btn-ghost mb-3";
  back.textContent = "← Library";
  back.onclick = () => {
    void chrome.storage.local.remove(RECENT_KEY);
    view = { kind: "idle", tab: "library" };
    render();
  };
  d.appendChild(back);

  const meta = document.createElement("div");
  meta.className = "glass p-4 mb-3";
  meta.innerHTML = `
    <div class="display text-[18px] mb-1" style="color:#E4AF7A;">${escapeHtml(rec.title || "Untitled")}</div>
    <div class="text-[11px]" style="color:rgba(255,232,199,0.5);">${escapeHtml(new Date(rec.started_at).toLocaleString())} · ${
    rec.duration_ms ? Math.round(rec.duration_ms / 1000) + "s" : "—"
  } · <span class="${statusColor(rec.status)}" style="font-family:'Bebas Neue',sans-serif;letter-spacing:0.18em;text-transform:uppercase;">${rec.status}</span></div>
  `;
  d.appendChild(meta);

  if (!skill) {
    const gen = document.createElement("div");
    gen.className = "glass p-4";
    gen.innerHTML = `
      <div class="text-[13px] mb-3" style="color:#FFE8C7;">No skill generated yet for this recording.</div>
      <button id="gen" class="btn btn-primary w-full">Generate Skill</button>
      <div id="genstatus" class="text-[11px] mt-2" style="color:rgba(255,232,199,0.55);"></div>
    `;
    gen.querySelector<HTMLButtonElement>("#gen")!.onclick = () => generate(rec.id, gen);
    d.appendChild(gen);
    return d;
  }

  // Skill ready. If we just auto-downloaded, show a friendly confirmation
  // banner above the actions so the user knows the zip is already in their
  // Downloads folder.
  if (autoDownloaded) {
    const banner = document.createElement("div");
    banner.className = "glass p-3 mb-3 flex items-center gap-2";
    banner.style.borderColor = "rgba(21,128,61,0.45)";
    banner.innerHTML = `
      <span style="display:inline-flex;width:20px;height:20px;border-radius:50%;background:#15803D;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:bold;flex-shrink:0;">✓</span>
      <div class="flex-1">
        <div class="text-[12px] font-medium" style="color:#FFE8C7;">Saved to Downloads</div>
        <div class="text-[10px]" style="color:rgba(255,232,199,0.55);">Extract the .zip into <code style="font-family:'JetBrains Mono',monospace;">~/.claude/skills/</code></div>
      </div>
    `;
    d.appendChild(banner);
  }

  // The primary CTA is always "Save as Claude Code skill" — but if we already
  // auto-downloaded once, demote it to a re-download button.
  const actions = document.createElement("div");
  actions.className = "flex flex-col gap-2 mb-3";
  actions.innerHTML = `
    <button id="claude" class="btn ${autoDownloaded ? "" : "btn-primary"} w-full">${autoDownloaded ? "Save again" : "⬇ Save as Claude Code skill"}</button>
    <div class="grid grid-cols-3 gap-2">
      <button id="cp" class="btn text-[11px]">Copy</button>
      <button id="dl" class="btn text-[11px]">Save .md</button>
      <button id="rg" class="btn text-[11px]">Regenerate</button>
    </div>
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
  hint.className = "glass p-3 mb-3";
  hint.innerHTML = `
    <div class="label mb-1.5" style="font-size:9px;">Install</div>
    <div class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.65);">Extract the zip into <code style="font-family:'JetBrains Mono',monospace;font-size:10px;background:rgba(182,128,57,0.15);padding:1px 5px;border-radius:3px;color:#E4AF7A;">~/.claude/skills/</code> — Claude Code will pick up <span style="color:#E4AF7A;font-weight:500;">${escapeHtml(slug)}</span> on next session.</div>
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
    fm.className = "glass p-3 mb-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words";
    fm.style.fontFamily = "'JetBrains Mono', monospace";
    fm.style.color = "rgba(255, 232, 199, 0.55)";
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
