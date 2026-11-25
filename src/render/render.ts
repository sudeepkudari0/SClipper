import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { AudioAnalysis } from "../analysis/audio.js";
import type { MotionAnalysis } from "../analysis/motion.js";
import type { WindowSelectionResult } from "../analysis/window.js";
import type { CopyPlan } from "../copy/fallback.js";
import { detectVideoEncoder, type VideoEncoder } from "../core/encoder.js";
import { runFfmpeg } from "../core/ffmpeg.js";
import { resolveWatermarkPath, type CampaignProfile } from "../core/profile.js";
import type { SourceProbe } from "../core/probe.js";
import { writeJson } from "../core/workspace.js";
import { generateAssContent } from "./ass.js";
import { buildFfmpegRenderArgs } from "./filtergraph.js";

export interface RenderManifest {
  clipId: string;
  variant: number;
  preset: "clean" | "punchy";
  hookText: string;
  outputPath: string;
  encoder: VideoEncoder;
  reframeMode: string;
  windowStartSec: number;
  windowEndSec: number;
  watermarkPath: string | null;
  watermarkPosition: string | null;
  slowmo: boolean;
  zoom: boolean;
  counter: boolean;
  renderedAt: string;
}

export async function resolveFontName(
  fontFile: string | null,
): Promise<string> {
  if (fontFile) {
    if (!fs.existsSync(fontFile)) {
      throw new Error(`Configured fontFile does not exist: ${fontFile}`);
    }
    return path.basename(fontFile, path.extname(fontFile));
  }

  const res = await execa("fc-match", ["sans:bold", "-f", "%{family}"], {
    reject: false,
  });
  if (res.exitCode === 0 && res.stdout.trim()) {
    return res.stdout.trim().split(",")[0].trim();
  }
  throw new Error(
    "Could not resolve a bold sans-serif font via fc-match. Install a sans-serif font (e.g. noto-fonts or liberation-fonts) or set text.hook.fontFile in profile.yaml.",
  );
}

export async function renderClipVariants(opts: {
  clipDir: string;
  campaignDir: string;
  probe: SourceProbe;
  audio: AudioAnalysis;
  motion: MotionAnalysis;
  windowSel: WindowSelectionResult;
  copy: CopyPlan;
  profile: CampaignProfile;
  variants: number;
  reframeOverride?: "auto" | "center" | "motion" | "none";
  slowmoOverride?: boolean;
  zoomOverride?: boolean;
  counterOverride?: boolean;
  onProgress?: (variant: number, frac: number) => void;
}): Promise<RenderManifest[]> {
  const {
    clipDir,
    campaignDir,
    probe,
    audio,
    motion,
    windowSel,
    copy,
    profile,
    variants,
    reframeOverride,
    slowmoOverride,
    zoomOverride,
    counterOverride,
    onProgress,
  } = opts;

  const encoder = await detectVideoEncoder();
  const fontName = await resolveFontName(profile.text.hook.fontFile);
  const wmPath = resolveWatermarkPath(profile, campaignDir);
  if (profile.watermark.file && (!wmPath || !fs.existsSync(wmPath))) {
    throw new Error(
      `Watermark file not found: ${wmPath ?? profile.watermark.file}. Place it there or set watermark.file: null in profile.yaml.`,
    );
  }

  const reframeMode = reframeOverride ?? profile.reframe.mode;
  const enableSlowmo = slowmoOverride ?? profile.effects.slowmo.enabled;
  const enableZoom = zoomOverride ?? profile.effects.zoom.enabled;
  const enableCounter = counterOverride ?? profile.text.counter.enabled;

  if (enableCounter && audio.hitConfidence < profile.text.counter.minConfidence) {
    console.warn(
      `Skipping shot counter: hitConfidence (${audio.hitConfidence}) < minConfidence (${profile.text.counter.minConfidence})`,
    );
  }

  const dur = Math.max(0.5, windowSel.end - windowSel.start);
  const peakRel = Math.max(
    0.2,
    Math.min(dur - 0.2, audio.peakTimeSec - windowSel.start),
  );

  const manifests: RenderManifest[] = [];
  for (let v = 1; v <= variants; v++) {
    const preset: "clean" | "punchy" = v % 2 === 1 ? "clean" : "punchy";
    const hookText = copy.hooks[(v - 1) % copy.hooks.length] ?? "";
    const assPath = path.join(clipDir, `overlay_v${v}.ass`);
    const outPath = path.join(clipDir, `render_v${v}.mp4`);
    const manifestPath = path.join(clipDir, `render_v${v}.json`);

    const assContent = generateAssContent({
      width: profile.output.width,
      height: profile.output.height,
      durationSec: dur,
      fontName,
      hookText,
      profile,
      preset,
      hits: audio.estimatedHits,
      hitConfidence: audio.hitConfidence,
      windowStartSec: windowSel.start,
      enableCounter,
    });
    fs.writeFileSync(assPath, assContent, "utf8");

    const ffmpegArgs = buildFfmpegRenderArgs({
      sourcePath: probe.filePath,
      outPath,
      assPath,
      watermarkPath: wmPath,
      profile,
      encoder,
      srcWidth: probe.effectiveWidth,
      srcHeight: probe.effectiveHeight,
      hasAudio: probe.hasAudio,
      startSec: windowSel.start,
      endSec: windowSel.end,
      reframeMode,
      centroidXPerFrame: motion.centroidXPerFrame,
      motionFps: motion.fps,
      peakTimeRelSec: peakRel,
      enableSlowmo,
      enableZoom,
    });

    await runFfmpeg(ffmpegArgs, {
      totalDurationSec: dur,
      onProgress: (frac) => onProgress?.(v, frac),
    });

    const manifest: RenderManifest = {
      clipId: probe.clipId,
      variant: v,
      preset,
      hookText,
      outputPath: outPath,
      encoder,
      reframeMode,
      windowStartSec: windowSel.start,
      windowEndSec: windowSel.end,
      watermarkPath: wmPath,
      watermarkPosition: wmPath ? profile.watermark.position : null,
      slowmo: enableSlowmo,
      zoom: enableZoom,
      counter:
        enableCounter && audio.hitConfidence >= profile.text.counter.minConfidence,
      renderedAt: new Date().toISOString(),
    };
    writeJson(manifestPath, manifest);
    manifests.push(manifest);
  }

  return manifests;
}

