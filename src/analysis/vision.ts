import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "../core/ffmpeg.js";
import type { LLMProvider } from "../llm/provider.js";
import { buildVisionPrompt } from "../llm/prompts.js";

export async function describeFramesWithVision(
  videoPath: string,
  durationSec: number,
  llm: LLMProvider,
  frameCount = 4,
): Promise<string | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-vision-"));
  try {
    const count = Math.max(2, Math.min(4, frameCount));
    const dataUrls: string[] = [];
    for (let i = 0; i < count; i++) {
      const ts = ((i + 0.5) / count) * Math.max(0.5, durationSec);
      const outPath = path.join(tmpDir, `frame_${i}.jpg`);
      await runFfmpeg([
        "-y",
        "-ss",
        ts.toFixed(2),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease",
        outPath,
      ]);
      if (fs.existsSync(outPath)) {
        const b64 = fs.readFileSync(outPath).toString("base64");
        dataUrls.push(`data:image/jpeg;base64,${b64}`);
      }
    }

    if (dataUrls.length === 0) return null;
    return await llm.vision("vision", buildVisionPrompt(), dataUrls);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Vision analysis unavailable (skipping): ${msg}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

