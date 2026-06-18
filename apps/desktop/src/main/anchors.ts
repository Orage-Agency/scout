import { Region, screen } from "@nut-tree-fork/nut-js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logLine } from "./logger";

const ANCHOR_RADIUS = 40;
const FIND_CONFIDENCE = 0.85;

export const ANCHORS_SUBDIR = "anchors";

screen.config.confidence = FIND_CONFIDENCE;

export async function captureAnchor(
  recordingDir: string,
  eventId: string,
  x: number,
  y: number
): Promise<string | null> {
  const dir = path.join(recordingDir, ANCHORS_SUBDIR);
  try {
    await fs.mkdir(dir, { recursive: true });
    const size = ANCHOR_RADIUS * 2;
    const left = Math.max(0, x - ANCHOR_RADIUS);
    const top = Math.max(0, y - ANCHOR_RADIUS);
    const region = new Region(left, top, size, size);
    await screen.captureRegion(eventId, region, undefined, dir);
    return path.posix.join(ANCHORS_SUBDIR, `${eventId}.png`);
  } catch (err) {
    await logLine(`[anchor] capture failed eventId=${eventId} err=${String(err)}`);
    return null;
  }
}

export async function findAnchorCenter(
  recordingDir: string,
  anchorRelPath: string
): Promise<{ x: number; y: number } | null> {
  const fullPath = path.isAbsolute(anchorRelPath)
    ? anchorRelPath
    : path.join(recordingDir, anchorRelPath);
  try {
    await fs.access(fullPath);
  } catch {
    return null;
  }
  try {
    const region = await screen.find(fullPath);
    return {
      x: Math.round(region.left + region.width / 2),
      y: Math.round(region.top + region.height / 2),
    };
  } catch {
    return null;
  }
}
