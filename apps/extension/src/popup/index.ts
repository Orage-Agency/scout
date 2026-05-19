// Popup UI — vanilla TS rendering. Three tabs: Record, Library, Settings.
// v0.2.0 — Orage Liquid Glass enterprise rebuild.
// Architecture: compact top header + scrollable main + sticky bottom nav (idle only).

import { getAuthSupabase, getDataSupabase, functionUrl } from "../lib/supabase";
import type { RecordingRow, SkillRow, RecordingSessionState, RuntimeMessage } from "../lib/types";
import { marked } from "marked";
import { zipSync, strToU8 } from "fflate";

type View =
  | { kind: "loading" }
  | { kind: "signed_out"; mode: "signin" | "signup" }
  | { kind: "idle"; tab: "record" | "library" | "settings" }
  | { kind: "recording"; state: RecordingSessionState }
  | { kind: "extra_context"; recording: RecordingRow }
  | { kind: "processing"; recording: RecordingRow; stage: "uploading" | "transcribing" | "drafting"; error?: string }
  | { kind: "skill"; recording: RecordingRow; skill: SkillRow | null; allSkills?: SkillRow[]; autoDownloaded?: boolean };

const root = document.getElementById("app")!;
let view: View = { kind: "loading" };
// Accumulates streaming skill chunks — updated in-place without full re-renders.
let liveStream = "";
// Preserved from the recording session on stop so extraContextView can show stats.
let lastStopStats: { event_count: number; shot_count: number; had_voice: boolean } | null = null;

const RECENT_KEY    = "scout:recent_recording_id";
const MIC_PREF_KEY  = "scout:mic_enabled";
const MODE_PREF_KEY = "scout:recording_mode";
const TIER_PREF_KEY = "scout:tier";

type Tier = "quick" | "standard" | "deep";

async function getTier(): Promise<Tier> {
  const v = await chrome.storage.local.get(TIER_PREF_KEY);
  const t = v[TIER_PREF_KEY] as string | undefined;
  return t === "quick" || t === "deep" ? (t as Tier) : "standard";
}

async function getMicEnabled(): Promise<boolean> {
  const v = await chrome.storage.local.get(MIC_PREF_KEY);
  return (v[MIC_PREF_KEY] as boolean | undefined) ?? true;
}

async function getRecordingMode(): Promise<"skill" | "improvement"> {
  const v = await chrome.storage.local.get(MODE_PREF_KEY);
  const m = v[MODE_PREF_KEY] as string | undefined;
  return m === "improvement" ? "improvement" : "skill";
}

// TEMP (v0.1.11): hard-set to true for testing. Pair-revert with 0006_temp_everyone_admin.sql.
// To restore JWT-based check:
//   let currentRole: "admin" | "guest" = "guest";
//   function isAdmin(): boolean { return currentRole === "admin"; }
//   async function refreshRole(): Promise<void> {
//     const { data } = await getAuthSupabase().auth.getSession();
//     const claim = (data.session?.user?.app_metadata as { role?: string } | undefined)?.role;
//     currentRole = claim === "admin" ? "admin" : "guest";
//   }
function isAdmin(): boolean { return true; }
async function refreshRole(): Promise<void> { /* no-op while temp-admin */ }


// ---- Boot ----

async function init(): Promise<void> {
  let auth: ReturnType<typeof getAuthSupabase>, db: ReturnType<typeof getDataSupabase>;
  try {
    auth = getAuthSupabase();
    db = getDataSupabase();
  } catch (e) {
    console.warn("[scout] supabase env not configured, falling back to signed-out view", e);
    view = { kind: "signed_out", mode: "signin" };
    render();
    return;
  }
  const { data: sess } = await auth.auth.getSession();
  if (!sess.session) {
    view = { kind: "signed_out", mode: "signin" };
    return render();
  }
  await db.auth.setSession({
    access_token: sess.session.access_token,
    refresh_token: sess.session.refresh_token,
  });
  await refreshRole();
  const { state } = (await chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage)) ?? {};
  if (state) {
    view = { kind: "recording", state };
    return render();
  }
  const stored = await chrome.storage.local.get(RECENT_KEY);
  const recentId = stored[RECENT_KEY] as string | undefined;
  if (recentId) {
    const { data: rec } = await db.from("recordings").select("*, skills(*)").eq("id", recentId).single();
    if (rec) {
      const skills = (rec as RecordingRow & { skills?: SkillRow[] }).skills ?? [];
      const sorted = [...skills].sort((a, b) => b.version - a.version);
      const newest = sorted[0] ?? null;
      if (newest) {
        view = { kind: "skill", recording: rec as RecordingRow, skill: newest, allSkills: sorted };
        return render();
      }
      if (rec.status === "uploading" || rec.status === "transcribing" || rec.status === "recording" || rec.status === "ready") {
        // Background is generating — just show the library; card shows status.
        view = { kind: "idle", tab: "library" };
        render();
        return;
      }
    }
  }
  view = { kind: "idle", tab: "record" };
  render();
}

// ---- Root render ----

