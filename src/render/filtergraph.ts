import type { CampaignProfile } from "../core/profile.js";
import type { VideoEncoder } from "../core/encoder.js";
import { buildReframeFilter } from "./reframe.js";

export interface FiltergraphInput {
  sourcePath: string;
  outPath: string;
  assPath: string | null;
  watermarkPath: string | null;
  profile: CampaignProfile;
  encoder: VideoEncoder;
  srcWidth: number;
  srcHeight: number;
  hasAudio: boolean;
  startSec: number;
  endSec: number;
  reframeMode: "auto" | "center" | "motion" | "none";
  centroidXPerFrame: number[];
  motionFps: number;
  peakTimeRelSec: number;
  enableSlowmo: boolean;
  enableZoom: boolean;
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function buildFfmpegRenderArgs(opts: FiltergraphInput): string[] {
  const {
    sourcePath,
    outPath,
    assPath,
    watermarkPath,
    profile,
    encoder,
    srcWidth,
    srcHeight,
    hasAudio,
    startSec,
    endSec,
    reframeMode,
    centroidXPerFrame,
    motionFps,
    peakTimeRelSec,
    enableSlowmo,
    enableZoom,
  } = opts;

  const dur = Math.max(0.5, endSec - startSec);
  const { width, height, fps, audio, loudnessLUFS } = profile.output;

  const args: string[] = [
    "-y",
    "-ss",
    startSec.toFixed(2),
    "-t",
    dur.toFixed(2),
    "-i",
    sourcePath,
  ];

  const hasWm = Boolean(watermarkPath);
  if (watermarkPath) {
    args.push("-i", watermarkPath);
  }

  const reframe = buildReframeFilter({
    srcWidth,
    srcHeight,
    outWidth: width,
    outHeight: height,
    mode: reframeMode,
    allowBlurFill: profile.reframe.allowBlurFill,
    centroidXPerFrame,
    motionFps,
    startSec,
    endSec,
  });

  const vSteps: string[] = [];
  // Normalize timestamps to start at 0
  vSteps.push("setpts=PTS-STARTPTS");
  vSteps.push(reframe.cropFilter);
  vSteps.push(`fps=${fps}`);

  // Optional gentle zoom punch-in around peak
  if (enableZoom && profile.effects.zoom.maxScale > 1.0) {
    const maxS = profile.effects.zoom.maxScale;
    const zStart = Math.max(0, peakTimeRelSec - 0.6);
    const zEnd = Math.min(dur, peakTimeRelSec + 0.6);
    const mid = (zStart + zEnd) / 2;
    const half = Math.max(0.2, (zEnd - zStart) / 2);
    // Gentle scale expression: 1.0 outside [zStart, zEnd], up to maxS at peak
    const scaleExpr = `if(between(t,${zStart.toFixed(2)},${zEnd.toFixed(2)}),1+${(maxS - 1).toFixed(3)}*(1-abs(t-${mid.toFixed(2)})/${half.toFixed(2)}),1)`;
    vSteps.push(
      `scale=w='trunc(iw*(${scaleExpr})/2)*2':h='trunc(ih*(${scaleExpr})/2)*2':eval=frame,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    );
  }

  // Optional slow-mo speed ramp around peak (video only if no audio, or video+audio segments)
  let slowmoAudioFilter: string | null = null;
  if (enableSlowmo && dur > 3) {
    const factor = Math.max(0.5, Math.min(0.9, profile.effects.slowmo.factor));
    const win = Math.min(profile.effects.slowmo.windowSec, dur * 0.4);
    const sStart = Math.max(0.2, Math.min(dur - win - 0.2, peakTimeRelSec - win / 2));
    const sEnd = sStart + win;
    const ptsMult = (1 / factor).toFixed(3);
    vSteps.push(
      `split=3[v0][v1][v2];[v0]trim=0:${sStart.toFixed(2)},setpts=PTS-STARTPTS[v0p];[v1]trim=${sStart.toFixed(2)}:${sEnd.toFixed(2)},setpts=${ptsMult}*(PTS-STARTPTS)[v1p];[v2]trim=${sEnd.toFixed(2)},setpts=PTS-STARTPTS[v2p];[v0p][v1p][v2p]concat=n=3:v=1:a=0`,
    );
    if (hasAudio && audio === "keep") {
      slowmoAudioFilter = `[0:a]asplit=3[a0][a1][a2];[a0]atrim=0:${sStart.toFixed(2)},asetpts=PTS-STARTPTS[a0p];[a1]atrim=${sStart.toFixed(2)}:${sEnd.toFixed(2)},asetpts=PTS-STARTPTS,atempo=${factor.toFixed(2)}[a1p];[a2]atrim=${sEnd.toFixed(2)},asetpts=PTS-STARTPTS[a2p];[a0p][a1p][a2p]concat=n=3:v=0:a=1,loudnorm=I=${loudnessLUFS}:TP=-1.5:LRA=11[aout]`;
    }
  }

  if (assPath) {
    vSteps.push(`ass='${escapeFilterPath(assPath)}'`);
  }

  const filterParts: string[] = [];
  filterParts.push(`[0:v]${vSteps.join(",")}[vmain]`);

  if (hasWm) {
    const wmW = Math.max(16, Math.round((profile.watermark.widthPct / 100) * width));
    const mx = Math.round((profile.watermark.marginPct.x / 100) * width);
    const mb = Math.round((profile.watermark.marginPct.bottom / 100) * height);
    const mt = Math.round(((profile.watermark.marginPct.top ?? 10) / 100) * height);

    let xExpr = `${mx}`;
    let yExpr = `H-h-${mb}`;
    switch (profile.watermark.position) {
      case "bottom-left":
        xExpr = `${mx}`;
        yExpr = `H-h-${mb}`;
        break;
      case "bottom-right":
        xExpr = `W-w-${mx}`;
        yExpr = `H-h-${mb}`;
        break;
      case "top-left":
        xExpr = `${mx}`;
        yExpr = `${mt}`;
        break;
      case "top-right":
        xExpr = `W-w-${mx}`;
        yExpr = `${mt}`;
        break;
    }

    const alpha = profile.watermark.opacity;
    const alphaFilter =
      alpha < 1 ? `,colorchannelmixer=aa=${alpha.toFixed(2)}` : "";
    filterParts.push(
      `[1:v]scale=${wmW}:-1,format=rgba${alphaFilter}[wm];[vmain][wm]overlay=${xExpr}:${yExpr},format=yuv420p[vout]`,
    );
  } else {
    filterParts.push(`[vmain]format=yuv420p[vout]`);
  }

  let mapAudio = false;
  if (audio === "keep" && hasAudio) {
    mapAudio = true;
    if (slowmoAudioFilter) {
      filterParts.push(slowmoAudioFilter);
    } else {
      filterParts.push(
        `[0:a]asetpts=PTS-STARTPTS,loudnorm=I=${loudnessLUFS}:TP=-1.5:LRA=11[aout]`,
      );
    }
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]");
  if (mapAudio) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  if (encoder === "h264_nvenc") {
    args.push("-c:v", "h264_nvenc", "-cq", "19", "-preset", "p4");
  } else {
    args.push("-c:v", "libx264", "-crf", "18", "-preset", "veryfast");
  }

  args.push("-movflags", "+faststart", outPath);
  return args;
}

