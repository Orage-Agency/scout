// Zip apps/extension/dist into release/scout-vX.Y.Z.zip ready for upload to
// the Chrome Web Store. Reads the version from apps/extension/src/manifest.json
// so the artifact filename and the manifest stay in sync.

import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { exit } from "node:process";
import { readdirSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const distDir = resolve(repo, "apps/extension/dist");
const releaseDir = resolve(repo, "release");
const manifestPath = resolve(repo, "apps/extension/src/manifest.json");

if (!existsSync(distDir)) {
  console.error(`dist not found at ${distDir} — run \`pnpm build\` first.`);
  exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;
if (!version) {
  console.error("manifest.json has no version field");
  exit(1);
}

if (!existsSync(releaseDir)) mkdirSync(releaseDir, { recursive: true });
const zipPath = resolve(releaseDir, `scout-v${version}.zip`);

// Use Node's built-in stream + a tiny zip implementation. We rely on the
// `archiver` package via dynamic import; if not installed, fall back to
// PowerShell's Compress-Archive on Windows.
let usedArchiver = false;
try {
  const { default: archiver } = await import("archiver");
  await new Promise((resolveZip, rejectZip) => {
    const out = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    out.on("close", resolveZip);
    archive.on("error", rejectZip);
    archive.pipe(out);
    archive.directory(distDir, false);
    archive.finalize();
  });
  usedArchiver = true;
} catch (err) {
  console.warn("archiver not available, falling back to PowerShell Compress-Archive:", err.message);
  const { execSync } = await import("node:child_process");
  // Compress-Archive doesn't strip the parent directory; we point it at the
  // contents of dist using a wildcard.
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit" }
  );
}

const stat = statSync(zipPath);
console.log(`packaged ${relative(repo, zipPath)} (${(stat.size / 1024).toFixed(1)} KB${usedArchiver ? "" : ", via Compress-Archive"})`);
