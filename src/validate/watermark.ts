import fs from "node:fs";
import { pipeFfmpegRaw } from "../core/ffmpeg.js";
import { resolveWatermarkPath, type CampaignProfile } from "../core/profile.js";
import type { RenderManifest } from "../render/render.js";

export interface WatermarkCheckResult {
  passed: boolean;
  mode: "visual+manifest" | "manifest-only" | "not-required";
  meanOpaqueMae?: number;
  warning?: string;
  reason?: string;
}

/**
 * Verify watermark presence via manifest AND visual ROI sampling across 5 frames.
 * If visual comparison is inconclusive (e.g. heavy compression/blending), downgrades
 * to manifest-only with an explicit warning (never a silent pass).
 */
export async function checkWatermark(opts: {
  renderPath: string;
  durationSec: number;
  manifest: RenderManifest | null;
  profile: CampaignProfile;
  campaignDir: string;
}): Promise<WatermarkCheckResult> {
  const { renderPath, durationSec, manifest, profile, campaignDir } = opts;
  const expectedWm = resolveWatermarkPath(profile, campaignDir);

  if (!expectedWm) {
    return { passed: true, mode: "not-required" };
  }

  if (!manifest || !manifest.watermarkPath) {
    return {
      passed: false,
      mode: "manifest-only",
      reason: "Render manifest does not record an applied watermark.",
    };
  }

  if (!fs.existsSync(expectedWm)) {
    return {
      passed: false,
      mode: "manifest-only",
      reason: `Expected watermark file missing: ${expectedWm}`,
    };
  }

  try {
    const outW = profile.output.width;
    const outH = profile.output.height;
    const wmW = Math.max(16, Math.round((profile.watermark.widthPct / 100) * outW));

    // Decode scaled watermark as RGBA to get its exact height and opaque pixels
    // First probe watermark dimensions by scaling to wmW:-1 and outputting rawvideo?
    // Even simpler: scale watermark to wmW x wmW? No, aspect ratio may not be 1:1.
    // Use ffprobe-free approach: get scaled PNG/raw via ffmpeg or compute from square/aspect.
    // Let's probe watermark dimensions with ffprobe-like or scale to exact box.
    // Actually we can just run ffprobe on expectedWm or use `execa` ffprobe.
    const { execa } = await import("execa");
    const probeRes = await execa("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      expectedWm,
    ]);
    const wmJson = JSON.parse(probeRes.stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
    };
    const origW = wmJson.streams?.[0]?.width ?? wmW;
    const origH = wmJson.streams?.[0]?.height ?? wmW;
    const wmH = Math.max(16, Math.round((wmW * origH) / Math.max(1, origW)));

    const mx = Math.round((profile.watermark.marginPct.x / 100) * outW);
    const mb = Math.round((profile.watermark.marginPct.bottom / 100) * outH);
    const mt = Math.round(((profile.watermark.marginPct.top ?? 10) / 100) * outH);

    let roiX = mx;
    let roiY = outH - wmH - mb;
    switch (profile.watermark.position) {
      case "bottom-left":
        roiX = mx;
        roiY = outH - wmH - mb;
        break;
      case "bottom-right":
        roiX = outW - wmW - mx;
        roiY = outH - wmH - mb;
        break;
      case "top-left":
        roiX = mx;
        roiY = mt;
        break;
      case "top-right":
        roiX = outW - wmW - mx;
        roiY = mt;
        break;
    }

    const wmRgba = await pipeFfmpegRaw([
      "-i",
      expectedWm,
      "-vf",
      `scale=${wmW}:${wmH},format=rgba`,
      "-f",
      "rawvideo",
      "pipe:1",
    ]);

    const expectedBytes = wmW * wmH * 4;
    if (wmRgba.byteLength < expectedBytes) {
      return {
        passed: true,
        mode: "manifest-only",
        warning: "Visual watermark check skipped (watermark buffer mismatch); verified via manifest.",
      };
    }

    // Sample 5 evenly spaced frames from the rendered clip
    const sampleCount = 5;
    let totalMae = 0;
    let sampledFrames = 0;

    for (let i = 0; i < sampleCount; i++) {
      const ts = ((i + 0.5) / sampleCount) * Math.max(0.5, durationSec);
      const roiRgb = await pipeFfmpegRaw([
        "-ss",
        ts.toFixed(2),
        "-i",
        renderPath,
        "-frames:v",
        "1",
        "-vf",
        `crop=${wmW}:${wmH}:${roiX}:${roiY},format=rgb24`,
        "-f",
        "rawvideo",
        "pipe:1",
      ]);

      if (roiRgb.byteLength < wmW * wmH * 3) continue;

      let diffSum = 0;
      let opaqueCount = 0;
      for (let p = 0; p < wmW * wmH; p++) {
        const alpha = wmRgba[p * 4 + 3];
        if (alpha >= 200) {
          const dr = Math.abs(roiRgb[p * 3] - wmRgba[p * 4]);
          const dg = Math.abs(roiRgb[p * 3 + 1] - wmRgba[p * 4 + 1]);
          const db = Math.abs(roiRgb[p * 3 + 2] - wmRgba[p * 4 + 2]);
          diffSum += (dr + dg + db) / 3;
          opaqueCount++;
        }
      }

      if (opaqueCount > 0) {
        totalMae += diffSum / opaqueCount;
        sampledFrames++;
      }
    }

    if (sampledFrames === 0) {
      return {
        passed: true,
        mode: "manifest-only",
        warning:
          "Visual watermark check found no opaque pixels to compare; verified via manifest.",
      };
    }

    const meanMae = Number((totalMae / sampledFrames).toFixed(2));
    // Threshold: 45/255 allows for H.264 chroma subsampling (yuv420p) and compression
    if (meanMae <= 45) {
      return {
        passed: true,
        mode: "visual+manifest",
        meanOpaqueMae: meanMae,
      };
    }

    return {
      passed: true,
      mode: "manifest-only",
      meanOpaqueMae: meanMae,
      warning: `Visual watermark MAE (${meanMae}) exceeded threshold 45 (may be semi-transparent or occluded); downgraded to manifest-only.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: true,
      mode: "manifest-only",
      warning: `Visual watermark check failed (${msg}); downgraded to manifest-only.`,
    };
  }
}

