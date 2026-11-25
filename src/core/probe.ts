import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";

export interface SourceProbe {
  clipId: string;
  filePath: string;
  fileName: string;
  durationSec: number;
  width: number;
  height: number;
  effectiveWidth: number;
  effectiveHeight: number;
  fps: number;
  rotation: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  probedAt: string;
}

export function slugifyFilename(fileName: string): string {
  const base = path.basename(fileName, path.extname(fileName));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "clip";
}

export function makeStableClipId(filePath: string): string {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);
  const hash = crypto
    .createHash("sha256")
    .update(`${abs}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
    .digest("hex")
    .slice(0, 8);
  return `${slugifyFilename(filePath)}-${hash}`;
}

function parseFps(rateStr?: string): number {
  if (!rateStr) return 30;
  const parts = rateStr.split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den > 0 && Number.isFinite(num)) return Math.round((num / den) * 100) / 100;
  }
  const n = Number(rateStr);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function probeVideo(filePath: string): Promise<SourceProbe> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Source file does not exist: ${abs}`);
  }
  const stat = fs.statSync(abs);
  const { stdout } = await execa("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    abs,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      tags?: Record<string, string>;
      side_data_list?: Array<{ rotation?: number }>;
    }>;
  };

  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video || !video.width || !video.height) {
    throw new Error(`No video stream found in ${abs}`);
  }

  let rotation = 0;
  if (video.tags?.rotate) {
    rotation = Number(video.tags.rotate) || 0;
  } else if (video.side_data_list) {
    for (const sd of video.side_data_list) {
      if (typeof sd.rotation === "number") {
        rotation = sd.rotation;
        break;
      }
    }
  }
  const normRot = ((rotation % 360) + 360) % 360;
  const swapped = normRot === 90 || normRot === 270;

  const durationSec = Number(data.format?.duration ?? 0);
  const fps = parseFps(video.avg_frame_rate || video.r_frame_rate);

  return {
    clipId: makeStableClipId(abs),
    filePath: abs,
    fileName: path.basename(abs),
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: video.width,
    height: video.height,
    effectiveWidth: swapped ? video.height : video.width,
    effectiveHeight: swapped ? video.width : video.height,
    fps,
    rotation,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sizeBytes: stat.size,
    probedAt: new Date().toISOString(),
  };
}

