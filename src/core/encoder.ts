import { execa } from "execa";
import { getEncoderCachePath, readJson, writeJson } from "./workspace.js";

export type VideoEncoder = "h264_nvenc" | "libx264";

interface EncoderCache {
  encoder: VideoEncoder;
  checkedAt: string;
}

export async function detectVideoEncoder(
  force = false,
  cachePath = getEncoderCachePath(),
): Promise<VideoEncoder> {
  if (!force) {
    const cached = readJson<EncoderCache>(cachePath);
    if (cached && (cached.encoder === "h264_nvenc" || cached.encoder === "libx264")) {
      return cached.encoder;
    }
  }

  let encoder: VideoEncoder = "libx264";
  try {
    const res = await execa(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=1",
        "-c:v",
        "h264_nvenc",
        "-f",
        "null",
        "-",
      ],
      { reject: false, timeout: 10000 },
    );
    if (res.exitCode === 0) {
      encoder = "h264_nvenc";
    }
  } catch {
    encoder = "libx264";
  }

  writeJson(cachePath, {
    encoder,
    checkedAt: new Date().toISOString(),
  } satisfies EncoderCache);

  return encoder;
}

