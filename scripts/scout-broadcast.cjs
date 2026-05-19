#!/usr/bin/env node
"use strict";
// Reads a Claude Code hook payload from stdin, broadcasts it to the
// Supabase Realtime channel "scout-code" so the Scout extension can
// display a live feed of every tool call.
const { createClient } = require(
  "C:/Users/USER/Downloads/scout/node_modules/.pnpm/@supabase+supabase-js@2.105.1/node_modules/@supabase/supabase-js/dist/index.cjs"
);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  process.exit(0); // silent — no creds configured yet
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const { tool_name, tool_input, tool_response, hook_event_name } = payload;
  const event = hook_event_name || (tool_response !== undefined ? "PostToolUse" : "PreToolUse");

  // Summarise large inputs so the broadcast stays small
  const summarise = (obj) => {
    if (!obj) return null;
    const s = JSON.stringify(obj);
    return s.length > 400 ? s.slice(0, 400) + "…" : obj;
  };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const channel = supabase.channel("scout-code");

  await new Promise((resolve) => {
    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      channel.send({
        type: "broadcast",
        event: "tool_call",
        payload: {
          ts: Date.now(),
          hook: event,
          tool: tool_name,
          input: summarise(tool_input),
          response: event === "PostToolUse" ? summarise(tool_response) : undefined,
        },
      }).then(() => {
        supabase.removeChannel(channel);
        resolve();
      }).catch(() => resolve());
    });
  });

  process.exit(0);
});
