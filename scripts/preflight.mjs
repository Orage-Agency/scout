#!/usr/bin/env node
// Pre-release preflight: typecheck + env check + smoke test.
// Run via: pnpm preflight
// Exits non-zero on first failure.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"); // Windows compat

function run(label, cmd) {
  console.log(`\n▶ ${label}`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: root });
    console.log(`✓ ${label}`);
  } catch {
    console.error(`✗ ${label} failed`);
    process.exit(1);
  }
}

// ── 1. TypeScript ──────────────────────────────────────────────────────────
run("TypeScript check", "pnpm typecheck");

// ── 2. Required env vars ───────────────────────────────────────────────────
console.log("\n▶ Environment check");
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) {
  console.error("✗ .env not found — copy .env.example and fill it in");
  process.exit(1);
}

const envContent = readFileSync(envPath, "utf8");
const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const missing = [];
for (const key of required) {
  const m = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!m || !m[1].trim() || m[1].includes("YOUR_")) missing.push(key);
}
if (missing.length) {
  console.error(`✗ Missing or placeholder env vars: ${missing.join(", ")}`);
  console.error("  Fill them in .env before running preflight.");
  process.exit(1);
}
console.log("✓ Required env vars present");

// ── 3. Build ───────────────────────────────────────────────────────────────
run("Extension build", "pnpm build");

// ── 4. Smoke test ──────────────────────────────────────────────────────────
run("Smoke test", "pnpm test:smoke");

console.log("\n✓ Preflight passed — ready to tag and release.");
