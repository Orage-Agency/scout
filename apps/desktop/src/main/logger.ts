import { promises as fs } from "node:fs";
import * as path from "node:path";
import { app } from "electron";

let logFilePath: string | null = null;

export async function initLogger(): Promise<string> {
  const dir = path.join(app.getPath("userData"), "logs");
  await fs.mkdir(dir, { recursive: true });
  logFilePath = path.join(dir, `scout-${Date.now()}.log`);
  await fs.writeFile(
    logFilePath,
    `[scout] log opened at ${new Date().toISOString()}\n`
  );
  return logFilePath;
}

export async function logLine(line: string): Promise<void> {
  if (!logFilePath) return;
  const text = line.endsWith("\n") ? line : line + "\n";
  await fs.appendFile(logFilePath, `[${new Date().toISOString()}] ${text}`);
}

export function getLogPath(): string | null {
  return logFilePath;
}
