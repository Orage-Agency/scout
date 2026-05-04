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

  function isOurOwnUi(el: Element): boolean {
    return !!el.closest?.(`#${BAR_ID}, #${TOAST_ID}`);
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
      background: rgba(15,23,42,0.92);
      color: #F1F5F9;
      border: 1px solid #334155;
      border-radius: 0;
      display: flex; align-items: center;
      padding: 0 12px; gap: 10px;
      font: 500 13px/1 'Inter', system-ui, sans-serif;
      z-index: 2147483646; user-select: none;
      cursor: grab;
    `;
    bar.innerHTML = `
      <span data-scout-dot style="width:10px;height:10px;border-radius:50%;background:#DC2626;animation:scout-pulse 1.4s ease-in-out infinite;display:inline-block;"></span>
      <span data-scout-time style="font-variant-numeric: tabular-nums; min-width:42px;">00:00</span>
      <span style="flex:1;color:#94A3B8;font-size:11px;">Recording</span>
      <button data-scout-pause aria-label="Pause" style="background:transparent;border:0;color:#F1F5F9;cursor:pointer;padding:6px;">⏸</button>
      <button data-scout-stop aria-label="Stop" style="background:transparent;border:0;color:#DC2626;cursor:pointer;padding:6px;font-weight:700;">■</button>
    `;
    if (!document.getElementById("scout-style")) {
      const st = document.createElement("style");
      st.id = "scout-style";
      st.textContent = `@keyframes scout-pulse{0%,100%{opacity:1}50%{opacity:.35}}`;
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

    bar.querySelector("[data-scout-pause]")?.addEventListener("click", async () => {
      // Toggle pause/resume.
      const isPaused = bar!.getAttribute("data-paused") === "true";
      const type = isPaused ? "popup:resume_recording" : "popup:pause_recording";
      await chrome.runtime.sendMessage({ type } satisfies RuntimeMessage).catch(() => {});
      bar!.setAttribute("data-paused", String(!isPaused));
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
      width: 320px; padding: 16px;
      background: #1E293B;
      color: #F1F5F9;
      border: 1px solid #334155;
      border-radius: 6px;
      font: 14px/1.45 'Inter', system-ui, sans-serif;
      z-index: 2147483647;
      transform: translateY(20px); opacity: 0;
      transition: transform .3s ease-out, opacity .3s ease-out;
      pointer-events: auto;
    `;
    box.innerHTML = `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#94A3B8;margin-bottom:6px;">Scout</div>
      <div style="margin-bottom:12px;">${escapeHtml(ask)}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button data-scout-skip style="background:transparent;border:0;color:#94A3B8;cursor:pointer;font-size:12px;padding:6px 10px;">Skip</button>
        <button data-scout-reply style="background:#DC2626;border:0;color:#F1F5F9;cursor:pointer;font-size:12px;padding:6px 10px;border-radius:4px;">Reply by voice</button>
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
    box.querySelector("[data-scout-skip]")?.addEventListener("click", dismiss);
    box.querySelector("[data-scout-reply]")?.addEventListener("click", () => {
      // Mic is already capturing; we just acknowledge and dismiss.
      box.style.borderColor = "#DC2626";
      setTimeout(dismiss, 1500);
    });
    setTimeout(dismiss, 20000);
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
    if (msg.type === "content:show_toast") {
      showToast(msg.ask);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "content:show_control_bar") {
      recordingActive = true;
      const bar = ensureControlBar();
      startBarObserver();
      // Ask the worker for the start time so the timer is correct.
      chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage, (resp) => {
        const started = resp?.state?.started_at;
        if (started) bar.setAttribute("data-started", String(resp.state.started_at));
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "content:hide_control_bar") {
      recordingActive = false;
      removeControlBar();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // On load, if a session already exists (page reloaded mid-recording), show the bar.
  chrome.runtime.sendMessage({ type: "popup:get_state" } satisfies RuntimeMessage, (resp) => {
    if (resp?.state) {
      recordingActive = true;
      const bar = ensureControlBar();
      bar.setAttribute("data-started", String(resp.state.started_at));
      startBarObserver();
    }
  });
})();