function render(): void {
  root.innerHTML = "";

  if (view.kind === "loading") {
    root.appendChild(loadingView());
    return;
  }
  if (view.kind === "signed_out") {
    root.appendChild(signedOutView(view.mode));
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "flex flex-col min-h-[560px] animate-fade-in";

  // Compact top header — logo only
  wrap.appendChild(compactHeader());

  // Divider below header
  const divLine = document.createElement("div");
  divLine.className = "divider-gold mx-5";
  wrap.appendChild(divLine);

  // Main scrollable content
  const main = document.createElement("main");
  main.className = "flex-1 overflow-y-auto";

  switch (view.kind) {
    case "idle":
      main.appendChild(idleView(view.tab));
      break;
    case "recording":
      main.appendChild(recordingView(view.state));
      break;
    case "extra_context":
      main.appendChild(extraContextView(view.recording));
      break;
    case "processing":
      main.appendChild(processingView(view.recording, view.stage, view.error));
      break;
    case "skill":
      main.appendChild(skillView(view.recording, view.skill, view.allSkills, view.autoDownloaded));
      if (view.skill && !view.skill.body_md && view.skill.id) {
        void hydrateSkill(view.skill.id);
      }
      break;
  }

  wrap.appendChild(main);

  // Bottom nav — idle views only
  if (view.kind === "idle") {
    wrap.appendChild(bottomNav(view.tab));
  }

  root.appendChild(wrap);
}

// ---- Compact header (used in all non-loading, non-auth views) ----

function compactHeader(): HTMLElement {
  const h = document.createElement("header");
  h.className = "px-5 pt-4 pb-3 flex items-center justify-between";
  h.innerHTML = `
    <div class="flex items-baseline gap-2">
      <span class="display text-[26px]">SCOUT</span>
      <span class="label" style="font-size:8px;opacity:0.55;">v0.2.2</span>
    </div>
    <span class="label" style="font-size:8px;opacity:0.38;">Orage AI</span>
  `;
  return h;
}

// ---- Bottom navigation (idle views) ----

function bottomNav(active: "record" | "library" | "settings"): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "flex";
  nav.style.borderTop = "1px solid rgba(182,128,57,0.12)";
  nav.style.background = "linear-gradient(0deg,rgba(0,0,0,0.85) 0%,rgba(12,12,12,0.70) 100%)";
  nav.style.backdropFilter = "blur(20px)";
  (nav.style as unknown as Record<string, string>)["-webkit-backdrop-filter"] = "blur(20px)";

  const tabs: Array<{ id: "record" | "library" | "settings"; label: string; icon: string }> = [
    {
      id: "record",
      label: "Record",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="12" r="7"/>
        <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>
      </svg>`,
    },
    {
      id: "library",
      label: "Library",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="3" y="3" width="7" height="7" rx="1.5"/>
        <rect x="14" y="3" width="7" height="7" rx="1.5"/>
        <rect x="3" y="14" width="7" height="7" rx="1.5"/>
        <rect x="14" y="14" width="7" height="7" rx="1.5"/>
      </svg>`,
    },
    {
      id: "settings",
      label: "Account",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.58-7 8-7s8 3 8 7" stroke-linecap="round"/>
      </svg>`,
    },
  ];

  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.className = `nav-tab${active === t.id ? " active" : ""}`;
    btn.innerHTML = `${t.icon}<span>${t.label}</span>`;
    btn.onclick = () => {
      view = { kind: "idle", tab: t.id };
      render();
    };
    nav.appendChild(btn);
  }

  return nav;
}

// ---- Loading ----

function loadingView(): HTMLElement {
  const d = document.createElement("div");
  d.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:560px;background:#000;";
  d.style.backgroundImage = "radial-gradient(ellipse 500px 420px at 105% -10%,rgba(182,128,57,0.13) 0%,transparent 62%),radial-gradient(ellipse 480px 480px at -10% 115%,rgba(228,175,122,0.07) 0%,transparent 62%)";
  d.innerHTML = `
    <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:52px;letter-spacing:0.05em;color:#E4AF7A;line-height:1;text-transform:uppercase;">SCOUT</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:10px;letter-spacing:0.30em;color:rgba(182,128,57,0.55);text-transform:uppercase;margin-top:10px;">By Orage AI</div>
    <div style="margin-top:28px;width:36px;height:2px;background:linear-gradient(90deg,transparent,#B68039,transparent);animation:shimmer 1.4s ease infinite;" ></div>
  `;
  return d;
}

// ---- Auth ----

function signedOutView(_mode: "signin" | "signup"): HTMLElement {
  const d = document.createElement("div");
  d.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:560px;padding:0 28px;background:#000;";
  d.style.backgroundImage = "radial-gradient(ellipse 500px 420px at 105% -10%,rgba(182,128,57,0.13) 0%,transparent 62%),radial-gradient(ellipse 480px 480px at -10% 115%,rgba(228,175,122,0.07) 0%,transparent 62%)";
  d.innerHTML = `
    <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:50px;letter-spacing:0.05em;color:#E4AF7A;line-height:1;text-transform:uppercase;margin-bottom:4px;">SCOUT</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:10px;letter-spacing:0.28em;color:#B68039;text-transform:uppercase;margin-bottom:28px;">By Orage AI</div>
    <p style="font-size:13px;line-height:1.65;color:rgba(255,232,199,0.55);text-align:center;max-width:270px;margin-bottom:22px;">Capture human workflows. Generate skill files for AI agents.</p>
    <div id="form-wrap" style="width:100%;max-width:300px;display:flex;flex-direction:column;gap:10px;">
      <div class="glass" style="padding:20px;display:flex;flex-direction:column;gap:10px;">
        <input id="email" type="email" autocomplete="email" placeholder="you@company.com" class="input" />
        <input id="pw" type="password" autocomplete="current-password" placeholder="Password (min 8 chars)" class="input" />
        <button id="go" class="btn btn-primary w-full" style="margin-top:4px;">Continue</button>
      </div>
      <p style="font-size:10px;color:rgba(255,232,199,0.35);text-align:center;">New here? We create your account automatically.</p>
      <p id="err" style="font-size:12px;color:#F87171;text-align:center;min-height:16px;"></p>
    </div>
  `;
  const emailEl = d.querySelector<HTMLInputElement>("#email")!;
  const pwEl    = d.querySelector<HTMLInputElement>("#pw")!;
  const errEl   = d.querySelector<HTMLParagraphElement>("#err")!;
  const goBtn   = d.querySelector<HTMLButtonElement>("#go")!;

  const submit = async () => {
    const email    = emailEl.value.trim();
    const password = pwEl.value;
    if (!email)             { errEl.textContent = "Enter your email."; return; }
    if (password.length < 8){ errEl.textContent = "Password must be at least 8 characters."; return; }
    errEl.textContent = "";
    goBtn.disabled = true;
    goBtn.textContent = "Signing in…";
    try {
      const auth = getAuthSupabase();
      let { error } = await auth.auth.signInWithPassword({ email, password });
      if (error) {
        const msg = String(error.message || "").toLowerCase();
        if (msg.includes("invalid") || msg.includes("not found")) {
          goBtn.textContent = "Creating account…";
          const su = await auth.auth.signUp({ email, password });
          if (su.error) throw new Error(su.error.message);
        } else {
          throw error;
        }
      }
    } catch (e) {
      errEl.textContent = String((e as Error).message ?? e);
      goBtn.disabled = false;
      goBtn.textContent = "Continue";
    }
  };
  goBtn.onclick  = () => void submit();
  pwEl.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
  emailEl.onkeydown = (e) => { if (e.key === "Enter") pwEl.focus(); };
  return d;
}

// ---- Idle (tabbed) ----

function idleView(tab: "record" | "library" | "settings"): HTMLElement {
  if (tab === "record")   return recordTab();
  if (tab === "library")  return libraryTab();
  return settingsTab();
}

// ---- PII acknowledgement modal ----
// Shown once before the first recording. Resolves true if the user confirms,
// false if they dismiss. Injects a full-screen overlay into #app and cleans
// itself up. Screenshot OCR redaction is not in v1 — this modal is the
// user-visible disclosure for that gap.
function showPiiAckModal(): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed;inset:0;z-index:9999;",
      "background:rgba(0,0,0,0.82);backdrop-filter:blur(6px);",
      "display:flex;align-items:center;justify-content:center;padding:20px;",
    ].join("");

    overlay.innerHTML = `
      <div class="glass" style="max-width:320px;width:100%;padding:22px 20px;display:flex;flex-direction:column;gap:14px;">
        <div class="display text-[17px]" style="color:#E4AF7A;">Before you start</div>
        <p class="text-[12px] leading-relaxed" style="color:rgba(255,232,199,0.75);">
          Scout captures <strong style="color:#FFE8C7;">screenshots</strong> of your screen while recording.
          Text visible on screen — including any personal data — may be captured and sent to
          Scout's AI backend.
        </p>
        <p class="text-[12px] leading-relaxed" style="color:rgba(255,232,199,0.55);">
          <strong style="color:#FFE8C7;">Don't record sensitive surfaces</strong> — passwords,
          banking pages, private messages, or anything with confidential data.
        </p>
        <div class="flex gap-2">
          <button id="ack-cancel" class="btn flex-1 text-[12px]">Cancel</button>
          <button id="ack-ok" class="btn btn-primary flex-1 text-[12px]">I understand, record</button>
        </div>
        <p class="text-[10px]" style="color:rgba(255,232,199,0.28);text-align:center;">
          Shown once. See <a href="https://orage-agency.github.io/scout/privacy/" target="_blank" style="color:#B68039;">privacy policy</a>.
        </p>
      </div>
    `;

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector<HTMLButtonElement>("#ack-ok")!.onclick     = () => cleanup(true);
    overlay.querySelector<HTMLButtonElement>("#ack-cancel")!.onclick  = () => cleanup(false);
    document.body.appendChild(overlay);
  });
}

// ---- Record tab ----

function recordTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex flex-col items-center px-6 py-8 gap-5";

  // Record button with animated ring
  d.innerHTML = `
    <div class="relative flex items-center justify-center" style="width:140px;height:140px;">
      <!-- Animated expanding rings -->
      <div class="absolute rounded-full pointer-events-none record-ring-pulse"
        style="inset:0;border:1.5px solid rgba(182,128,57,0.28);border-radius:50%;"></div>
      <div class="absolute rounded-full pointer-events-none record-ring-pulse-delay"
        style="inset:0;border:1px solid rgba(182,128,57,0.16);border-radius:50%;"></div>
      <!-- Outer static ring -->
      <div class="absolute rounded-full pointer-events-none"
        style="inset:-10px;background:transparent;border:1px solid rgba(182,128,57,0.12);border-radius:50%;"></div>
      <!-- main button -->
      <button id="rec"
        class="w-[108px] h-[108px] rounded-full flex items-center justify-center transition-transform duration-150 active:scale-95"
        style="background:linear-gradient(160deg,#D4924A 0%,#9A6228 55%,#7A4A18 100%);border:1px solid rgba(228,175,122,0.65);box-shadow:0 1px 0 rgba(255,255,255,0.20) inset,0 -2px 0 rgba(0,0,0,0.32) inset,0 10px 40px rgba(182,128,57,0.44);animation:record-btn-idle 3s ease-in-out infinite;">
        <span class="block w-9 h-9 rounded-full" style="background:linear-gradient(180deg,#2a1506 0%,#1a0e02 100%);box-shadow:0 2px 8px rgba(0,0,0,0.60) inset,0 1px 0 rgba(255,255,255,0.06) inset;"></span>
      </button>
    </div>

    <div style="text-align:center;">
      <div class="display text-[20px]" style="color:#E4AF7A;">Start Recording</div>
      <p id="mode-blurb" class="text-[12px] leading-relaxed mt-1.5" style="color:rgba(255,232,199,0.50);max-width:240px;margin-inline:auto;"></p>
    </div>

    <p id="warn" class="text-[11px] leading-snug hidden glass px-3 py-2 w-full text-center" style="color:#F59E0B;"></p>

    <!-- Settings glass card -->
    <div class="glass w-full" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">

      <!-- Mode row -->
      <div class="flex items-center gap-2">
        <span class="label" style="font-size:9px;flex:1;">Mode</span>
        <div class="flex gap-1">
          <button id="mode-skill"        class="tab-pill" style="font-size:10px;padding:4px 10px;">Skill</button>
          <button id="mode-improvement"  class="tab-pill" style="font-size:10px;padding:4px 10px;">Improvements</button>
        </div>
      </div>

      <div class="divider-subtle"></div>

      <!-- Tier row -->
      <div class="flex items-center gap-2">
        <span class="label" style="font-size:9px;flex:1;">Tier</span>
        <div class="flex gap-1">
          <button id="tier-quick"    class="tab-pill" style="font-size:10px;padding:4px 8px;" title="Haiku · no images · ~$0.04">Quick</button>
          <button id="tier-standard" class="tab-pill" style="font-size:10px;padding:4px 8px;" title="Sonnet 4.6 · ~$0.12">Standard</button>
          <button id="tier-deep"     class="tab-pill" style="font-size:10px;padding:4px 8px;" title="Opus 4.7 · all images · ~$0.40">Deep</button>
        </div>
      </div>

      <div class="divider-subtle"></div>

      <!-- Mic row -->
      <div class="flex items-center gap-2">
        <span id="mic-icon" style="font-size:13px;transition:opacity 0.15s;flex-shrink:0;">🎙</span>
        <span class="text-[12px] flex-1" style="color:rgba(255,232,199,0.60);">Voice narration</span>
        <button id="mic-toggle" class="tab-pill" style="font-size:10px;min-width:36px;padding:4px 10px;">ON</button>
      </div>

    </div>
  `;

  const warnEl        = d.querySelector<HTMLParagraphElement>("#warn")!;
  const micIcon       = d.querySelector<HTMLSpanElement>("#mic-icon")!;
  const micToggleBtn  = d.querySelector<HTMLButtonElement>("#mic-toggle")!;
  const modeSkillBtn  = d.querySelector<HTMLButtonElement>("#mode-skill")!;
  const modeImproveBtn= d.querySelector<HTMLButtonElement>("#mode-improvement")!;
  const tierQuickBtn  = d.querySelector<HTMLButtonElement>("#tier-quick")!;
  const tierStdBtn    = d.querySelector<HTMLButtonElement>("#tier-standard")!;
  const tierDeepBtn   = d.querySelector<HTMLButtonElement>("#tier-deep")!;
  const blurb         = d.querySelector<HTMLParagraphElement>("#mode-blurb")!;

  // Mic
  void getMicEnabled().then((enabled) => {
    micToggleBtn.textContent = enabled ? "ON" : "OFF";
    micToggleBtn.className   = `tab-pill${enabled ? " active" : ""} text-[10px]`;
    micIcon.style.opacity    = enabled ? "1" : "0.3";
  });
  micToggleBtn.onclick = async () => {
    const next = micToggleBtn.textContent === "OFF";
    await chrome.storage.local.set({ [MIC_PREF_KEY]: next });
    micToggleBtn.textContent = next ? "ON" : "OFF";
    micToggleBtn.className   = `tab-pill${next ? " active" : ""} text-[10px]`;
    micIcon.style.opacity    = next ? "1" : "0.3";
  };

  // Mode
  const renderMode = (mode: "skill" | "improvement") => {
    const isImprove = mode === "improvement";
    modeSkillBtn.className   = `tab-pill${!isImprove ? " active" : ""} text-[10px]`;
    modeImproveBtn.className = `tab-pill${isImprove ? " active" : ""} text-[10px]`;
    blurb.innerHTML = isImprove
      ? `Walk through the app and call out what's broken. Generates an <strong style="color:#E4AF7A;">Improvements brief</strong> you can share with your team.`
      : `Capture your workflow step-by-step. Generates a <strong style="color:#E4AF7A;">SKILL.md</strong> that an AI agent can replay autonomously.`;
  };
  void getRecordingMode().then(renderMode);
  modeSkillBtn.onclick   = async () => { await chrome.storage.local.set({ [MODE_PREF_KEY]: "skill" }); renderMode("skill"); };
  modeImproveBtn.onclick = async () => { await chrome.storage.local.set({ [MODE_PREF_KEY]: "improvement" }); renderMode("improvement"); };

  // Tier
  const renderTier = (t: Tier) => {
    tierQuickBtn.className = `tab-pill${t === "quick"    ? " active" : ""} text-[10px]`;
    tierStdBtn.className   = `tab-pill${t === "standard" ? " active" : ""} text-[10px]`;
    tierDeepBtn.className  = `tab-pill${t === "deep"     ? " active" : ""} text-[10px]`;
  };
  void getTier().then(renderTier);
  tierQuickBtn.onclick = async () => { await chrome.storage.local.set({ [TIER_PREF_KEY]: "quick" });    renderTier("quick"); };
  tierStdBtn.onclick   = async () => { await chrome.storage.local.set({ [TIER_PREF_KEY]: "standard" }); renderTier("standard"); };
  tierDeepBtn.onclick  = async () => { await chrome.storage.local.set({ [TIER_PREF_KEY]: "deep" });     renderTier("deep"); };

  // Blocked page warning
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.url) return;
    const blocked = /^(chrome|chrome-extension|edge|about|view-source):/i.test(tab.url)
      || /^https:\/\/(chrome|chromewebstore)\.google\.com/i.test(tab.url);
    if (blocked) {
      warnEl.textContent = "Chrome blocks recording on this page. Open a regular site first.";
      warnEl.classList.remove("hidden");
    }
  });

  // Record button — shows a one-time PII acknowledgement before the first
  // recording. Chrome cannot redact on-screen text in screenshots (OCR would
  // add ~3 MB to the bundle). The user must confirm they understand this.
  const PII_ACK_KEY = "scout:pii_ack";
  d.querySelector<HTMLButtonElement>("#rec")!.onclick = async () => {
    const ackStore = await chrome.storage.local.get(PII_ACK_KEY);
    if (!ackStore[PII_ACK_KEY]) {
      const confirmed = await showPiiAckModal();
      if (!confirmed) return;
      await chrome.storage.local.set({ [PII_ACK_KEY]: true });
    }
    const micEnabled = await getMicEnabled();
    const mode       = await getRecordingMode();
    const tier       = await getTier();
    const resp = await chrome.runtime.sendMessage({
      type: "popup:start_recording",
      mic_enabled: micEnabled,
      mode,
      tier,
    } satisfies RuntimeMessage);
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

// ---- Library tab ----

type LibSort = "newest" | "oldest" | "most-skills";

function libraryTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "flex-1 flex flex-col px-5 py-4";

  const searchWrap = document.createElement("div");
  searchWrap.className = "mb-2";
  searchWrap.innerHTML = `
    <div style="position:relative;">
      <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:0.38;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFD69C" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35" stroke-linecap="round"/></svg>
      </span>
      <input id="search" type="text" placeholder="Search by title or skill content…" class="input" style="padding-left:30px;font-size:12px;" />
    </div>
  `;
  d.appendChild(searchWrap);

  // Sort controls + stats bar
  const controlBar = document.createElement("div");
  controlBar.className = "flex items-center justify-between mb-2";
  controlBar.innerHTML = `
    <span id="lib-stats" class="text-[10px]" style="color:rgba(255,232,199,0.28);">Loading…</span>
    <div class="flex gap-1">
      <button data-sort="newest" class="tab-pill active" style="font-size:9px;padding:3px 7px;">Newest</button>
      <button data-sort="oldest" class="tab-pill" style="font-size:9px;padding:3px 7px;">Oldest</button>
      <button data-sort="most-skills" class="tab-pill" style="font-size:9px;padding:3px 7px;">Most</button>
    </div>
  `;
  d.appendChild(controlBar);

  const list = document.createElement("div");
  list.id = "list";
  list.className = "space-y-2 flex-1";
  d.appendChild(list);

  let allRecordings: Array<RecordingRow & { skills: SkillRow[] }> = [];
  let currentSort: LibSort = "newest";

  const getSorted = (): Array<RecordingRow & { skills: SkillRow[] }> => {
    const copy = [...allRecordings];
    if (currentSort === "oldest") return copy.reverse();
    if (currentSort === "most-skills") return copy.sort((a, b) => (b.skills?.length ?? 0) - (a.skills?.length ?? 0));
    return copy; // newest: already sorted by server
  };

  const renderList = (query: string) => {
    const q = query.toLowerCase().trim();
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    const sorted = getSorted();
    const filtered = words.length
      ? sorted.filter(r => {
          const haystack = [
            r.title ?? "",
            ...(r.skills ?? []).map(s => s.body_md ?? ""),
          ].join(" ").toLowerCase();
          return words.every(w => haystack.includes(w));
        })
      : sorted;
    renderCards(list, filtered, q);
  };

  const searchInput = searchWrap.querySelector<HTMLInputElement>("#search")!;
  searchInput.oninput = (e) => renderList((e.target as HTMLInputElement).value);

  controlBar.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach(btn => {
    btn.onclick = () => {
      currentSort = btn.getAttribute("data-sort") as LibSort;
      controlBar.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach(b => {
        b.className = `tab-pill${b === btn ? " active" : ""}`;
        b.style.cssText = "font-size:9px;padding:3px 7px;";
      });
      renderList(searchInput.value);
    };
  });

  loadLibraryData().then((data) => {
    if (!data) return;
    allRecordings = data;
    const totalSkills = allRecordings.reduce((n, r) => n + (r.skills?.length ?? 0), 0);
    const statsEl = controlBar.querySelector<HTMLSpanElement>("#lib-stats")!;
    statsEl.textContent = `${allRecordings.length} recording${allRecordings.length !== 1 ? "s" : ""} · ${totalSkills} skill${totalSkills !== 1 ? "s" : ""}`;
    renderCards(list, allRecordings, "");
  });

  return d;
}

