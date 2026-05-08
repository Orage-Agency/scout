// Content script — runs in every tab. Listens for user actions, builds
// selector descriptors, posts to the service worker. Also renders the
// floating recording control bar and the coaching toast.

import { buildSelector } from "../lib/selector";
import { isPasswordField, redactString, truncatePaste } from "../lib/redaction";
import { uuid } from "../lib/ids";
import type { CapturedEvent, RuntimeMessage } from "../lib/types";

(() => {
  // Avoid double-injection (Chrome may auto-inject + we may force-inject).
  const W = window as unknown as { __scout_injected__?: boolean };
  if (W.__scout_injected__) return;
  W.__scout_injected__ = true;

  // ---- Event capture ----

  const post = (kind: CapturedEvent["kind"], data: Record<string, unknown>) => {
    const ev: CapturedEvent = {
      ts_ms: 0, // service worker rewrites with offset from started_at
      kind,
      data,
      _localId: uuid(),
    };
    chrome.runtime.sendMessage({ type: "content:event", event: ev } satisfies RuntimeMessage).catch(() => {});
  };

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (!target || isOurOwnUi(target)) return;
      const sel = buildSelector(target);
      post("click", { x: e.clientX, y: e.clientY, target: sel, tab_url: location.href });
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "keydown",
    (e) => {
      const target = e.target as Element | null;
      if (!target || isOurOwnUi(target)) return;
      const sel = buildSelector(target);
      const isPwd = isPasswordField(target);
      const key = isPwd ? "[REDACTED]" : sanitizeKey(e.key);
      post("keydown", {
        key,
        modifiers: { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey },
        target: sel,
        is_password: isPwd,
      });
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "paste",
    (e) => {
      const target = e.target as Element | null;
      if (!target || isOurOwnUi(target)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      const snippet = redactString(truncatePaste(text, 200));
      post("paste", { content_snippet: snippet, target: buildSelector(target) });
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "copy",
    (e) => {
      const target = e.target as Element | null;
      if (!target || isOurOwnUi(target)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      post("copy", { content_length: text.length, source: buildSelector(target) });
    },
    { capture: true, passive: true }
  );

  // Focus moves between form fields.
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as Element | null;
      if (!t || isOurOwnUi(t)) return;
      const tag = t.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
      post("focus_change", { to: buildSelector(t) });
    },
    { capture: true, passive: true }
  );

  // Dropdown selections and checkbox/radio toggles — not captured by mousedown.
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement | null;
      if (!t || isOurOwnUi(t)) return;
      const tag = t.tagName.toLowerCase();
      const sel = buildSelector(t);
      if (tag === "select") {
        const opt = (t as HTMLSelectElement).options[(t as HTMLSelectElement).selectedIndex];
        post("select_change", { selected_text: opt?.text ?? "", value: t.value, target: sel });
      } else if (tag === "input") {
        const inp = t as HTMLInputElement;
        if (inp.type === "checkbox" || inp.type === "radio") {
          post("checkbox_change", { checked: inp.checked, value: inp.value, target: sel });
        }
      }
    },
    { capture: true, passive: true }
  );

  // Form field blur — capture the filled value when user leaves a text input.
  // This gives the skill generator concrete variable examples for typed values.
  document.addEventListener(
    "blur",
    (e) => {
      const t = e.target as HTMLInputElement | HTMLTextAreaElement | null;
      if (!t || isOurOwnUi(t)) return;
      const tag = t.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return;
      if (isPasswordField(t)) return;
      const inp = t as HTMLInputElement;
      // Skip non-text-like input types and fields the user left empty.
      const skip = ["submit", "button", "reset", "file", "image", "range", "color", "checkbox", "radio", "hidden"];
      if (skip.includes(inp.type ?? "")) return;
      const value = inp.value?.trim();
      if (!value) return; // nothing was filled in
      const snippet = redactString(value.slice(0, 120));
      if (!snippet) return;
      post("form_fill", { value: snippet, field: buildSelector(t) });
    },
    { capture: true, passive: true }
  );

  // Scroll, debounced.
  let scrollTimer: number | null = null;
  let scrollY0 = window.scrollY;
  document.addEventListener(
    "scroll",
    () => {
      if (scrollTimer != null) return;
      scrollTimer = window.setTimeout(() => {
        const dy = window.scrollY - scrollY0;
        scrollY0 = window.scrollY;
        scrollTimer = null;
        if (Math.abs(dy) > 8) post("scroll", { y_delta: dy });
      }, 500);
    },
    { passive: true }
  );

  // ---- Control bar ----

  const BAR_ID = "scout-control-bar";
  const TOAST_ID = "scout-toast";
  const FRAME_ID = "scout-recording-frame";

  function isOurOwnUi(el: Element): boolean {
    return !!el.closest?.(`#${BAR_ID}, #${TOAST_ID}, #${FRAME_ID}`);
  }

  // The page might re-render and wipe our bar (Gmail, Notion, any SPA route
  // change). When that happens, ensureControlBar() needs to be called again.
  // We track whether the user is currently in a recording so the observer
  // knows whether to re-attach.
  let recordingActive = false;
  let barObserver: MutationObserver | null = null;

  function ensureControlBar(): HTMLElement {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.setAttribute("data-scout-ignore", "true");
    bar.style.cssText = `
      position: fixed; top: 16px; right: 16px;
      width: 280px; height: 44px;
      background: linear-gradient(180deg, rgba(33,33,33,0.78) 0%, rgba(0,0,0,0.78) 100%);
      backdrop-filter: blur(20px) saturate(160%);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      color: #FFE8C7;
      border: 1px solid rgba(182,128,57,0.30);
      border-radius: 6px;
      box-shadow: 0 1px 0 rgba(228,175,122,0.08) inset, 0 8px 30px rgba(0,0,0,0.45);
      display: flex; align-items: center;
      padding: 0 12px; gap: 10px;
      font: 500 13px/1 'Montserrat', system-ui, sans-serif;
      z-index: 2147483646; user-select: none;
      cursor: grab;
    `;
    bar.innerHTML = `
      <span data-scout-dot style="width:10px;height:10px;border-radius:50%;background:#DC2626;box-shadow:0 0 0 0 rgba(220,38,38,0.55);animation:scout-pulse 1.6s ease-in-out infinite;display:inline-block;flex-shrink:0;"></span>
      <span data-scout-time style="font-variant-numeric:tabular-nums;min-width:42px;color:#E4AF7A;font-weight:600;">00:00</span>
      <span data-scout-count style="font-size:10px;color:rgba(228,175,122,0.55);font-variant-numeric:tabular-nums;min-width:24px;text-align:right;">0</span>
      <span style="flex:1;color:#B68039;font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;text-align:center;">Scout</span>
      <span data-scout-mic aria-label="Microphone active" title="Voice narration is recording" style="font-size:12px;display:none;animation:scout-mic-pulse 2s ease-in-out infinite;" role="img">🎙</span>
      <button data-scout-pause aria-label="Pause" style="background:transparent;border:0;color:#FFE8C7;cursor:pointer;padding:6px;font-size:14px;">⏸</button>
      <button data-scout-stop aria-label="Stop" style="background:transparent;border:0;color:#DC2626;cursor:pointer;padding:6px;font-weight:700;font-size:14px;">■</button>
    `;
    if (!document.getElementById("scout-style")) {
      const st = document.createElement("style");
      st.id = "scout-style";
      st.textContent = `@keyframes scout-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(220,38,38,0.55)}50%{opacity:.45;box-shadow:0 0 0 6px rgba(220,38,38,0)}}@keyframes scout-mic-pulse{0%,100%{opacity:1}50%{opacity:0.5}}`;
      document.head.appendChild(st);
    }
    document.body.appendChild(bar);

    // Dragging.
    let dragOff: { x: number; y: number } | null = null;
    bar.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button")) return;
      const r = bar!.getBoundingClientRect();
      dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
      bar!.style.cursor = "grabbing";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragOff) return;
      bar!.style.left = `${e.clientX - dragOff.x}px`;
      bar!.style.top = `${e.clientY - dragOff.y}px`;
      bar!.style.right = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (dragOff) bar!.style.cursor = "grab";
      dragOff = null;
    });

    const updatePauseVisual = (paused: boolean) => {
      const dot = bar!.querySelector<HTMLElement>("[data-scout-dot]");
      const pauseBtn = bar!.querySelector<HTMLButtonElement>("[data-scout-pause]");
      if (dot) {
        dot.style.background = paused ? "rgba(182,128,57,0.55)" : "#DC2626";
        dot.style.animation = paused ? "none" : "scout-pulse 1.6s ease-in-out infinite";
      }
      if (pauseBtn) pauseBtn.textContent = paused ? "▶" : "⏸";
    };
    bar.querySelector("[data-scout-pause]")?.addEventListener("click", async () => {
      const isPaused = bar!.getAttribute("data-paused") === "true";
      const type = isPaused ? "popup:resume_recording" : "popup:pause_recording";
      await chrome.runtime.sendMessage({ type } satisfies RuntimeMessage).catch(() => {});
      bar!.setAttribute("data-paused", String(!isPaused));
      updatePauseVisual(!isPaused);
    });
    bar.querySelector("[data-scout-stop]")?.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "popup:stop_recording" } satisfies RuntimeMessage).catch(() => {});
    });

    // Keep timer ticking from the recording start time we stash here.
    const tick = () => {
      const start = Number(bar!.getAttribute("data-started") || "0");
      if (!start) return;
      const ms = Date.now() - start;
      const s = Math.floor(ms / 1000) % 60;
      const m = Math.floor(ms / 60000);
      const t = bar!.querySelector("[data-scout-time]");
      if (t) t.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };
    setInterval(tick, 500);
    return bar;
  }

  function removeControlBar(): void {
    document.getElementById(BAR_ID)?.remove();
    barObserver?.disconnect();
    barObserver = null;
  }

  // Liquid-glass border that wraps the entire viewport while a recording
  // is active. Four 6px strips at the edges (top/right/bottom/left) so the
  // page interior is untouched. pointer-events:none everywhere so it
  // doesn't intercept clicks. A traveling shimmer animates around the
  // perimeter to make the recording state unmistakable without being noisy.
  function ensureRecordingFrame(): HTMLElement {
    let frame = document.getElementById(FRAME_ID);
    if (frame) return frame;
    frame = document.createElement("div");
    frame.id = FRAME_ID;
    frame.setAttribute("data-scout-ignore", "true");
    frame.setAttribute("aria-hidden", "true");
    // Wrapper sits above the page; pointer-events:none means it can never
    // block a click. Each strip is positioned absolutely against the wrapper.
    frame.style.cssText = `
      position: fixed; inset: 0; pointer-events: none;
      z-index: 2147483645;
    `;
    const stripBase = `
      position: absolute; pointer-events: none;
      backdrop-filter: blur(8px) saturate(160%);
      -webkit-backdrop-filter: blur(8px) saturate(160%);
      box-shadow:
        inset 0 0 0 1px rgba(228, 175, 122, 0.40),
        inset 0 0 14px rgba(182, 128, 57, 0.25),
        0 0 18px rgba(182, 128, 57, 0.15);
      background:
        linear-gradient(90deg,
          rgba(228, 175, 122, 0.10) 0%,
          rgba(228, 175, 122, 0.30) 50%,
          rgba(228, 175, 122, 0.10) 100%);
      background-size: 200% 100%;
    `;
    const top = document.createElement("div");
    top.setAttribute("data-scout-ignore", "true");
    top.style.cssText = stripBase + `top: 0; left: 0; right: 0; height: 6px;
      animation: scout-frame-h 3.6s linear infinite;`;
    const bottom = document.createElement("div");
    bottom.setAttribute("data-scout-ignore", "true");
    bottom.style.cssText = stripBase + `bottom: 0; left: 0; right: 0; height: 6px;
      animation: scout-frame-h 3.6s linear infinite reverse;`;
    const left = document.createElement("div");
    left.setAttribute("data-scout-ignore", "true");
    left.style.cssText = stripBase + `top: 0; bottom: 0; left: 0; width: 6px;
      background-size: 100% 200%;
      animation: scout-frame-v 3.6s linear infinite;`;
    const right = document.createElement("div");
    right.setAttribute("data-scout-ignore", "true");
    right.style.cssText = stripBase + `top: 0; bottom: 0; right: 0; width: 6px;
      background-size: 100% 200%;
      animation: scout-frame-v 3.6s linear infinite reverse;`;
    frame.appendChild(top);
    frame.appendChild(bottom);
    frame.appendChild(left);
    frame.appendChild(right);
    if (!document.getElementById("scout-frame-style")) {
      const st = document.createElement("style");
      st.id = "scout-frame-style";
      st.textContent = `
        @keyframes scout-frame-h {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes scout-frame-v {
          0% { background-position: 0 200%; }
          100% { background-position: 0 -200%; }
        }
      `;
      document.head.appendChild(st);
    }
    document.body.appendChild(frame);
    return frame;
  }

  function removeRecordingFrame(): void {
    document.getElementById(FRAME_ID)?.remove();
  }

  // Watch the body for re-renders. If our bar gets removed and we're still
  // recording, re-create it. document.body itself may be replaced (Gmail
  // does this on inbox -> conversation transitions), so we observe at the
  // documentElement level and re-bind to body when it changes.
  function startBarObserver(): void {
    if (barObserver) return;
    let lastBody = document.body;
    barObserver = new MutationObserver(() => {
      if (!recordingActive) return;
      // Body was replaced wholesale.
      if (document.body !== lastBody) {
        lastBody = document.body;
      }
      if (!document.getElementById(BAR_ID) && document.body) {
        ensureControlBar();
      }
      // Same SPA-wipe handling for the frame.
      if (!document.getElementById(FRAME_ID) && document.body) {
        ensureRecordingFrame();
      }
    });
    barObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // ---- Coaching toast ----

  function showToast(ask: string): void {
    document.getElementById(TOAST_ID)?.remove();
    const box = document.createElement("div");
    box.id = TOAST_ID;
    box.setAttribute("data-scout-ignore", "true");
    box.style.cssText = `
      position: fixed; right: 24px; bottom: 24px;
      width: 320px; padding: 16px 18px;
      background: linear-gradient(180deg, rgba(33,33,33,0.92) 0%, rgba(21,21,21,0.92) 100%);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      color: #FFE8C7;
      border: 1px solid rgba(182,128,57,0.35);
      border-radius: 8px;
      box-shadow: 0 1px 0 rgba(228,175,122,0.10) inset, 0 12px 40px rgba(0,0,0,0.55);
      font: 14px/1.5 'Montserrat', system-ui, sans-serif;
      z-index: 2147483647;
      transform: translateY(20px); opacity: 0;
      transition: transform .3s ease-out, opacity .3s ease-out;
      pointer-events: auto;
    `;
    box.innerHTML = `
      <div style="font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:0.18em;color:#B68039;margin-bottom:8px;text-transform:uppercase;">Scout · Coach</div>
      <div style="margin-bottom:12px;color:#FFE8C7;">${escapeHtml(ask)}</div>
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <input data-scout-text-reply type="text" placeholder="Type your reply…"
          style="flex:1;background:rgba(0,0,0,0.45);border:1px solid rgba(182,128,57,0.30);border-radius:4px;color:#FFE8C7;font-size:12px;padding:6px 10px;font-family:inherit;outline:none;" />
        <button data-scout-send style="background:linear-gradient(180deg,#C68A41 0%,#A77131 100%);border:1px solid rgba(228,175,122,0.55);color:#1a0e02;cursor:pointer;font-size:12px;padding:6px 10px;border-radius:4px;font-family:inherit;font-weight:700;">→</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button data-scout-skip style="background:transparent;border:0;color:rgba(255,232,199,0.45);cursor:pointer;font-size:11px;padding:4px 8px;font-family:inherit;">Skip</button>
        <button data-scout-reply style="background:transparent;border:1px solid rgba(182,128,57,0.25);color:#B68039;cursor:pointer;font-size:11px;padding:4px 10px;border-radius:4px;font-family:inherit;">🎙 Voice</button>
      </div>
    `;
    document.body.appendChild(box);
    requestAnimationFrame(() => {
      box.style.transform = "translateY(0)";
      box.style.opacity = "1";
    });
    const dismiss = () => {
      box.style.transform = "translateY(20px)";
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 300);
    };
    const sendTextReply = () => {
      const inp = box.querySelector<HTMLInputElement>("[data-scout-text-reply]");
      const text = inp?.value.trim();
      if (!text) return;
      post("coach_reply", { reply_text: text, question: ask });
      dismiss();
    };
    box.querySelector<HTMLInputElement>("[data-scout-text-reply]")?.addEventListener("keydown", (e) => {
      e.stopPropagation(); // prevent our own keydown listener from capturing this
      if (e.key === "Enter") { e.preventDefault(); sendTextReply(); }
    });
    box.querySelector("[data-scout-send]")?.addEventListener("click", sendTextReply);
    box.querySelector("[data-scout-skip]")?.addEventListener("click", dismiss);
    box.querySelector("[data-scout-reply]")?.addEventListener("click", () => {
      const replyBtn = box.querySelector<HTMLButtonElement>("[data-scout-reply]");
      if (replyBtn) {
        replyBtn.textContent = "🎙 Listening…";
        replyBtn.style.background = "linear-gradient(180deg,#DC2626 0%,#9B1C1C 100%)";
        replyBtn.style.border = "1px solid rgba(220,38,38,0.55)";
        replyBtn.style.color = "#fff";
        replyBtn.disabled = true;
      }
      box.style.borderColor = "rgba(220,38,38,0.55)";
      setTimeout(dismiss, 4000);
    });
    setTimeout(dismiss, 25000);
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }

  function sanitizeKey(k: string): string {
    if (k.length > 1) return k; // named key (Enter, Tab, …)
    return k;
  }

  // ---- Listen for service worker prompts ----

  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    if (msg.type === "content:update_count") {
      const bar = document.getElementById(BAR_ID);
      if (bar) {
        const el = bar.querySelector<HTMLElement>("[data-scout-count]");
        if (el) el.textContent = String(msg.event_count);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "content:show_toast") {
      showToast(msg.ask);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "content:show_control_bar") {
      recordingActive = true;
      const bar = ensureControlBar();
      ensureRecordingFrame();
      startBarObserver();
      // Ask the worker for the start time and mic state.
      chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage, (resp) => {
        const state = resp?.state;
        if (!state) return;
        bar.setAttribute("data-started", String(state.started_at));
        // Show mic indicator when mic is enabled and not denied by browser.
        const micEl = bar.querySelector<HTMLElement>("[data-scout-mic]");
        if (micEl) {
          const micActive = (state.mic_enabled ?? true) && (state.audio_supported ?? true);
          micEl.style.display = micActive ? "inline" : "none";
        }
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "content:hide_control_bar") {
      recordingActive = false;
      removeControlBar();
      removeRecordingFrame();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // On load, if a session already exists (page reloaded mid-recording), show the bar.
  chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage, (resp) => {
    const state = resp?.state;
    if (state) {
      recordingActive = true;
      const bar = ensureControlBar();
      ensureRecordingFrame();
      bar.setAttribute("data-started", String(state.started_at));
      startBarObserver();
      const micEl = bar.querySelector<HTMLElement>("[data-scout-mic]");
      if (micEl) {
        const micActive = (state.mic_enabled ?? true) && (state.audio_supported ?? true);
        micEl.style.display = micActive ? "inline" : "none";
      }
    }
  });
})();
