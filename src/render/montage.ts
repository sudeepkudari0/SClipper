import crypto from "node:crypto";
import path from "node:path";
import { runFfmpeg } from "../core/ffmpeg.js";
import { probeVideo } from "../core/probe.js";
import { ensureDir } from "../core/workspace.js";

export interface MontageOptions {
  inputFiles: string[];
  outDir: string;
  width: number;
  height: number;
  fps: number;
  totalDurationSec: number;
  dropAtSec: number;
}

const XFADE_TRANSITIONS = ["fade", "smoothleft", "dissolve", "slideright"];

/**
 * Stitch multiple clips into a single vertical montage with smooth xfade
 * transitions and short-form pacing (roughly 2-3s per segment).
 * Output is muted (for in-app sound campaigns).
 */
export async function buildDropCutMontage(
  opts: MontageOptions,
): Promise<string> {
  const {
    inputFiles,
    outDir,
    width,
    height,
    fps,
    totalDurationSec,
    dropAtSec,
  } = opts;

  if (inputFiles.length === 0) {
    throw new Error("No input video files provided for montage.");
  }

  ensureDir(outDir);
  // A long transition on every shot makes a 9:16 music montage feel slow and
  // removes the impact of the drop. Keep the transition brief and let hard-cut
  // rhythm come from the segment boundaries.
  const xfadeDur = 0.32;
  const minSegDur = 1.8;

  const hash = crypto
    .createHash("sha256")
    .update(inputFiles.join("|") + `:xfade:${xfadeDur}:segment:2.15:${totalDurationSec}`)
    .digest("hex")
    .slice(0, 8);
  const outPath = path.join(outDir, `montage_${hash}.mp4`);

  const probes = await Promise.all(inputFiles.map((f) => probeVideo(f)));

  const segmentInputs: typeof probes = [];
  const segDurations: number[] = [];

  // Build enough segments (accounting for xfadeDur overlap) to reach totalDurationSec
  let netDuration = 0;
  let idx = 0;
  while (netDuration < totalDurationSec && idx < 12) {
    const p = probes[idx % probes.length];
    const maxAvail = Math.max(2.0, p.durationSec - 0.2);
    const targetSeg = Math.min(
      maxAvail,
      Math.max(
        minSegDur,
        idx === 0 ? Math.max(2.8, Math.min(3.2, dropAtSec)) : 2.15,
      ),
    );
    segmentInputs.push(p);
    segDurations.push(Number(targetSeg.toFixed(2)));
    netDuration += idx === 0 ? targetSeg : targetSeg - xfadeDur;
    idx++;
  }

  const args: string[] = ["-y"];
  const filterParts: string[] = [];

  for (let i = 0; i < segDurations.length; i++) {
    const p = segmentInputs[i];
    const d = segDurations[i];
    args.push("-ss", "0", "-t", d.toFixed(2), "-i", p.filePath);
    filterParts.push(
      `[${i}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p[v${i}]`,
    );
  }

  if (segDurations.length === 1) {
    filterParts.push(`[v0]copy[vout]`);
  } else {
    let prevLabel = "v0";
    let offset = segDurations[0] - xfadeDur;
    for (let i = 1; i < segDurations.length; i++) {
      const outLabel = i === segDurations.length - 1 ? "vout" : `vx${i}`;
      const tr = XFADE_TRANSITIONS[(i - 1) % XFADE_TRANSITIONS.length];
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=${tr}:duration=${xfadeDur}:offset=${Math.max(0.1, offset).toFixed(2)}[${outLabel}]`,
      );
      prevLabel = outLabel;
      offset += segDurations[i] - xfadeDur;
    }
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    outPath,
  );

  await runFfmpeg(args);
  return outPath;
}