async function loadLibraryData(): Promise<Array<RecordingRow & { skills: SkillRow[] }> | null> {
  const db = getDataSupabase();
  const { data: authUser } = await getAuthSupabase().auth.getUser();
  const userId = authUser.user?.id;
  if (!userId) return null;

  let query = db
    .from("recordings")
    .select("*, skills(id,recording_id,user_id,version,title,body_md,kind,prompt_used,created_at)")
    .order("started_at", { ascending: false })
    .limit(50);
  if (!isAdmin()) query = query.eq("user_id", userId);

  const { data, error } = await query;
  if (error) return null;
  return (data ?? []) as Array<RecordingRow & { skills: SkillRow[] }>;
}

function renderCards(container: HTMLElement, rows: Array<RecordingRow & { skills: SkillRow[] }>, query = ""): void {
  container.innerHTML = "";

  if (!rows.length) {
    if (query) {
      container.innerHTML = `
        <div class="glass p-5 mt-2 text-center">
          <div class="display text-[13px] mb-1">No results</div>
          <p class="text-[11px]" style="color:rgba(255,232,199,0.40);">Nothing matched <strong style="color:#E4AF7A;">"${escapeHtml(query)}"</strong> — try a different term or clear the search.</p>
        </div>
      `;
      return;
    }
    container.innerHTML = `
      <div class="glass p-5 mt-2">
        <div class="display text-[15px]" style="color:#E4AF7A;">Your first skill</div>
        <div class="display text-[15px] mb-4">is 3 clicks away.</div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#C68A41,#7A4F1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Bebas Neue',sans-serif;font-size:11px;color:#1a0a00;">1</div>
            <div>
              <div class="text-[12px] font-semibold" style="color:#FFE8C7;">Switch to a workflow tab</div>
              <div class="text-[10px]" style="color:rgba(255,232,199,0.38);">Any process you repeat regularly</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#C68A41,#7A4F1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Bebas Neue',sans-serif;font-size:11px;color:#1a0a00;">2</div>
            <div>
              <div class="text-[12px] font-semibold" style="color:#FFE8C7;">Hit Record — narrate as you click</div>
              <div class="text-[10px]" style="color:rgba(255,232,199,0.38);">Alt+Shift+R to toggle anywhere</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#C68A41,#7A4F1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Bebas Neue',sans-serif;font-size:11px;color:#1a0a00;">3</div>
            <div>
              <div class="text-[12px] font-semibold" style="color:#FFE8C7;">Get a Claude Code skill file</div>
              <div class="text-[10px]" style="color:rgba(255,232,199,0.38);">AI-readable, drops straight into ~/.claude</div>
            </div>
          </div>
        </div>
        <button id="goto-record" class="btn btn-primary w-full text-[12px]">Start my first recording →</button>
      </div>
    `;
    container.querySelector<HTMLButtonElement>("#goto-record")?.addEventListener("click", () => {
      view = { kind: "idle", tab: "record" };
      render();
    });
    return;
  }

  for (const r of rows) {
    const card = document.createElement("button");
    card.className = "w-full glass library-card text-left";
    card.style.padding = "12px 14px";
    card.style.cursor = "pointer";

    const title    = r.title || "Untitled recording";
    const date     = new Date(r.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const dur      = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : "—";
    const hasSkill = (r.skills?.length ?? 0) > 0;
    const kindsPresent = new Set((r.skills ?? []).map(s => s.kind ?? "skill"));
    const hasBoth  = kindsPresent.has("skill") && kindsPresent.has("improvement");
    const maxVersion = hasSkill ? Math.max(...(r.skills ?? []).map(s => s.version ?? 1)) : 1;
    const statusCls  = statusColor(r.status);
    const kindBadge  = r.mode === "improvement"
      ? `<span class="badge badge-orange" style="margin-left:4px;">brief</span>` : "";
    const skillBadge = hasSkill
      ? `<span class="badge badge-gold">${hasBoth ? "✦ Skill + Brief" : "✦ Skill"}${maxVersion > 1 ? ` · v${maxVersion}` : ""}</span>` : "";

    // Skill excerpt from the first non-heading content line
    const primarySkill = (r.skills ?? []).find(s => (s.kind ?? "skill") === "skill") ?? (r.skills ?? [])[0];
    let excerpt = "";
    if (primarySkill?.body_md) {
      const { body } = splitFrontmatter(primarySkill.body_md);
      excerpt = body
        .replace(/^---[\s\S]*?---\n?/m, "")
        .replace(/^#+\s+.*/gm, "")
        .replace(/\*\*/g, "")
        .replace(/\n+/g, " ")
        .trim()
        .slice(0, 90);
    }

    card.innerHTML = `
      <div class="flex items-start gap-2.5">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[13px] font-semibold truncate" style="color:#FFE8C7;">${escapeHtml(title)}</span>
            ${kindBadge}
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-[10px]" style="color:rgba(255,232,199,0.38);">${escapeHtml(date)} · ${dur}</span>
            ${skillBadge}
          </div>
          ${excerpt ? `<div class="text-[10px] mt-1.5 leading-relaxed" style="color:rgba(255,232,199,0.32);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(excerpt)}…</div>` : ""}
        </div>
        <span class="${statusCls}" style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;flex-shrink:0;">${r.status}</span>
      </div>
      ${r.status === "failed" ? `<div class="text-[10px] mt-2" style="color:rgba(248,113,113,0.60);">Generation failed — open to retry</div>` : ""}
      ${!hasSkill && r.status !== "failed" && r.status !== "recording" ? `<div class="text-[10px] mt-2" style="color:rgba(255,232,199,0.28);font-style:italic;">Generating…</div>` : ""}
    `;

    card.onclick = () => {
      const sorted     = [...(r.skills ?? [])].sort((a, b) => b.version - a.version);
      const primaryKind = (r.mode ?? "skill") as "skill" | "improvement";
      const primary    = sorted.find(s => (s.kind ?? "skill") === primaryKind) ?? sorted[0] ?? null;
      view = { kind: "skill", recording: r, skill: primary, allSkills: sorted };
      render();
    };

    container.appendChild(card);
  }
}


// ---- Settings tab ----

function settingsTab(): HTMLElement {
  const d = document.createElement("div");
  d.className = "px-5 py-5 space-y-3";

  d.innerHTML = `
    <div class="glass p-4">
      <div class="flex items-center gap-3 mb-4">
        <div id="avatar" style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#C68A41,#7A4F1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Bebas Neue',sans-serif;font-size:16px;color:#1a0a00;letter-spacing:0.08em;">?</div>
        <div class="flex-1 min-w-0">
          <div class="label" style="font-size:9px;margin-bottom:2px;">Signed in as</div>
          <div id="who" class="text-[13px] truncate" style="color:#FFE8C7;">…</div>
        </div>
      </div>
      <button id="signout" class="btn w-full">Sign out</button>
    </div>

    <div class="glass p-4">
      <div class="label mb-3" style="font-size:9px;">Export</div>
      <button id="export-all" class="btn w-full text-[12px] mb-2">Download all skills</button>
      <p class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.38);">All your skill files as a .zip — ready to drop into ~/.claude/skills/.</p>
    </div>

    <div class="glass p-4">
      <div class="label mb-3" style="font-size:9px;">Data</div>
      <button id="del" class="btn btn-danger w-full text-[12px]">Delete all my data</button>
      <p class="text-[11px] leading-relaxed mt-2" style="color:rgba(255,232,199,0.38);">Cascades through recordings, events, screenshots, audio, and skills. Cannot be undone.</p>
    </div>

    <div class="glass p-4">
      <div class="label mb-3" style="font-size:9px;">Keyboard shortcut</div>
      <div class="flex items-center justify-between">
        <span class="text-[12px]" style="color:rgba(255,232,199,0.65);">Toggle recording</span>
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="background:rgba(182,128,57,0.15);border:1px solid rgba(182,128,57,0.28);border-radius:4px;padding:2px 7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E4AF7A;">Alt</span>
          <span style="color:rgba(255,232,199,0.35);font-size:10px;">+</span>
          <span style="background:rgba(182,128,57,0.15);border:1px solid rgba(182,128,57,0.28);border-radius:4px;padding:2px 7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E4AF7A;">Shift</span>
          <span style="color:rgba(255,232,199,0.35);font-size:10px;">+</span>
          <span style="background:rgba(182,128,57,0.15);border:1px solid rgba(182,128,57,0.28);border-radius:4px;padding:2px 7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E4AF7A;">R</span>
        </div>
      </div>
      <p class="text-[10px] mt-2" style="color:rgba(255,232,199,0.28);">Start or stop recording from any tab — no need to open the popup.</p>
    </div>

    <div class="glass p-4">
      <div class="label mb-1" style="font-size:9px;">Version</div>
      <div class="text-[12px]" style="color:rgba(255,232,199,0.45);">Scout v0.2.2 · Orage AI Agency</div>
    </div>

    <div class="glass p-4">
      <div class="label mb-2" style="font-size:9px;">Support</div>
      <button id="report-problem" class="btn w-full text-[12px]">Report a problem</button>
      <p class="text-[10px] mt-2 leading-relaxed" style="color:rgba(255,232,199,0.32);">Opens a prefilled email with your extension version and last error. No PII is included.</p>
    </div>
  `;

  const auth = getAuthSupabase();
  const db   = getDataSupabase();

  auth.auth.getUser().then(({ data }) => {
    const email = data.user?.email ?? "—";
    d.querySelector<HTMLDivElement>("#who")!.textContent = email;
    const initials = email.slice(0, 2).toUpperCase();
    d.querySelector<HTMLDivElement>("#avatar")!.textContent = initials;
  });

  d.querySelector<HTMLButtonElement>("#signout")!.onclick = async () => {
    await auth.auth.signOut();
    view = { kind: "signed_out", mode: "signin" };
    render();
  };

  d.querySelector<HTMLButtonElement>("#export-all")!.onclick = async () => {
    const btn = d.querySelector<HTMLButtonElement>("#export-all")!;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      const { data: authUser } = await auth.auth.getUser();
      if (!authUser.user) throw new Error("not signed in");
      const { data: skills } = await db
        .from("skills")
        .select("title,body_md,kind,version")
        .eq("user_id", authUser.user.id)
        .order("created_at", { ascending: false });
      if (!skills || skills.length === 0) {
        btn.textContent = "No skills yet";
        setTimeout(() => { btn.disabled = false; btn.textContent = "Download all skills"; }, 2000);
        return;
      }
      const entries: { [k: string]: ReturnType<typeof strToU8> } = {};
      for (const s of skills as Array<{ title: string | null; body_md: string; kind?: string; version: number }>) {
        const slug = (s.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? s.title ?? "skill").trim().replace(/[^a-zA-Z0-9_-]/g, "-");
        const kindSuffix = s.kind === "improvement" ? "-improvement" : "";
        const filename = `${slug}${kindSuffix}-v${s.version}/SKILL.md`;
        entries[filename] = strToU8(s.body_md);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zip = zipSync(entries as any);
      const blob = new Blob([zip as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "scout-skills.zip"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      btn.textContent = `Downloaded ${skills.length} skill${skills.length !== 1 ? "s" : ""}`;
      setTimeout(() => { btn.disabled = false; btn.textContent = "Download all skills"; }, 3000);
    } catch (e) {
      btn.textContent = `Error: ${(e as Error).message}`;
      setTimeout(() => { btn.disabled = false; btn.textContent = "Download all skills"; }, 3000);
    }
  };

  d.querySelector<HTMLButtonElement>("#del")!.onclick = async () => {
    if (!confirm("Permanently delete all of your recordings and skills?")) return;
    const { data: u } = await auth.auth.getUser();
    if (!u.user) return;
    await db.from("recordings").delete().eq("user_id", u.user.id);
    alert("Deleted.");
  };

  d.querySelector<HTMLButtonElement>("#report-problem")!.onclick = async () => {
    const manifest = chrome.runtime.getManifest();
    const { data: u } = await auth.auth.getUser();
    const lastErr = (await chrome.storage.local.get("scout:last_error"))["scout:last_error"] ?? "none";
    const recentId = (await chrome.storage.local.get("scout:recent_recording_id"))["scout:recent_recording_id"] ?? "none";
    const body = [
      `Extension version: ${manifest.version}`,
      `User: ${u.user?.email ?? "not signed in"}`,
      `Recent recording: ${recentId}`,
      `Last error: ${lastErr}`,
      "",
      "Describe what happened:",
      "",
    ].join("\n");
    const mailto = `mailto:team@orage.agency?subject=${encodeURIComponent("Scout bug report v" + manifest.version)}&body=${encodeURIComponent(body)}`;
    chrome.tabs.create({ url: mailto });
  };

  return d;
}

// ---- Recording state view ----

function micBadgeHtml(s: RecordingSessionState): string {
  if (s.mic_enabled === false)
    return `<span class="badge badge-muted">🎙 off</span>`;
  if (s.audio_supported)
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#4ADE80;"><span style="width:6px;height:6px;border-radius:50%;background:#4ADE80;animation:pulse-dot 1.6s ease-in-out infinite;display:inline-block;"></span>MIC LIVE</span>`;
  return `<span class="badge badge-orange">🎙 denied</span>`;
}

function recordingView(s: RecordingSessionState): HTMLElement {
  const d = document.createElement("div");
  d.className = "px-5 py-5 flex flex-col gap-4";

  const startedMs = s.started_at;
  const audioBadge = micBadgeHtml(s);
  const tabTitle = s.active_tab_title?.trim() || (s.active_tab_url ? new URL(s.active_tab_url).hostname : "—");

  d.innerHTML = `
    <!-- Timer hero -->
    <div class="glass-hero p-5 text-center">
      <div class="flex items-center justify-center gap-2.5 mb-3">
        <span class="record-dot"></span>
        <span class="display text-[13px]" style="color:#E4AF7A;">${s.mode === "improvement" ? "Critiquing" : "Recording"}</span>
        ${audioBadge}
      </div>
      <div id="t" class="display text-[54px]" style="color:#FFE8C7;letter-spacing:0.04em;font-variant-numeric:tabular-nums;">00:00</div>
      <div id="tabname" class="text-[11px] mt-2 truncate" style="color:rgba(255,232,199,0.45);" title="${escapeHtml(tabTitle)}">
        on <span style="color:#FFE8C7;">${escapeHtml(tabTitle)}</span>
      </div>
    </div>

    <!-- Stats row -->
    <div class="glass p-3">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div id="evcount" class="text-[12px]" style="color:rgba(255,232,199,0.65);">${s.event_count ?? 0} events</div>
          <div id="shotcount" class="text-[10px] mt-0.5" style="color:rgba(255,232,199,0.35);">${s.shot_count ?? 0} screenshots</div>
        </div>
        <div class="text-right">
          <div class="label" style="font-size:8px;">tier</div>
          <div id="tier-display" class="text-[11px] mt-0.5" style="color:rgba(255,232,199,0.50);">Standard</div>
        </div>
      </div>
      <!-- Live richness bar -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="label" style="font-size:8px;">Recording richness</span>
          <span id="richness-label" class="text-[9px]" style="color:rgba(255,232,199,0.35);">Warming up</span>
        </div>
        <div style="height:2px;background:rgba(255,255,255,0.05);border-radius:1px;overflow:hidden;">
          <div id="richness-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#9A6228,#E4AF7A);border-radius:1px;transition:width 1.5s ease;"></div>
        </div>
      </div>
    </div>

    <!-- Controls -->
    <div class="flex gap-2">
      <button id="pause" class="btn flex-1">${s.is_paused ? "Resume" : "Pause"}</button>
      <button id="stop" class="btn btn-primary flex-1">Stop</button>
    </div>
    <button id="discard" class="btn w-full" style="color:rgba(239,68,68,0.85);border-color:rgba(239,68,68,0.35);font-size:11px;">Cancel recording</button>

    <!-- Live event feed -->
    <div class="glass p-3" id="live-feed-card" style="min-height:52px;">
      <div class="label mb-1.5" style="font-size:8px;">Live capture feed</div>
      <ul id="live-feed" class="flex flex-col gap-0.5"></ul>
    </div>

    <!-- Live transcript tail — only visible when voice is active and has text -->
    <div class="glass p-3" id="transcript-card" style="min-height:44px;${!s.mic_enabled ? 'display:none;' : ''}">
      <div class="label mb-1" style="font-size:8px;">Narration</div>
      <div id="transcript-tail" class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.55);font-style:italic;min-height:16px;">${escapeHtml(s.live_transcript_tail ?? "")}</div>
    </div>

    <div class="glass p-3" style="min-height:52px;">
      <div class="label mb-1" style="font-size:8px;">Tip</div>
      <div id="tip-text" class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.55);transition:opacity 0.4s;"></div>
    </div>
  `;

  // Show saved tier
  void getTier().then(t => {
    const el = d.querySelector<HTMLDivElement>("#tier-display");
    if (el) el.textContent = t.charAt(0).toUpperCase() + t.slice(1);
  });

  // Live timer — reads from view.state so it stays accurate across pause/resume.
  const tEl = d.querySelector<HTMLSpanElement>("#t")!;
  const timerInterval = setInterval(() => {
    const cur = view.kind === "recording" ? view.state : null;
    if (!cur) return;
    if (cur.is_paused) return; // freeze display while paused
    const ms  = Math.max(0, Date.now() - startedMs - (cur.paused_ms ?? 0));
    const sec = Math.floor(ms / 1000) % 60;
    const min = Math.floor(ms / 60000);
    tEl.textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }, 500);

  // Clean up interval when view changes
  const observer = new MutationObserver(() => {
    if (!d.isConnected) { clearInterval(timerInterval); observer.disconnect(); }
  });
  observer.observe(root, { childList: true, subtree: true });

  // Rotating narration tips — different sets per recording mode
  const SKILL_TIPS = [
    "Say what you're doing as you do it — \"I'm clicking Add to move this to my queue\".",
    "Mention the why, not just the what — \"We always skip this field for EU contacts\".",
    "Note exceptions as you see them — \"If it's red, that means it needs approval first\".",
    "Name the fields you fill in — \"Entering the lead email, always lowercase\".",
    "Call out decision points — \"Here I check if the total is over $500 before proceeding\".",
    "Switch tabs freely — the gold border and timer follow you everywhere.",
    "Alt+Shift+R to stop recording without reopening the popup.",
  ];
  const IMPROVEMENT_TIPS = [
    "Say what you expected to happen, then show what actually happened.",
    "Name the component or screen — \"This button on the Leads table doesn't…\"",
    "Show error messages or loading states you think are wrong.",
    "Call out confusion points — \"I always forget which tab this lives in\".",
    "Narrate impact — \"This makes it impossible to submit without going back\".",
    "Switch to any screen where the issue shows up — we follow you everywhere.",
    "Alt+Shift+R to stop recording without reopening the popup.",
  ];
  const TIPS = s.mode === "improvement" ? IMPROVEMENT_TIPS : SKILL_TIPS;
  let tipIdx = 0;
  const tipEl = d.querySelector<HTMLDivElement>("#tip-text");
  const rotateTip = () => {
    if (!tipEl || !d.isConnected) return;
    tipEl.style.opacity = "0";
    setTimeout(() => {
      if (!d.isConnected) return;
      tipEl.textContent = TIPS[tipIdx % TIPS.length];
      tipEl.style.opacity = "1";
      tipIdx++;
    }, 400);
  };
  if (tipEl) {
    tipEl.textContent = TIPS[0];
    tipIdx = 1;
    const tipInterval = setInterval(rotateTip, 8000);
    const tipObserver = new MutationObserver(() => {
      if (!d.isConnected) { clearInterval(tipInterval); tipObserver.disconnect(); }
    });
    tipObserver.observe(root, { childList: true, subtree: true });
  }

  d.querySelector<HTMLButtonElement>("#pause")!.onclick = async () => {
    const t = s.is_paused ? "popup:resume_recording" : "popup:pause_recording";
    await chrome.runtime.sendMessage({ type: t } satisfies RuntimeMessage);
    s.is_paused = !s.is_paused;
    render();
  };

  const stopBtn = d.querySelector<HTMLButtonElement>("#stop")!;
  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    const recordingId = s.recording_id;
    lastStopStats = {
      event_count: s.event_count ?? 0,
      shot_count: s.shot_count ?? 0,
      had_voice: !!(s.mic_enabled && s.live_transcript_tail),
    };
    await chrome.storage.local.set({ [RECENT_KEY]: recordingId });
    // Await the stop so that if the service worker is sleeping or unreachable
    // the error surfaces instead of being swallowed, and we retry once.
    let stopOk = false;
    for (let attempt = 0; attempt < 2 && !stopOk; attempt++) {
      try {
        await chrome.runtime.sendMessage({ type: "popup:stop_recording" } satisfies RuntimeMessage);
        stopOk = true;
      } catch {
        // Service worker may have been killed mid-session; give it a tick to restart.
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const db = getDataSupabase();
    const { data: rec } = await db.from("recordings").select("*").eq("id", recordingId).single();
    if (rec) {
      view = { kind: "extra_context", recording: rec as RecordingRow };
      render();
    } else {
      view = { kind: "idle", tab: "library" };
      render();
    }
  };

  let discardConfirming = false;
  let discardRevertTimer: ReturnType<typeof setTimeout> | null = null;
  const discardBtn = d.querySelector<HTMLButtonElement>("#discard")!;
  discardBtn.onclick = async () => {
    if (!discardConfirming) {
      discardConfirming = true;
      discardBtn.textContent = "Tap again to confirm delete";
      discardBtn.style.color = "#EF4444";
      discardBtn.style.borderColor = "rgba(239,68,68,0.4)";
      discardRevertTimer = setTimeout(() => {
        discardConfirming = false;
        discardBtn.textContent = "Cancel recording";
        discardBtn.style.color = "rgba(220,80,80,0.6)";
        discardBtn.style.borderColor = "rgba(220,80,80,0.15)";
      }, 3000);
    } else {
      if (discardRevertTimer) clearTimeout(discardRevertTimer);
      discardBtn.disabled = true;
      discardBtn.textContent = "Discarding…";
      try {
        await chrome.runtime.sendMessage({ type: "popup:cancel_recording" } satisfies RuntimeMessage);
      } catch { /* SW may be asleep */ }
      view = { kind: "idle", tab: "record" };
      render();
    }
  };

  return d;
}

// ---- Extra context view ----

function extraContextView(rec: RecordingRow): HTMLElement {
  const d = document.createElement("div");
  d.className = "px-5 py-5 flex flex-col gap-3";

  const dur = rec.duration_ms ? `${Math.round(rec.duration_ms / 1000)}s` : "";

  const evCount   = lastStopStats?.event_count ?? null;
  const shotCount = lastStopStats?.shot_count ?? null;
  const hasVoice  = lastStopStats?.had_voice ?? false;

  d.innerHTML = `
    <div class="glass p-5 flex flex-col gap-3">
      <div>
        <div class="display text-[18px]">Any other thoughts?</div>
        ${dur ? `<div class="text-[10px] mt-1" style="color:rgba(255,232,199,0.40);">${dur} captured · upload running in background</div>` : ""}
      </div>
      ${evCount !== null ? `
      <div class="flex gap-3 py-1">
        <div style="text-align:center;flex:1;">
          <div class="display text-[20px]" style="color:#E4AF7A;">${evCount}</div>
          <div class="label" style="font-size:8px;">events</div>
        </div>
        <div style="text-align:center;flex:1;">
          <div class="display text-[20px]" style="color:#E4AF7A;">${shotCount ?? 0}</div>
          <div class="label" style="font-size:8px;">screenshots</div>
        </div>
        <div style="text-align:center;flex:1;">
          <div class="display text-[20px]" style="color:${hasVoice ? '#4ADE80' : 'rgba(255,232,199,0.35)'};">${hasVoice ? '✓' : '—'}</div>
          <div class="label" style="font-size:8px;">voice</div>
        </div>
      </div>` : ""}
      <p class="text-[12px] leading-relaxed" style="color:rgba(255,232,199,0.60);">
        If a step had a non-obvious reason — a rule, an exception, a why behind option A vs B — drop a note so the skill captures it.
      </p>
      <textarea id="ec" class="input" rows="5"
        placeholder="e.g. We always pick earliest delivery for California orders — Prop 65 compliance." style="resize:vertical;min-height:90px;"></textarea>
      <div class="flex gap-2">
        <button id="ec-skip" class="btn flex-1">Skip</button>
        <button id="ec-save" class="btn btn-primary flex-1">Save &amp; generate</button>
      </div>
      <p class="text-[10px]" style="color:rgba(255,232,199,0.32);">Cmd/Ctrl+Enter to submit.</p>
    </div>
  `;

  // Short recording quality tip
  if (rec.duration_ms && rec.duration_ms < 15000) {
    const tip = document.createElement("div");
    tip.className = "glass p-3";
    tip.style.borderColor = "rgba(245,158,11,0.35)";
    tip.innerHTML = `
      <div class="flex items-start gap-2">
        <span style="color:#F59E0B;flex-shrink:0;font-size:13px;">⚡</span>
        <p class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.75);">
          Short recording (${Math.round(rec.duration_ms / 1000)}s). For the best skill, try recording the full workflow with narration — even 30-60s makes a big difference.
        </p>
      </div>
    `;
    d.querySelector<HTMLTextAreaElement>("#ec")!.closest(".glass")?.before(tip);
  }

  const ta   = d.querySelector<HTMLTextAreaElement>("#ec")!;
  const skip = d.querySelector<HTMLButtonElement>("#ec-skip")!;
  const save = d.querySelector<HTMLButtonElement>("#ec-save")!;

  const proceed = (extra?: string) => {
    void chrome.runtime.sendMessage({
      type: "popup:generate_skill",
      recording_id: rec.id,
      extra,
    } satisfies RuntimeMessage);
    view = { kind: "idle", tab: "library" };
    render();
  };

  skip.onclick = () => proceed(undefined);
  save.onclick = () => proceed(ta.value.trim() || undefined);
  ta.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") proceed(ta.value.trim() || undefined); };
  setTimeout(() => ta.focus(), 50);

  return d;
}

// ---- Auto-generate flow (SSE streaming) ----

async function runAutoGenerate(rec: RecordingRow, extra?: string): Promise<void> {
  const auth     = getAuthSupabase();
  const db       = getDataSupabase();
  const deadline = Date.now() + 180_000;

  // Phase 1: poll until recording is ready (upload + transcription done)
  while (Date.now() < deadline) {
    const { data } = await db.from("recordings").select("status").eq("id", rec.id).single();
    const status = data?.status as string | undefined;
    if (view.kind !== "processing" || view.recording.id !== rec.id) return;
    if (status === "uploading" || status === "recording") view.stage = "uploading";
    else if (status === "transcribing") view.stage = "transcribing";
    else if (status === "ready")        break;
    else if (status === "failed") { view.error = "Recording failed during upload or transcription."; render(); return; }
    render();
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (view.kind !== "processing" || view.recording.id !== rec.id) return;

  // Phase 2: skill drafting with live streaming preview
  view.stage = "drafting";
  liveStream = "";
  render();

  try {
    const { data: sess } = await auth.auth.getSession();
    const res = await fetch(functionUrl("generate-skill"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ recording_id: rec.id, extra }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      // New path: SSE streaming — updates DOM directly without full re-renders
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const lines = sseBuf.split("\n");
        sseBuf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(raw); } catch { continue; }

          if (evt.type === "skill_chunk") {
            liveStream += (evt.text as string) ?? "";
            const el = document.getElementById("stream-preview");
            if (el) {
              el.innerHTML = renderSkillMd(liveStream);
              el.scrollTop = el.scrollHeight;
            }
            // Advance progress bar from 80% → 95% as chunks arrive
            const bar = document.getElementById("gen-progress-bar");
            const pct = document.getElementById("gen-progress-pct");
            if (bar) {
              const cur = parseFloat(bar.style.width) || 80;
              if (cur < 95) {
                const next = Math.min(95, cur + 0.6);
                bar.style.width = `${next}%`;
                if (pct) pct.textContent = `${Math.round(next)}%`;
              }
            }
          } else if (evt.type === "done") {
            // Complete the progress bar before transitioning
            const bar = document.getElementById("gen-progress-bar");
            const pct = document.getElementById("gen-progress-pct");
            if (bar) { bar.style.width = "100%"; if (pct) pct.textContent = "100%"; }
            await new Promise((r) => setTimeout(r, 500));
            const allSkills = (evt.all as SkillRow[] | undefined) ?? [evt as unknown as SkillRow];
            let autoDownloaded = false;
            if (isAdmin()) {
              const skillRow = allSkills.find(s => (s.kind ?? "skill") === "skill");
              if (skillRow) {
                try { downloadClaudeSkill(skillRow); autoDownloaded = true; }
                catch (e) { console.warn("[scout] auto-download failed", e); }
              }
            }
            const { data: refreshed } = await db.from("recordings").select("*").eq("id", rec.id).single();
            if (view.kind === "processing" && view.recording.id === rec.id) {
              const recMode    = (refreshed as RecordingRow | null)?.mode ?? rec.mode ?? "skill";
              const primaryRow = allSkills.find(s => (s.kind ?? "skill") === recMode) ?? allSkills[0];
              liveStream = "";
              view = { kind: "skill", recording: (refreshed as RecordingRow) ?? rec, skill: primaryRow, allSkills, autoDownloaded };
              render();
            }
            break outer;
          } else if (evt.type === "error") {
            if (view.kind === "processing" && view.recording.id === rec.id) {
              view.error = evt.message as string;
              render();
            }
            break outer;
          }
        }
      }
    } else {
      // Legacy path: JSON response (old edge function without streaming)
      const skill = (await res.json()) as SkillRow;
      const { data: refreshed } = await db.from("recordings").select("*").eq("id", rec.id).single();
      if (view.kind === "processing" && view.recording.id === rec.id) {
        const allFromResponse  = ((skill as SkillRow & { all?: SkillRow[] }).all ?? [skill]) as SkillRow[];
        let autoDownloaded = false;
        if (isAdmin()) {
          const skillRow = allFromResponse.find(s => (s.kind ?? "skill") === "skill");
          if (skillRow) {
            try { downloadClaudeSkill(skillRow); autoDownloaded = true; }
            catch (e) { console.warn("[scout] auto-download failed", e); }
          }
        }
        const recMode    = (refreshed as RecordingRow | null)?.mode ?? rec.mode ?? "skill";
        const primaryRow = allFromResponse.find(s => (s.kind ?? "skill") === recMode) ?? allFromResponse[0];
        liveStream = "";
        view = { kind: "skill", recording: (refreshed as RecordingRow) ?? rec, skill: primaryRow, allSkills: allFromResponse, autoDownloaded };
        render();
      }
    }
  } catch (e) {
    if (view.kind === "processing" && view.recording.id === rec.id) {
      view.error = String((e as Error).message ?? e);
      render();
    }
  }
}

// ---- Processing view ----

function processingView(rec: RecordingRow, stage: "uploading" | "transcribing" | "drafting", error?: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "px-5 py-6 flex flex-col gap-4";

  const isImprovementMode = rec.mode === "improvement";
  const stages: Array<{ id: typeof stage; label: string; sub: string }> = [
    { id: "uploading",   label: "Uploading",    sub: "audio + screenshots" },
    { id: "transcribing",label: "Transcribing", sub: "voice narration" },
    { id: "drafting",    label: "Drafting",     sub: isImprovementMode ? "your improvement brief" : "your skill file" },
  ];
  const currentIdx = stages.findIndex((s) => s.id === stage);

  const stepsHtml = stages.map((s, i) => {
    const done   = i < currentIdx;
    const active = i === currentIdx;
    const dotCls = done ? "step-dot done" : active ? "step-dot active" : "step-dot pending";
    const labelColor = done ? "rgba(255,232,199,0.65)" : active ? "#FFE8C7" : "rgba(255,232,199,0.28)";
    const subColor   = done ? "rgba(255,232,199,0.35)" : active ? "rgba(255,232,199,0.50)" : "rgba(255,232,199,0.18)";
    return `
      <div class="step-row">
        <span class="${dotCls}"></span>
        <div>
          <div class="text-[13px]" style="color:${labelColor};font-weight:600;">${s.label}</div>
          <div class="text-[10px]" style="color:${subColor};">${s.sub}</div>
        </div>
      </div>
    `;
  }).join("");

  // Rough progress: uploading=20%, transcribing=50%, drafting=80% (bumps toward 100 during streaming)
  const progressPct = stage === "uploading" ? 20 : stage === "transcribing" ? 50 : 80;

  d.innerHTML = `
    <div class="glass p-5">
      <div class="flex items-start justify-between mb-1">
        <div class="display text-[18px]">${error ? "Something went wrong" : "Finishing up"}</div>
        ${!error ? `<span id="gen-progress-pct" class="text-[11px]" style="color:rgba(255,232,199,0.35);font-variant-numeric:tabular-nums;">${progressPct}%</span>` : ""}
      </div>
      <div class="text-[11px] mb-3" style="color:rgba(255,232,199,0.45);">
        ${error
          ? "Your recording was saved — retry from the library."
          : `${rec.duration_ms ? Math.round(rec.duration_ms / 1000) + "s recording" : "Processing"} · usually 30–60s`}
      </div>
      ${!error ? `
        <div style="height:2px;background:rgba(255,255,255,0.05);border-radius:1px;margin-bottom:16px;overflow:hidden;">
          <div id="gen-progress-bar" style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,#9A6228,#E4AF7A);border-radius:1px;transition:width 0.6s ease;"></div>
        </div>` : ""}
      ${error
        ? `<div class="glass-strong p-3 text-[12px] mb-3" style="color:#F87171;">${escapeHtml(error)}</div>`
        : stepsHtml}
    </div>
    ${!error && stage === "drafting" ? `
      <div class="glass p-3 animate-slide-up">
        <div class="flex items-center gap-2 mb-2">
          <span class="label" style="font-size:8px;">${isImprovementMode ? "Writing your improvement brief" : "Writing your skill"}</span>
          <span class="streaming-cursor"></span>
        </div>
        <div id="stream-preview" class="streaming-preview skill-md"></div>
      </div>
    ` : ""}
    ${error
      ? `<div class="flex gap-2">
           <button id="retry" class="btn btn-primary flex-1">Retry</button>
           <button id="back" class="btn flex-1">Library</button>
         </div>`
      : `<div class="glass p-3 flex items-start gap-2.5">
          <span style="color:#B68039;font-size:13px;flex-shrink:0;margin-top:1px;">ⓘ</span>
          <div class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.45);">You can close this popup — your skill saves to Downloads when it's ready. Reopen to pick up here.</div>
        </div>`}
  `;

  // If there's already buffered stream content (popup reopened mid-stream),
  // populate the preview immediately.
  if (!error && stage === "drafting" && liveStream) {
    const el = d.querySelector<HTMLDivElement>("#stream-preview");
    if (el) el.innerHTML = renderSkillMd(liveStream);
  }

  if (error) {
    d.querySelector<HTMLButtonElement>("#back")!.onclick = () => {
      view = { kind: "idle", tab: "library" };
      render();
    };
    d.querySelector<HTMLButtonElement>("#retry")!.onclick = () => {
      view = { kind: "processing", recording: rec, stage: "uploading" };
      render();
      void runAutoGenerate(rec);
    };
  }
  return d;
}

