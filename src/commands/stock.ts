import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { buildDropCutMontage } from "../render/montage.js";
import { downloadPexelsClips } from "../sources/pexels.js";
import { resolveCommandContext, type GlobalOptions } from "./context.js";

export async function stockCommand(
  cmdOpts: {
    query: string;
    count?: number;
    orientation?: "portrait" | "landscape" | "square";
    out?: string;
  },
  opts: GlobalOptions,
): Promise<string[]> {
  const ctx = resolveCommandContext(opts);
  const outDir = path.resolve(
    cmdOpts.out ?? path.join(ctx.profile.sources.localDir, "_stock"),
  );
  const files = await downloadPexelsClips({
    query: cmdOpts.query,
    outDir,
    count: cmdOpts.count ?? 4,
    orientation: cmdOpts.orientation ?? "portrait",
  });

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, files }, null, 2));
  } else {
    console.log(
      pc.green(`Downloaded ${files.length} Pexels clip(s) to ${outDir}`),
    );
  }
  return files;
}

export async function montageCommand(
  cmdOpts: {
    dir?: string;
    dropAt?: number;
    duration?: number;
  },
  opts: GlobalOptions,
): Promise<string> {
  const ctx = resolveCommandContext(opts);
  const stockDir = path.resolve(
    cmdOpts.dir ?? path.join(ctx.profile.sources.localDir, "_stock"),
  );
  if (!fs.existsSync(stockDir)) {
    throw new Error(
      `Stock directory not found: ${stockDir}. Run \`clipper stock --query "..."\` first.`,
    );
  }

  const inputFiles = fs
    .readdirSync(stockDir)
    .filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f))
    .sort()
    .map((f) => path.join(stockDir, f));

  if (inputFiles.length === 0) {
    throw new Error(`No video files found in ${stockDir}`);
  }

  const dropAtSec = cmdOpts.dropAt ?? ctx.profile.output.dropAtSec ?? 3.0;
  const totalDurationSec =
    cmdOpts.duration ??
    Math.max(ctx.profile.output.minSeconds, ctx.profile.output.targetSeconds[0]);

  const outPath = await buildDropCutMontage({
    inputFiles,
    outDir: path.resolve(ctx.profile.sources.localDir),
    width: ctx.profile.output.width,
    height: ctx.profile.output.height,
    fps: ctx.profile.output.fps,
    totalDurationSec,
    dropAtSec,
  });

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, outPath }, null, 2));
  } else {
    console.log(
      pc.green(`Created ${totalDurationSec}s drop-cut montage at ${outPath}`),
    );
  }
  return outPath;
}

