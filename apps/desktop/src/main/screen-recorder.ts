import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logLine } from "./logger";

let ffmpegPath: string | null = null;

function resolveFfmpeg(): string {
  if (ffmpegPath) return ffmpegPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("ffmpeg-static") as string | { default: string } | null;
    if (typeof mod === "string") ffmpegPath = mod;
    else if (mod && typeof mod.default === "string") ffmpegPath = mod.default;
  } catch {
    // fall through
  }
  if (!ffmpegPath) ffmpegPath = "ffmpeg";
  return ffmpegPath;
}

interface ActiveRecording {
  recording_id: string;
  process: ChildProcess;
  output_path: string;
  started_at_ms: number;
}

let active: ActiveRecording | null = null;

export function isRecordingScreen(): boolean {
  return active !== null;
}

export function getActiveScreenPath(): string | null {
  return active?.output_path ?? null;
}

function platformArgs(outputPath: string): string[] | null {
  const common = ["-y", "-loglevel", "warning", "-framerate", "15"];
  const encode = [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-tune", "zerolatency",
    "-crf", "28",
    outputPath,
  ];
  switch (process.platform) {
    case "win32":
      return [...common, "-f", "gdigrab", "-i", "desktop", ...encode];
    case "darwin":
      return [
        ...common,
        "-f", "avfoundation",
        "-i", process.env.SCOUT_AVF_INPUT ?? "1:none",
        ...encode,
      ];
    case "linux":
      return [
        ...common,
        "-f", "x11grab",
        "-i", process.env.DISPLAY ?? ":0.0",
        ...encode,
      ];
    default:
      return null;
  }
}

export async function startScreenRecording(recordingId: string): Promise<string | null> {
  if (active) {
    await logLine(`[screen] already recording; skipping start for ${recordingId}`);
    return active.output_path;
  }
  const dir = path.join(app.getPath("userData"), "recordings", recordingId);
  await fs.mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, "video.mp4");
  const args = platformArgs(outputPath);
  if (!args) {
    await logLine(`[screen] unsupported platform ${process.platform}`);
    return null;
  }
  const bin = resolveFfmpeg();
  await logLine(`[screen] start bin=${bin}`);
  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
  } catch (err) {
    await logLine(`[screen] spawn failed ${String(err)}`);
    return null;
  }
  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (line) void logLine(`[screen.ffmpeg] ${line}`);
  });
  proc.on("exit", (code, signal) => {
    void logLine(`[screen] exit code=${code} signal=${signal}`);
    if (active && active.process === proc) active = null;
  });
  proc.on("error", (err) => {
    void logLine(`[screen] error ${String(err)}`);
    if (active && active.process === proc) active = null;
  });
  active = {
    recording_id: recordingId,
    process: proc,
    output_path: outputPath,
    started_at_ms: Date.now(),
  };
  return outputPath;
}

export async function stopScreenRecording(): Promise<string | null> {
  if (!active) return null;
  const { process: proc, output_path } = active;
  await logLine(`[screen] stop requested ${active.recording_id}`);
  try {
    proc.stdin?.write("q");
    proc.stdin?.end();
  } catch {
    // ignore
  }
  const exitedOk = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(false);
    }, 5000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  active = null;
  await logLine(`[screen] stopped graceful=${exitedOk} path=${output_path}`);
  try {
    const stat = await fs.stat(output_path);
    if (stat.size === 0) {
      await logLine(`[screen] warning: video is empty`);
      return null;
    }
    return output_path;
  } catch {
    return null;
  }
}