// ---- Skill view ----

function skillView(
  rec: RecordingRow,
  skill: SkillRow | null,
  allSkills: SkillRow[] = [],
  autoDownloaded = false,
): HTMLElement {
  const d = document.createElement("div");
  d.className = "px-5 py-4";

  // Back + header row
  const topRow = document.createElement("div");
  topRow.className = "flex items-start justify-between gap-2 mb-3";
  topRow.innerHTML = `
    <button id="back" class="btn btn-ghost" style="padding:5px 8px;font-size:11px;">← Library</button>
    <div class="flex items-center gap-2">
      <span class="${statusColor(rec.status)}" style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;">${rec.status}</span>
      <button id="del-rec" class="btn btn-ghost" style="padding:4px 7px;font-size:10px;color:rgba(248,113,113,0.65);" title="Delete recording">✕</button>
    </div>
  `;
  topRow.querySelector<HTMLButtonElement>("#back")!.onclick = () => {
    void chrome.storage.local.remove(RECENT_KEY);
    view = { kind: "idle", tab: "library" };
    render();
  };
  topRow.querySelector<HTMLButtonElement>("#del-rec")!.onclick = async () => {
    if (!confirm(`Delete "${rec.title || "this recording"}" and all its skills? This cannot be undone.`)) return;
    const btn = topRow.querySelector<HTMLButtonElement>("#del-rec")!;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const db = getDataSupabase();
      const { error } = await db.from("recordings").delete().eq("id", rec.id);
      if (error) throw new Error(error.message);
      await chrome.storage.local.remove(RECENT_KEY);
      view = { kind: "idle", tab: "library" };
      render();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
      btn.disabled = false;
      btn.textContent = "✕";
    }
  };
  d.appendChild(topRow);

  // Recording meta
  const meta = document.createElement("div");
  meta.className = "glass p-4 mb-3";
  const qScore = skill ? skillQualityScore(rec, skill) : null;
  const wordCount = skill
    ? skill.body_md
        .replace(/^---[\s\S]*?---\n?/m, "")
        .replace(/[#*`[\]()]/g, "")
        .split(/\s+/).filter(Boolean).length
    : 0;
  const readMins = wordCount > 0 ? Math.ceil(wordCount / 200) : 0;
  meta.innerHTML = `
    <div class="display text-[17px] mb-1" style="color:#E4AF7A;">${escapeHtml(rec.title || "Untitled")}</div>
    <div class="flex items-center gap-2 flex-wrap mb-1">
      <span class="text-[11px]" style="color:rgba(255,232,199,0.40);">
        ${escapeHtml(new Date(rec.started_at).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }))}
        · ${rec.duration_ms ? Math.round(rec.duration_ms / 1000) + "s recording" : "—"}
      </span>
      ${qScore ? `<span style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${qScore.color};background:rgba(0,0,0,0.28);border:1px solid currentColor;border-radius:3px;padding:1px 5px;opacity:0.85;" title="Skill quality: ${qScore.score}/100">${qScore.label}</span>` : ""}
    </div>
    ${wordCount > 0 ? `<div class="text-[10px]" style="color:rgba(255,232,199,0.28);">${wordCount} words · ${readMins} min read · v${skill?.version ?? 1}</div>` : ""}
  `;
  d.appendChild(meta);

  // No skill yet
  if (!skill) {
    const gen = document.createElement("div");
    gen.className = "glass p-4";
    gen.innerHTML = `
      <div class="text-[13px] mb-3" style="color:#FFE8C7;">No skill generated yet.</div>
      <button id="gen" class="btn btn-primary w-full">Generate Skill</button>
    `;
    gen.querySelector<HTMLButtonElement>("#gen")!.onclick = () => {
      view = { kind: "processing", recording: rec, stage: "uploading" };
      render();
      void runAutoGenerate(rec);
    };
    d.appendChild(gen);
    return d;
  }

  // Guest mode
  if (!isAdmin()) {
    const guestNote = document.createElement("div");
    guestNote.className = "glass p-4";
    guestNote.innerHTML = `
      <div class="display text-[15px] mb-2">Recording captured</div>
      <div class="text-[12px] leading-relaxed" style="color:rgba(255,232,199,0.65);">Your Orage admin will turn this into a skill for your hosted agent.</div>
    `;
    d.appendChild(guestNote);
    return d;
  }

  // Kind picker (skill ↔ improvements)
  const currentKind = (skill?.kind ?? "skill") as "skill" | "improvement";
  const kindsAvailable = Array.from(new Set(allSkills.map(s => (s.kind ?? "skill") as "skill" | "improvement")));
  if (kindsAvailable.length > 1) {
    const kindPicker = document.createElement("div");
    kindPicker.className = "flex gap-1.5 mb-2";
    for (const k of ["skill", "improvement"] as const) {
      if (!kindsAvailable.includes(k)) continue;
      const pill = document.createElement("button");
      pill.className = `tab-pill${k === currentKind ? " active" : ""}`;
      pill.textContent = k === "skill" ? "Skill" : "Improvements";
      pill.onclick = () => {
        const next = [...allSkills.filter(s => (s.kind ?? "skill") === k)].sort((a, b) => b.version - a.version)[0];
        if (next) {
          view = { kind: "skill", recording: rec, skill: next, allSkills, autoDownloaded: false };
          render();
        }
      };
      kindPicker.appendChild(pill);
    }
    d.appendChild(kindPicker);
  }

  // Version picker
  const sameKind = allSkills.filter(s => (s.kind ?? "skill") === currentKind);
  if (sameKind.length > 1) {
    const picker = document.createElement("div");
    picker.className = "flex flex-wrap gap-1.5 mb-3";
    for (const v of sameKind) {
      const pill = document.createElement("button");
      pill.className = `tab-pill${v.id === skill?.id ? " active" : ""}`;
      pill.textContent = `v${v.version}`;
      pill.title = new Date(v.created_at).toLocaleString();
      pill.onclick = () => {
        view = { kind: "skill", recording: rec, skill: v, allSkills, autoDownloaded: false };
        render();
      };
      picker.appendChild(pill);
    }
    d.appendChild(picker);
  }

  // Auto-downloaded banner
  if (autoDownloaded) {
    const banner = document.createElement("div");
    banner.className = "glass p-3 mb-3 flex items-center gap-2.5";
    banner.style.borderColor = "rgba(74,222,128,0.30)";
    banner.innerHTML = `
      <span style="width:20px;height:20px;border-radius:50%;background:#15803D;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;color:#fff;font-weight:700;">✓</span>
      <div>
        <div class="text-[12px] font-semibold" style="color:#FFE8C7;">Saved to Downloads</div>
        <div class="text-[10px]" style="color:rgba(255,232,199,0.45);">Extract the .zip into <code style="font-family:monospace;color:#E4AF7A;">~/.claude/skills/</code></div>
      </div>
    `;
    d.appendChild(banner);
  }

  // Action bar
  const isImprovement = skill.kind === "improvement" || rec.mode === "improvement";
  const actions = document.createElement("div");
  actions.className = "flex flex-col gap-2 mb-3";

  if (isImprovement) {
    actions.innerHTML = `
      <button id="cc-copy" class="btn btn-primary w-full">Copy for Claude Code</button>
      <div class="grid grid-cols-2 gap-2">
        <button id="cp" class="btn text-[11px]">Copy raw</button>
        <button id="dl" class="btn text-[11px]">Save .md</button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button id="edit-btn" class="btn text-[11px]">Edit</button>
        <button id="refine-btn" class="btn text-[11px]">Refine with AI</button>
      </div>
    `;
    actions.querySelector<HTMLButtonElement>("#cc-copy")!.onclick = async () => {
      await navigator.clipboard.writeText(formatBriefForClaudeCode(skill, rec));
      const b = actions.querySelector<HTMLButtonElement>("#cc-copy")!;
      b.textContent = "Copied — paste into Claude Code";
      setTimeout(() => { b.textContent = "Copy for Claude Code"; }, 2500);
    };
    actions.querySelector<HTMLButtonElement>("#dl")!.onclick = () => downloadMd(skill);
    actions.querySelector<HTMLButtonElement>("#cp")!.onclick = async () => {
      await navigator.clipboard.writeText(skill.body_md);
      const b = actions.querySelector<HTMLButtonElement>("#cp")!;
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy raw"; }, 1500);
    };
    actions.querySelector<HTMLButtonElement>("#edit-btn")!.onclick = (e) => {
      toggleEditor(d, skill, e.currentTarget as HTMLButtonElement);
    };
    actions.querySelector<HTMLButtonElement>("#refine-btn")!.onclick = () => toggleRefinePanel(d, rec, skill, allSkills);
  } else {
    actions.innerHTML = `
      <button id="cc-copy" class="btn btn-primary w-full">Copy for Claude Code — use right now</button>
      <button id="claude" class="btn w-full text-[12px]">
        ${autoDownloaded ? "Save .zip again" : "Save as .zip (for ~/.claude/skills/)"}
      </button>
      <div class="grid grid-cols-3 gap-2">
        <button id="cp" class="btn text-[11px]">Copy raw</button>
        <button id="dl" class="btn text-[11px]">Save .md</button>
        <button id="dryrun" class="btn text-[11px]" style="color:#E4AF7A;">Run</button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button id="edit-btn" class="btn text-[11px]">Edit</button>
        <button id="refine-btn" class="btn text-[11px]">Refine with AI</button>
      </div>
      <pre id="dryout" class="text-[10px] hidden whitespace-pre-wrap" style="background:rgba(0,0,0,0.55);padding:10px;border-radius:6px;color:rgba(255,232,199,0.75);max-height:180px;overflow-y:auto;border:1px solid rgba(182,128,57,0.18);"></pre>
    `;
    actions.querySelector<HTMLButtonElement>("#cc-copy")!.onclick = async () => {
      const vars = extractVariables(skill.body_md);
      if (vars.length > 0) {
        // Show the variable fill panel instead of copying immediately.
        const existing = actions.querySelector("#var-panel");
        if (existing) { existing.remove(); return; }
        const panel = buildVarPanel(skill, async (filled) => {
          await navigator.clipboard.writeText(formatSkillForClaudeCode(skill, filled));
        });
        actions.appendChild(panel);
        return;
      }
      await navigator.clipboard.writeText(formatSkillForClaudeCode(skill));
      const b = actions.querySelector<HTMLButtonElement>("#cc-copy")!;
      b.textContent = "Copied — paste into Claude Code";
      setTimeout(() => { b.textContent = "Copy for Claude Code — use right now"; }, 2500);
    };
    actions.querySelector<HTMLButtonElement>("#claude")!.onclick = () => downloadClaudeSkill(skill);
    actions.querySelector<HTMLButtonElement>("#dl")!.onclick = () => downloadMd(skill);
    actions.querySelector<HTMLButtonElement>("#cp")!.onclick = async () => {
      await navigator.clipboard.writeText(skill.body_md);
      const b = actions.querySelector<HTMLButtonElement>("#cp")!;
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy raw"; }, 1500);
    };
    actions.querySelector<HTMLButtonElement>("#edit-btn")!.onclick = (e) => {
      toggleEditor(d, skill, e.currentTarget as HTMLButtonElement);
    };
    actions.querySelector<HTMLButtonElement>("#refine-btn")!.onclick = () => toggleRefinePanel(d, rec, skill, allSkills);
    actions.querySelector<HTMLButtonElement>("#dryrun")!.onclick = () => void runDryRun(skill, actions);
  }
  d.appendChild(actions);

  // Install hint
  const slug = (skill.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? "skill").trim();
  const hint = document.createElement("div");
  hint.className = "glass p-3 mb-3";
  hint.innerHTML = `
    <div class="label mb-1" style="font-size:8px;">Install</div>
    <div class="text-[11px] leading-relaxed" style="color:rgba(255,232,199,0.55);">
      Extract zip into <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.13);padding:1px 5px;border-radius:3px;color:#E4AF7A;">~/.claude/skills/</code>
      — Claude Code picks up <span style="color:#E4AF7A;font-weight:600;">${escapeHtml(slug)}</span> on next session.
    </div>
  `;
  d.appendChild(hint);

  // Frontmatter + body
  const { frontmatter, body } = splitFrontmatter(stripImageRefs(skill.body_md));
  if (frontmatter) {
    const fm = document.createElement("div");
    fm.className = "glass p-3 mb-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words";
    fm.style.fontFamily = "'JetBrains Mono', monospace";
    fm.style.color = "rgba(255,232,199,0.48)";
    fm.textContent = frontmatter;
    d.appendChild(fm);
  }

  const mdWrap = document.createElement("div");
  mdWrap.className = "relative";
  const md = document.createElement("article");
  md.className = "skill-md text-primary";
  md.innerHTML = renderSkillMd(body);
  // Bottom fade to hint there's more content below
  const fade = document.createElement("div");
  fade.className = "skill-body-fade";
  mdWrap.appendChild(md);
  mdWrap.appendChild(fade);
  d.appendChild(mdWrap);

  // "Record again" CTA at the bottom
  const cta = document.createElement("div");
  cta.className = "glass p-4 mt-3 mb-2 flex items-center justify-between";
  cta.innerHTML = `
    <div>
      <div class="text-[12px] font-semibold" style="color:#FFE8C7;">Capture another workflow?</div>
      <div class="text-[10px] mt-0.5" style="color:rgba(255,232,199,0.40);">Each recording sharpens your AI agent.</div>
    </div>
    <button id="cta-record" class="btn btn-primary text-[11px]" style="padding:6px 12px;white-space:nowrap;">Record →</button>
  `;
  cta.querySelector<HTMLButtonElement>("#cta-record")!.onclick = () => {
    view = { kind: "idle", tab: "record" };
    render();
  };
  d.appendChild(cta);

  return d;
}

// ---- Inline skill editor ----

function toggleEditor(container: HTMLElement, skill: SkillRow, toggleBtn: HTMLButtonElement): void {
  const existing = container.querySelector<HTMLDivElement>("#skill-editor-panel");
  if (existing) {
    existing.remove();
    toggleBtn.textContent = "Edit";
    return;
  }
  toggleBtn.textContent = "Close editor";

  const panel = document.createElement("div");
  panel.id = "skill-editor-panel";
  panel.className = "glass p-3 mb-3 animate-slide-up";
  panel.innerHTML = `
    <div class="label mb-2" style="font-size:8px;">Edit skill — raw markdown</div>
    <textarea id="skill-editor-ta" class="skill-editor-textarea"></textarea>
    <div class="flex gap-2 mt-2">
      <button id="editor-save" class="btn btn-primary flex-1 text-[12px]">Save</button>
      <button id="editor-cancel" class="btn flex-1 text-[12px]">Cancel</button>
    </div>
    <p id="editor-status" class="text-[10px] mt-1.5" style="color:rgba(255,232,199,0.45);min-height:14px;"></p>
  `;

  const ta     = panel.querySelector<HTMLTextAreaElement>("#skill-editor-ta")!;
  const status = panel.querySelector<HTMLParagraphElement>("#editor-status")!;
  ta.value = skill.body_md;

  panel.querySelector<HTMLButtonElement>("#editor-cancel")!.onclick = () => {
    panel.remove();
    toggleBtn.textContent = "Edit";
  };

  panel.querySelector<HTMLButtonElement>("#editor-save")!.onclick = async () => {
    const saveBtn = panel.querySelector<HTMLButtonElement>("#editor-save")!;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    status.textContent = "";
    try {
      const db = getDataSupabase();
      const newBody = ta.value;
      const { error } = await db.from("skills").update({ body_md: newBody }).eq("id", skill.id);
      if (error) throw new Error(error.message);
      skill.body_md = newBody;
      status.textContent = "Saved.";
      status.style.color = "#4ADE80";
      const mdEl = container.querySelector<HTMLElement>("article.skill-md");
      if (mdEl) {
        const { body } = splitFrontmatter(stripImageRefs(newBody));
        mdEl.innerHTML = renderSkillMd(body);
      }
      setTimeout(() => { panel.remove(); toggleBtn.textContent = "Edit"; }, 800);
    } catch (e) {
      status.textContent = `Error: ${(e as Error).message}`;
      status.style.color = "#F87171";
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  };

  const article = container.querySelector("article.skill-md");
  if (article) container.insertBefore(panel, article);
  else container.appendChild(panel);
  setTimeout(() => ta.focus(), 40);
}

// ---- AI refinement panel ----

function toggleRefinePanel(container: HTMLElement, rec: RecordingRow, skill: SkillRow, _allSkills: SkillRow[]): void {
  const existing = container.querySelector<HTMLDivElement>("#refine-panel");
  if (existing) { existing.remove(); return; }

  const panel = document.createElement("div");
  panel.id = "refine-panel";
  panel.className = "glass p-3 mb-3 animate-slide-up";
  panel.innerHTML = `
    <div class="label mb-2" style="font-size:8px;">Refine with AI</div>
    <p class="text-[11px] mb-2 leading-relaxed" style="color:rgba(255,232,199,0.55);">Describe what to change. A new version will be generated.</p>
    <textarea id="refine-ta" class="input text-[12px]" rows="3"
      placeholder="e.g. Add more detail to the Faster path. The API endpoint is POST /api/v2/leads."></textarea>
    <div class="flex gap-2 mt-2">
      <button id="refine-go" class="btn btn-primary flex-1 text-[12px]">Regenerate</button>
      <button id="refine-cancel" class="btn flex-1 text-[12px]">Cancel</button>
    </div>
  `;

  const ta = panel.querySelector<HTMLTextAreaElement>("#refine-ta")!;
  panel.querySelector<HTMLButtonElement>("#refine-cancel")!.onclick = () => panel.remove();
  panel.querySelector<HTMLButtonElement>("#refine-go")!.onclick = () => {
    const instruction = ta.value.trim();
    if (!instruction) return;
    panel.remove();
    const refinementExtra = `[REFINEMENT REQUEST — existing skill below for reference]\n${skill.body_md}\n\n[REQUESTED CHANGES]\n${instruction}`;
    view = { kind: "processing", recording: rec, stage: "uploading" };
    render();
    void runAutoGenerate(rec, refinementExtra);
  };
  ta.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { panel.querySelector<HTMLButtonElement>("#refine-go")!.click(); } };

  const article = container.querySelector("article.skill-md");
  if (article) container.insertBefore(panel, article);
  else container.appendChild(panel);
  setTimeout(() => ta.focus(), 40);
}

// ---- Skill quality score ----

function skillQualityScore(
  rec: RecordingRow,
  skill: SkillRow,
): { score: number; label: string; color: string } {
  let pts = 0;
  const dur = rec.duration_ms ?? 0;
  if (dur >= 120000) pts += 30;
  else if (dur >= 30000) pts += 20;
  else if (dur >= 5000) pts += 10;

  const words = (rec.transcript?.segments ?? []).reduce(
    (n, seg) => n + seg.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  if (words >= 100) pts += 30;
  else if (words >= 20) pts += 20;
  else if (words > 0) pts += 10;

  const bodyLen = skill.body_md?.length ?? 0;
  if (bodyLen >= 2000) pts += 40;
  else if (bodyLen >= 800) pts += 25;
  else if (bodyLen >= 200) pts += 15;

  const score = Math.min(100, pts);
  if (score >= 85) return { score, label: "Excellent", color: "#4ADE80" };
  if (score >= 65) return { score, label: "Strong",    color: "#E4AF7A" };
  if (score >= 40) return { score, label: "Good",      color: "rgba(255,232,199,0.65)" };
  return              { score, label: "Minimal",        color: "rgba(255,232,199,0.35)" };
}

// ---- Utilities ----

function statusColor(s: string): string {
  if (s === "ready")                               return "status-ready";
  if (s === "failed")                              return "status-failed";
  if (s === "transcribing" || s === "uploading")   return "status-progress";
  return "status-idle";
}

function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: "", body: md };
  return { frontmatter: m[1].trim(), body: md.slice(m[0].length) };
}

function stripImageRefs(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[ \t]+\n/g, "\n");
}


async function runDryRun(skill: SkillRow, container: HTMLElement): Promise<void> {
  const out   = container.querySelector<HTMLPreElement>("#dryout")!;
  const btn   = container.querySelector<HTMLButtonElement>("#dryrun")!;
  const auth  = getAuthSupabase();

  btn.disabled = true;
  btn.textContent = "Planning…";
  out.classList.remove("hidden");
  out.textContent = "Sending to Claude…";

  // Collect variable inputs if the skill declares any.
  const vars = extractVariables(skill.body_md);
  let inputs: Record<string, string> = {};
  if (vars.length > 0) {
    const examples = extractExampleValues(skill.body_md);
    const inputsRaw = prompt(
      `This skill has ${vars.length} variable(s): ${vars.join(", ")}\n\nEnter values as JSON (leave blank to use example values):`,
      JSON.stringify(examples, null, 2),
    );
    if (inputsRaw === null) {
      // User cancelled.
      out.classList.add("hidden");
      btn.disabled = false;
      btn.textContent = "Run";
      return;
    }
    try { inputs = inputsRaw.trim() ? JSON.parse(inputsRaw) : examples; }
    catch {
      out.textContent = "Invalid JSON — check your input and try again.";
      btn.disabled = false;
      btn.textContent = "Run";
      return;
    }
  }

  try {
    const { data: sess } = await auth.auth.getSession();
    const res = await fetch(functionUrl("run-skill"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ skill_id: skill.id, inputs }),
    });

    if (!res.ok) {
      out.textContent = `Error ${res.status}: ${await res.text()}`;
      return;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const j = await res.json() as Record<string, unknown>;
      out.textContent = JSON.stringify(j, null, 2);
      return;
    }

    // Streaming path: render each SSE event as it arrives.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";
    const lines: string[] = [];

    const appendLine = (line: string) => {
      lines.push(line);
      out.textContent = lines.join("\n");
      out.scrollTop = out.scrollHeight;
    };

    appendLine("Planning execution…");

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const parts = sseBuf.split("\n");
      sseBuf = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const raw = part.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let evt: Record<string, unknown>;
        try { evt = JSON.parse(raw); } catch { continue; }

        switch (evt.type) {
          case "status":
            appendLine(`⏳ ${evt.message}`);
            break;
          case "plan":
            lines.length = 0;
            appendLine("Plan:");
            for (const s of (evt.steps as Array<{ n: number; description: string; type: string }>) ?? []) {
              appendLine(`  ${s.n}. [${s.type.toUpperCase()}] ${s.description}`);
            }
            appendLine("");
            appendLine("Executing…");
            break;
          case "step_start":
            appendLine(`▶ Step ${evt.n}: ${evt.description}`);
            break;
          case "step_done": {
            const st = evt.status as string;
            const icon = st === "ok" ? "✓" : st === "manual" ? "✋" : st === "blocked" ? "🚫" : "✗";
            let detail = "";
            if (st === "ok" && evt.output) {
              const out2 = evt.output;
              detail = " → " + (typeof out2 === "object" ? JSON.stringify(out2).slice(0, 120) : String(out2).slice(0, 120));
            } else if (evt.error) {
              detail = ` → ${evt.error}`;
            } else if (evt.note) {
              detail = ` → ${evt.note}`;
            }
            appendLine(`  ${icon} Step ${evt.n} ${st.toUpperCase()}${detail}`);
            break;
          }
          case "done":
            appendLine("");
            appendLine(`✅ Run ${(evt.status as string).toUpperCase()} (${(evt.results as unknown[])?.length ?? 0} steps)`);
            break outer;
          case "error":
            appendLine(`\n❌ Error: ${evt.message}`);
            break outer;
        }
      }
    }
  } catch (e) {
    out.textContent = `Error: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run";
  }
}

function highlightVariables(html: string): string {
  // Wrap {snake_case_var} in a styled span. Only match outside HTML tags
  // (i.e. when not preceded by = or ") to avoid corrupting attributes.
  return html.replace(/(?<![="a-zA-Z0-9])\{([a-z_][a-z0-9_]*)\}/g,
    (_, name: string) => `<span class="skill-var">{${name}}</span>`);
}

function renderSkillMd(bodyMd: string): string {
  const html = marked.parse(bodyMd, { async: false }) as string;
  return highlightVariables(html);
}

function extractVariables(bodyMd: string): string[] {
  const seen = new Set<string>();
  for (const [, name] of bodyMd.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)) seen.add(name);
  return Array.from(seen);
}

function extractExampleValues(bodyMd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = bodyMd.match(/## Input examples[\s\S]*?```json\s*([\s\S]*?)```/i);
  if (!m) return out;
  try {
    const obj = JSON.parse(m[1]);
    for (const [k, v] of Object.entries(obj)) out[k] = String(v);
  } catch { /* malformed json — just use empty defaults */ }
  return out;
}

function substituteVariables(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z_][a-z0-9_]*)\}/g, (match, name: string) => values[name] ?? match);
}

function buildVarPanel(skill: SkillRow, onCopy: (filled: string) => void): HTMLElement {
  const vars = extractVariables(skill.body_md);
  const examples = extractExampleValues(skill.body_md);
  const panel = document.createElement("div");
  panel.id = "var-panel";
  panel.className = "flex flex-col gap-2 p-3 rounded-lg mt-1";
  panel.style.cssText = "background:rgba(0,0,0,0.4);border:1px solid rgba(182,128,57,0.25);";

  const header = document.createElement("p");
  header.className = "text-[10px] font-semibold tracking-wider uppercase";
  header.style.color = "#B68039";
  header.textContent = `Fill ${vars.length} variable${vars.length !== 1 ? "s" : ""} before copying`;
  panel.appendChild(header);

  const inputs: Record<string, HTMLInputElement> = {};
  for (const name of vars) {
    const lbl = document.createElement("label");
    lbl.className = "flex flex-col gap-0.5";
    const nameEl = document.createElement("span");
    nameEl.className = "text-[10px]";
    nameEl.style.color = "rgba(228,175,122,0.65)";
    nameEl.textContent = name;
    lbl.appendChild(nameEl);
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = examples[name] ?? "";
    inp.placeholder = `{${name}}`;
    inp.className = "text-[11px] px-2 py-1 rounded focus:outline-none";
    inp.style.cssText = "background:rgba(0,0,0,0.5);border:1px solid rgba(182,128,57,0.3);color:#FFE8C7;";
    inp.addEventListener("focus", () => { inp.style.borderColor = "#B68039"; });
    inp.addEventListener("blur", () => { inp.style.borderColor = "rgba(182,128,57,0.3)"; });
    lbl.appendChild(inp);
    panel.appendChild(lbl);
    inputs[name] = inp;
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-primary w-full text-[12px] mt-1";
  copyBtn.textContent = "Copy with variables filled";
  copyBtn.onclick = () => {
    const values: Record<string, string> = {};
    for (const [k, inp] of Object.entries(inputs)) values[k] = inp.value.trim() || `{${k}}`;
    onCopy(substituteVariables(skill.body_md, values));
    copyBtn.textContent = "Copied — paste into Claude Code";
    setTimeout(() => { copyBtn.textContent = "Copy with variables filled"; }, 2500);
  };
  panel.appendChild(copyBtn);
  return panel;
}

function formatSkillForClaudeCode(skill: SkillRow, filledBody?: string): string {
  const body = filledBody ?? skill.body_md;
  const desc = (body.match(/^description:\s*(.+)$/m)?.[1] ?? "this workflow").trim();
  return `I'm sharing a skill with you so you can use it in this session. Learn it and confirm you understand it.

---

${body.trim()}

---

When I ask you to perform tasks matching this skill's description ("${desc}"), follow the steps above.`;
}

function formatBriefForClaudeCode(skill: SkillRow, _rec: RecordingRow): string {
  return `You are about to make a change to my app based on a critique I recorded while using it. The brief below was generated from a Scout recording — clicks, screenshots, and narration. Read it, ask if anything is unclear, then make the change.

---

${skill.body_md.trim()}

---

When you're done, summarise the file(s) you changed and any decisions you made.`;
}

function downloadMd(skill: SkillRow): void {
  const blob = new Blob([skill.body_md], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `${skill.title || "skill"}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadClaudeSkill(skill: SkillRow): void {
  const slug     = (skill.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? "scout-skill").trim();
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "-");
  const readme   = [
    `Generated by Scout — ${new Date().toISOString().slice(0, 10)}`,
    `Recording title: ${skill.title ?? "(untitled)"}`,
    ``,
    `To use this skill with Claude Code:`,
    `  1. Extract this zip into ~/.claude/skills/   (so the skill ends up at ~/.claude/skills/${safeSlug}/SKILL.md)`,
    `  2. Restart Claude Code (or start a new session)`,
    `  3. Claude will discover this skill via its frontmatter`,
    ``,
  ].join("\n");
  const zip  = zipSync({
    [`${safeSlug}/SKILL.md`]:   strToU8(skill.body_md),
    [`${safeSlug}/README.txt`]: strToU8(readme),
  });
  const blob = new Blob([zip as BlobPart], { type: "application/zip" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `${safeSlug}.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function updateRichnessBar(eventCount: number, shotCount: number): void {
  const bar = document.getElementById("richness-bar");
  const label = document.getElementById("richness-label");
  if (!bar || !label) return;
  // Score: events contribute 60%, screenshots 40%. Saturates around 30 events / 5 shots.
  const evScore  = Math.min(1, eventCount / 30);
  const shScore  = Math.min(1, shotCount / 5);
  const pct      = Math.round((evScore * 0.6 + shScore * 0.4) * 100);
  bar.style.width = `${pct}%`;
  if (pct >= 80)       { label.textContent = "Excellent"; label.style.color = "#4ADE80"; }
  else if (pct >= 55)  { label.textContent = "Good";      label.style.color = "#E4AF7A"; }
  else if (pct >= 25)  { label.textContent = "Building";  label.style.color = "rgba(255,232,199,0.55)"; }
  else                 { label.textContent = "Warming up"; label.style.color = "rgba(255,232,199,0.35)"; }
}

async function hydrateSkill(skillId: string): Promise<void> {
  if (view.kind !== "skill") return;
  const db = getDataSupabase();
  const { data: full } = await db.from("skills").select("*").eq("id", skillId).single();
  if (!full || view.kind !== "skill" || view.skill?.id !== skillId) return;
  if (full.body_md && full.body_md !== view.skill.body_md) {
    view = { ...view, skill: full as SkillRow };
    render();
  }
}

async function refreshSkillView(recordingId: string): Promise<void> {
  const db = getDataSupabase();
  const { data: rec } = await db
    .from("recordings")
    .select("*, skills(id,recording_id,user_id,version,title,body_md,kind,prompt_used,created_at)")
    .eq("id", recordingId)
    .single();
  if (!rec) return;
  const skills = (rec as RecordingRow & { skills?: SkillRow[] }).skills ?? [];
  const sorted = [...skills].sort((a, b) => b.version - a.version);
  const recMode = (rec as RecordingRow).mode ?? "skill";
  const primary = sorted.find(s => (s.kind ?? "skill") === recMode) ?? sorted[0] ?? null;
  view = { kind: "skill", recording: rec as RecordingRow, skill: primary, allSkills: sorted };
  render();
}

// ---- Boot ----

chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === "popup:skill_ready") {
    if (view.kind === "idle") {
      render(); // re-render current tab to pick up the new skill in library
    }
  }
});

void init();

let authClient: ReturnType<typeof getAuthSupabase> | null = null;
try {
  authClient = getAuthSupabase();
  getDataSupabase();
} catch { /* unconfigured build */ }

authClient?.auth.onAuthStateChange((_evt, sess) => {
  if (!sess && view.kind !== "signed_out") {
    view = { kind: "signed_out", mode: "signin" };
    render();
  } else if (sess && (view.kind === "signed_out" || view.kind === "loading")) {
    view = { kind: "idle", tab: "record" };
    render();
  }
});

chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === "popup:state") {
    if (view.kind === "recording" && msg.state && msg.state.recording_id === view.state.recording_id) {
      view = { kind: "recording", state: msg.state };
      render();
    }
    return;
  }
  if (msg.type === "popup:counts") {
    if (view.kind === "recording") {
      view.state.event_count = msg.event_count;
      view.state.shot_count  = msg.shot_count;
    }
    const evEl = document.getElementById("evcount");
    const shEl = document.getElementById("shotcount");
    if (evEl) evEl.textContent = `${msg.event_count} events`;
    if (shEl) shEl.textContent = `${msg.shot_count} screenshots`;
    // Update live richness bar
    updateRichnessBar(msg.event_count, msg.shot_count);
    // Update live event feed
    if (msg.last_event_desc) {
      const feed = document.getElementById("live-feed");
      if (feed) {
        const li = document.createElement("li");
        li.className = "text-[10px] flex items-center gap-1.5";
        li.style.color = "rgba(255,232,199,0.60)";
        li.innerHTML = `<span style="width:5px;height:5px;border-radius:50%;background:#B68039;flex-shrink:0;"></span>${escapeHtml(msg.last_event_desc)}`;
        feed.insertBefore(li, feed.firstChild);
        // Keep max 4 entries
        while (feed.children.length > 4) feed.removeChild(feed.lastChild!);
      }
    }
    return;
  }
  if (msg.type === "popup:transcript_tail") {
    const el = document.getElementById("transcript-tail");
    const card = document.getElementById("transcript-card");
    if (el) {
      el.textContent = msg.tail;
      if (card && msg.tail) card.style.display = "";
    }
    if (view.kind === "recording") view.state.live_transcript_tail = msg.tail;
    return;
  }
  if (msg.type === "popup:recording_changed") {
    if (view.kind === "skill" && view.recording.id === msg.recording_id) {
      void refreshSkillView(msg.recording_id);
      return;
    }
    if (view.kind === "idle" && view.tab === "library") {
      loadLibraryData().then((data) => {
        if (data) {
          const list = document.getElementById("list");
          if (list) renderCards(list, data);
        }
      });
    }
  }
});
