import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import pc from "picocolors";
import { analyzeAudio, type AudioAnalysis } from "../analysis/audio.js";
import { findTopMoments } from "../analysis/moments.js";
import { analyzeMotion, type MotionAnalysis } from "../analysis/motion.js";
import { detectSceneCuts } from "../analysis/scenes.js";
import {
  transcribeVideo,
  WhisperCmdTranscriptionProvider,
} from "../analysis/transcribe.js";
import { describeFramesWithVision } from "../analysis/vision.js";
import { selectWindow, type WindowSelectionResult } from "../analysis/window.js";
import type { CopyPlan } from "../copy/fallback.js";
import { generateCopyPlan } from "../copy/plan.js";
import { probeVideo, type SourceProbe } from "../core/probe.js";
import {
  ensureDir,
  getCampaignWorkspaceDir,
  getClipDir,
  listClipIds,
  readJson,
  writeJson,
} from "../core/workspace.js";
import { exportPassingRenders, type ExportRecord } from "../export/export.js";
import type { TranscriptSegment } from "../llm/provider.js";
import type { PlanFacts } from "../llm/prompts.js";
import { renderClipVariants, type RenderManifest } from "../render/render.js";
import { validateRender, type ValidationReport } from "../validate/checks.js";
import { resolveCommandContext, type GlobalOptions } from "./context.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm"]);

export interface ExtendedSourceProbe extends SourceProbe {
  windowOverride?: { start: number; end: number };
  transcriptExcerpt?: string;
}

export interface ClipAnalysis {
  clipId: string;
  audio: AudioAnalysis;
  motion: MotionAnalysis;
  sceneCuts: number[];
  window: WindowSelectionResult;
  actionScore: number;
  visionDescription?: string | null;
  analyzedAt: string;
}

function getTargetClipIds(
  workspaceDir: string,
  campaign: string,
  clipId?: string,
): string[] {
  if (clipId) {
    const dir = getClipDir(workspaceDir, campaign, clipId);
    if (!fs.existsSync(path.join(dir, "source.json"))) {
      throw new Error(`Clip "${clipId}" not found in workspace/${campaign}`);
    }
    return [clipId];
  }
  const all = listClipIds(workspaceDir, campaign);
  if (all.length === 0) {
    throw new Error(
      `No ingested clips found for "${campaign}". Run \`clipper ingest\` first.`,
    );
  }
  return all;
}

function scanVideoFiles(targetPath: string): string[] {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Source path does not exist: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    return VIDEO_EXTS.has(path.extname(abs).toLowerCase()) ? [abs] : [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join(abs, entry.name));
    }
  }
  return files.sort();
}

export async function fetchCommand(opts: GlobalOptions): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const fetchTpl = ctx.profile.sources.fetch;
  if (!fetchTpl) {
    throw new Error(
      `Campaign "${ctx.campaign}" has no sources.fetch command configured in profile.yaml.`,
    );
  }
  const localDir = path.resolve(ctx.profile.sources.localDir);
  ensureDir(localDir);
  const cmd = fetchTpl.replaceAll("{localDir}", localDir);
  if (!ctx.json) {
    console.log(pc.dim(`Running fetch: ${cmd}`));
  }
  await execa("sh", ["-c", cmd], { stdio: "inherit" });
  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, localDir, ok: true }));
  }
}

export async function ingestCommand(
  inputPath: string | undefined,
  cmdOpts: { copy?: boolean },
  opts: GlobalOptions,
): Promise<ExtendedSourceProbe[]> {
  const ctx = resolveCommandContext(opts);
  const target = inputPath ?? ctx.profile.sources.localDir;
  const files = scanVideoFiles(target);
  if (files.length === 0) {
    throw new Error(`No video files (.mp4, .mov, .mkv, .webm) found at ${target}`);
  }

  const ingested: ExtendedSourceProbe[] = [];
  for (const file of files) {
    const probe = await probeVideo(file);
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, probe.clipId);
    ensureDir(cDir);
    const sourceJsonPath = path.join(cDir, "source.json");
    writeJson(sourceJsonPath, probe);

    const linkPath = path.join(cDir, `source${path.extname(file)}`);
    if (!fs.existsSync(linkPath)) {
      if (cmdOpts.copy) {
        fs.copyFileSync(file, linkPath);
      } else {
        fs.symlinkSync(probe.filePath, linkPath);
      }
    }
    ingested.push(probe);
    if (!ctx.json) {
      console.log(
        `  Ingested ${pc.bold(probe.clipId)} (${probe.effectiveWidth}x${probe.effectiveHeight}, ${probe.durationSec.toFixed(1)}s, ${probe.fileName})`,
      );
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, ingested }, null, 2));
  }
  return ingested;
}

export async function analyzeClipInternal(opts: {
  clipDir: string;
  probe: ExtendedSourceProbe;
  ctx: ReturnType<typeof resolveCommandContext>;
  vision?: boolean;
  noTrim?: boolean;
  force?: boolean;
}): Promise<ClipAnalysis> {
  const { clipDir, probe, ctx, vision, noTrim, force } = opts;
  const analysisPath = path.join(clipDir, "analysis.json");
  if (!force) {
    const cached = readJson<ClipAnalysis>(analysisPath);
    if (cached) {
      if (vision && !cached.visionDescription) {
        cached.visionDescription = await describeFramesWithVision(
          probe.filePath,
          probe.durationSec,
          ctx.llm,
        );
        writeJson(analysisPath, cached);
      }
      return cached;
    }
  }

  const [audio, motion, sceneCuts] = await Promise.all([
    analyzeAudio(probe.filePath, probe.hasAudio),
    analyzeMotion(probe.filePath),
    detectSceneCuts(probe.filePath),
  ]);

  const window = probe.windowOverride
    ? {
        start: probe.windowOverride.start,
        end: probe.windowOverride.end,
        score: 1,
        trimmed: true,
      }
    : selectWindow({
        durationSec: probe.durationSec,
        rmsPer50ms: audio.rmsPer50ms,
        motionEnergy: motion.energyPerFrame,
        motionFps: motion.fps,
        sceneCuts,
        estimatedHits: audio.estimatedHits,
        minSeconds: ctx.profile.output.minSeconds,
        maxSeconds: ctx.profile.output.maxSeconds,
        targetSeconds: ctx.profile.output.targetSeconds,
        dropAtSec: ctx.profile.output.dropAtSec,
        noTrim,
      });

  const hitDensity =
    audio.estimatedHits.length / Math.max(1, probe.durationSec);
  const actionScore = Number(
    (
      0.4 * Math.min(1, audio.meanRms * 10) +
      0.35 * Math.min(1, hitDensity * 2) +
      0.25 * Math.min(1, motion.meanEnergy * 25)
    ).toFixed(3),
  );

  let visionDescription: string | null | undefined;
  if (vision) {
    visionDescription = await describeFramesWithVision(
      probe.filePath,
      probe.durationSec,
      ctx.llm,
    );
  }

  const result: ClipAnalysis = {
    clipId: probe.clipId,
    audio,
    motion,
    sceneCuts,
    window,
    actionScore,
    visionDescription,
    analyzedAt: new Date().toISOString(),
  };

  writeJson(analysisPath, result);
  return result;
}

export async function analyzeCommand(
  clipId: string | undefined,
  cmdOpts: { vision?: boolean; noTrim?: boolean; force?: boolean },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const ids = getTargetClipIds(ctx.workspaceDir, ctx.campaign, clipId);
  const results: ClipAnalysis[] = [];

  for (const id of ids) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, id);
    const probe = readJson<ExtendedSourceProbe>(path.join(cDir, "source.json"));
    if (!probe) continue;
    const analysis = await analyzeClipInternal({
      clipDir: cDir,
      probe,
      ctx,
      vision: cmdOpts.vision,
      noTrim: cmdOpts.noTrim,
      force: cmdOpts.force,
    });
    results.push(analysis);

    if (!ctx.json) {
      console.log(
        `  ${pc.bold(id)} | window=${analysis.window.start.toFixed(1)}-${analysis.window.end.toFixed(1)}s | estHits=${analysis.audio.estimatedHits.length} (conf=${analysis.audio.hitConfidence}) | cuts=${analysis.sceneCuts.length} | motion=${analysis.motion.dominantSide} | score=${analysis.actionScore}`,
      );
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, results }, null, 2));
  }
}

export async function transcribeCommand(
  clipId: string | undefined,
  cmdOpts: { provider?: string; force?: boolean },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const ids = getTargetClipIds(ctx.workspaceDir, ctx.campaign, clipId);

  const providerName = cmdOpts.provider ?? "mistral";
  const provider =
    providerName === "whisper-cmd"
      ? (() => {
          const tpl = process.env.WHISPER_CMD;
          if (!tpl) {
            throw new Error(
              "WHISPER_CMD env variable is not set for whisper-cmd provider.",
            );
          }
          return new WhisperCmdTranscriptionProvider(tpl);
        })()
      : ctx.llm;

  const out: Record<string, TranscriptSegment[]> = {};
  for (const id of ids) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, id);
    const tPath = path.join(cDir, "transcript.json");
    if (!cmdOpts.force) {
      const cached = readJson<TranscriptSegment[]>(tPath);
      if (cached) {
        out[id] = cached;
        if (!ctx.json) {
          console.log(`  ${id}: ${cached.length} segments (cached)`);
        }
        continue;
      }
    }
    const probe = readJson<ExtendedSourceProbe>(path.join(cDir, "source.json"));
    if (!probe) continue;
    const segments = await transcribeVideo(
      probe.filePath,
      probe.durationSec,
      provider,
    );
    writeJson(tPath, segments);
    out[id] = segments;
    if (!ctx.json) {
      console.log(`  ${id}: transcribed ${segments.length} segments`);
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, transcripts: out }, null, 2));
  }
}

export async function momentsCommand(
  clipId: string | undefined,
  cmdOpts: { top?: number; force?: boolean },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const ids = getTargetClipIds(ctx.workspaceDir, ctx.campaign, clipId);
  const topN = Number(cmdOpts.top ?? 10);

  for (const id of ids) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, id);
    const probe = readJson<ExtendedSourceProbe>(path.join(cDir, "source.json"));
    const segments = readJson<TranscriptSegment[]>(
      path.join(cDir, "transcript.json"),
    );
    if (!probe || !segments) {
      throw new Error(
        `Missing transcript.json for ${id}. Run \`clipper transcribe ${id}\` first.`,
      );
    }

    const momentsPath = path.join(cDir, "moments.json");
    let moments = !cmdOpts.force
      ? readJson<Awaited<ReturnType<typeof findTopMoments>>>(momentsPath)
      : null;

    if (!moments) {
      moments = await findTopMoments(segments, ctx.profile, ctx.llm, topN);
      writeJson(momentsPath, moments);
    }

    for (let i = 0; i < moments.length; i++) {
      const m = moments[i];
      const childId = `${id}-m${String(i + 1).padStart(2, "0")}`;
      const childDir = getClipDir(ctx.workspaceDir, ctx.campaign, childId);
      ensureDir(childDir);
      const childProbe: ExtendedSourceProbe = {
        ...probe,
        clipId: childId,
        windowOverride: { start: m.start, end: m.end },
        transcriptExcerpt: m.transcriptExcerpt,
      };
      writeJson(path.join(childDir, "source.json"), childProbe);
      if (!ctx.json) {
        console.log(
          `  ${pc.bold(childId)} [${m.start.toFixed(1)}-${m.end.toFixed(1)}s] score=${m.score}: ${m.hookIdea}`,
        );
      }
    }

    if (ctx.json) {
      console.log(JSON.stringify({ clipId: id, moments }, null, 2));
    }
  }
}

export async function planCommand(
  clipId: string | undefined,
  cmdOpts: { context?: string; noLlm?: boolean; force?: boolean },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const ids = getTargetClipIds(ctx.workspaceDir, ctx.campaign, clipId);

  const plans: CopyPlan[] = [];
  for (const id of ids) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, id);
    const copyPath = path.join(cDir, "copy.json");
    if (!cmdOpts.force) {
      const cached = readJson<CopyPlan>(copyPath);
      if (cached) {
        plans.push(cached);
        if (!ctx.json) {
          console.log(`  ${id}: using cached copy.json (${cached.hooks.length} hooks)`);
        }
        continue;
      }
    }

    const probe = readJson<ExtendedSourceProbe>(path.join(cDir, "source.json"));
    const analysis = readJson<ClipAnalysis>(path.join(cDir, "analysis.json"));
    if (!probe || !analysis) {
      throw new Error(`Missing analysis.json for ${id}. Run \`clipper analyze ${id}\` first.`);
    }

    const hitsInWindow = analysis.audio.estimatedHits.filter(
      (h) => h.time >= analysis.window.start && h.time <= analysis.window.end,
    );
    const facts: PlanFacts = {
      clipId: id,
      durationSec: probe.durationSec,
      windowStartSec: analysis.window.start,
      windowEndSec: analysis.window.end,
      estimatedHits: hitsInWindow.length,
      hitConfidence: analysis.audio.hitConfidence,
      rallyLengthSec: Number((analysis.window.end - analysis.window.start).toFixed(1)),
      peakTimeSec: analysis.audio.peakTimeSec,
      frameDescription: analysis.visionDescription ?? undefined,
      transcriptExcerpt: probe.transcriptExcerpt,
      userContext: cmdOpts.context,
    };

    const plan = await generateCopyPlan(facts, ctx.profile, ctx.llm, {
      noLlm: cmdOpts.noLlm,
    });
    writeJson(copyPath, plan);
    plans.push(plan);

    if (!ctx.json) {
      console.log(
        `  ${pc.bold(id)}: ${plan.hooks.length} hooks (${plan.usedLlm ? "LLM" : "template"}) | top="${plan.hooks[0]}"`,
      );
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, plans }, null, 2));
  }
}

export async function renderCommand(
  clipId: string | undefined,
  cmdOpts: {
    variants?: number;
    reframe?: "auto" | "center" | "motion" | "none";
    slowmo?: boolean;
    zoom?: boolean;
    counter?: boolean;
    noTrim?: boolean;
  },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const ids = getTargetClipIds(ctx.workspaceDir, ctx.campaign, clipId);
  const variants = Math.max(1, Number(cmdOpts.variants ?? 1));

  const allManifests: RenderManifest[] = [];
  for (const id of ids) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, id);
    const probe = readJson<ExtendedSourceProbe>(path.join(cDir, "source.json"));
    const analysis = readJson<ClipAnalysis>(path.join(cDir, "analysis.json"));
    const copy = readJson<CopyPlan>(path.join(cDir, "copy.json"));
    if (!probe || !analysis || !copy) {
      throw new Error(
        `Missing source/analysis/copy for ${id}. Run analyze and plan first.`,
      );
    }

    const windowSel = cmdOpts.noTrim
      ? { start: 0, end: probe.durationSec, score: 1, trimmed: false }
      : analysis.window;

    const manifests = await renderClipVariants({
      clipDir: cDir,
      campaignDir: ctx.campaignDir,
      probe,
      audio: analysis.audio,
      motion: analysis.motion,
      windowSel,
      copy,
      profile: ctx.profile,
      variants,
      reframeOverride: cmdOpts.reframe,
      slowmoOverride: cmdOpts.slowmo,
      zoomOverride: cmdOpts.zoom,
      counterOverride: cmdOpts.counter,
      onProgress: ctx.json
        ? undefined
        : (v, frac) => {
            const pct = Math.round(frac * 100);
            process.stdout.write(`\r  Rendering ${id} v${v}: ${pct}%`);
            if (frac >= 1) process.stdout.write("\n");
          },
    });
    allManifests.push(...manifests);
  }

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, manifests: allManifests }, null, 2));
  }
}

export async function validateCommand(
  clipId: string | undefined,
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const ids = getTargetClipIds(ctx.workspaceDir, ctx.campaign, clipId);

  const reports: ValidationReport[] = [];
  for (const id of ids) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, id);
    const copy = readJson<CopyPlan>(path.join(cDir, "copy.json"));
    const renderFiles = fs
      .readdirSync(cDir)
      .filter((f) => /^render_v\d+\.mp4$/.test(f))
      .sort();

    if (renderFiles.length === 0) {
      throw new Error(`No render_vN.mp4 files found for ${id}. Run \`clipper render ${id}\` first.`);
    }

    for (const rf of renderFiles) {
      const vNum = Number(rf.match(/render_v(\d+)\.mp4/)?.[1] ?? 1);
      const renderPath = path.join(cDir, rf);
      const manifest = readJson<RenderManifest>(
        path.join(cDir, `render_v${vNum}.json`),
      );
      const report = await validateRender({
        clipId: id,
        variant: vNum,
        renderPath,
        manifest,
        copy,
        profile: ctx.profile,
        campaignDir: ctx.campaignDir,
      });
      writeJson(path.join(cDir, `report_v${vNum}.json`), report);
      reports.push(report);

      if (!ctx.json) {
        const badge = report.passed ? pc.green("PASS") : pc.red("FAIL");
        const failedDetails = report.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.name}: ${c.detail}`)
          .join("; ");
        console.log(
          `  [${badge}] ${id} v${vNum}${failedDetails ? ` -> ${failedDetails}` : ""}`,
        );
        for (const w of report.warnings) {
          console.log(pc.yellow(`    WARN: ${w}`));
        }
      }
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, reports }, null, 2));
  }

  if (reports.some((r) => !r.passed)) {
    process.exitCode = 1;
  }
}

export async function exportCommand(opts: GlobalOptions): Promise<void> {
  const ctx = resolveCommandContext(opts);
  const res = exportPassingRenders({
    workspaceDir: ctx.workspaceDir,
    campaign: ctx.campaign,
    profile: ctx.profile,
  });

  if (ctx.json) {
    console.log(JSON.stringify({ campaign: ctx.campaign, ...res }, null, 2));
  } else {
    console.log(
      pc.green(
        `Exported ${res.exported.length} passing render(s) to ${res.outDir}`,
      ),
    );
    console.log(`Captions & checklist: ${res.captionsPath}`);
  }
}

export async function runCommand(
  inputPath: string | undefined,
  cmdOpts: {
    top?: number;
    limit?: number;
    fetch?: boolean;
    variants?: number;
    reframe?: "auto" | "center" | "motion" | "none";
    slowmo?: boolean;
    zoom?: boolean;
    counter?: boolean;
    noTrim?: boolean;
    noLlm?: boolean;
    vision?: boolean;
    context?: string;
    force?: boolean;
  },
  opts: GlobalOptions,
): Promise<void> {
  const ctx = resolveCommandContext(opts);
  if (!ctx.json) {
    console.log(
      pc.dim(
        `Rules: ${ctx.profile.output.width}x${ctx.profile.output.height} (${ctx.profile.output.minSeconds}-${ctx.profile.output.maxSeconds}s) | tags=${ctx.profile.captions.requiredHashtags.join(",")} | mentions=${ctx.profile.captions.requiredMentions.join(",")}`,
      ),
    );
  }

  if (cmdOpts.fetch) {
    const fetchTpl = ctx.profile.sources.fetch;
    if (!fetchTpl) {
      throw new Error(`--fetch requested but sources.fetch is not set in profile.yaml`);
    }
    const localDir = path.resolve(ctx.profile.sources.localDir);
    ensureDir(localDir);
    await execa("sh", ["-c", fetchTpl.replaceAll("{localDir}", localDir)], {
      stdio: "inherit",
    });
  }

  const target = inputPath ?? ctx.profile.sources.localDir;
  const files = scanVideoFiles(target);
  if (files.length === 0) {
    throw new Error(`No video files found at ${target}`);
  }

  const exportedIndexPath = path.join(
    getCampaignWorkspaceDir(ctx.workspaceDir, ctx.campaign),
    "exported.json",
  );
  const exportedIndex =
    readJson<Record<string, ExportRecord[]>>(exportedIndexPath) ?? {};

  const newProbes: ExtendedSourceProbe[] = [];
  for (const file of files) {
    const probe = await probeVideo(file);
    if (!cmdOpts.force && exportedIndex[probe.clipId]?.length) {
      if (!ctx.json) {
        console.log(pc.dim(`Skipping already exported: ${probe.clipId}`));
      }
      continue;
    }
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, probe.clipId);
    ensureDir(cDir);
    writeJson(path.join(cDir, "source.json"), probe);
    newProbes.push(probe);
  }

  if (newProbes.length === 0) {
    if (!ctx.json) {
      console.log(pc.yellow("No new clips to process (use --force to reprocess)."));
    } else {
      console.log(JSON.stringify({ campaign: ctx.campaign, processed: [] }));
    }
    return;
  }

  // Analyze every new clip
  const analyzed: Array<{ probe: ExtendedSourceProbe; analysis: ClipAnalysis }> = [];
  for (const probe of newProbes) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, probe.clipId);
    const analysis = await analyzeClipInternal({
      clipDir: cDir,
      probe,
      ctx,
      vision: cmdOpts.vision,
      noTrim: cmdOpts.noTrim,
      force: cmdOpts.force,
    });
    analyzed.push({ probe, analysis });
  }

  // Rank by action score and apply --top / --limit
  analyzed.sort((a, b) => b.analysis.actionScore - a.analysis.actionScore);
  const keepCount = cmdOpts.top ?? cmdOpts.limit ?? analyzed.length;
  const selected = analyzed.slice(0, Math.max(1, keepCount));
  const variants = Math.max(1, Number(cmdOpts.variants ?? 1));

  const summaryRows: Array<{
    clipId: string;
    window: string;
    estimatedHits: number;
    score: number;
    variants: number;
    status: string;
    reasons: string;
  }> = [];

  const passingClipIds: string[] = [];

  for (const { probe, analysis } of selected) {
    const cDir = getClipDir(ctx.workspaceDir, ctx.campaign, probe.clipId);
    const hitsInWindow = analysis.audio.estimatedHits.filter(
      (h) => h.time >= analysis.window.start && h.time <= analysis.window.end,
    );

    const facts: PlanFacts = {
      clipId: probe.clipId,
      durationSec: probe.durationSec,
      windowStartSec: analysis.window.start,
      windowEndSec: analysis.window.end,
      estimatedHits: hitsInWindow.length,
      hitConfidence: analysis.audio.hitConfidence,
      rallyLengthSec: Number(
        (analysis.window.end - analysis.window.start).toFixed(1),
      ),
      peakTimeSec: analysis.audio.peakTimeSec,
      frameDescription: analysis.visionDescription ?? undefined,
      userContext: cmdOpts.context,
    };

    const copy = await generateCopyPlan(facts, ctx.profile, ctx.llm, {
      noLlm: cmdOpts.noLlm,
    });
    writeJson(path.join(cDir, "copy.json"), copy);

    const manifests = await renderClipVariants({
      clipDir: cDir,
      campaignDir: ctx.campaignDir,
      probe,
      audio: analysis.audio,
      motion: analysis.motion,
      windowSel: analysis.window,
      copy,
      profile: ctx.profile,
      variants,
      reframeOverride: cmdOpts.reframe,
      slowmoOverride: cmdOpts.slowmo,
      zoomOverride: cmdOpts.zoom,
      counterOverride: cmdOpts.counter,
      onProgress: ctx.json
        ? undefined
        : (v, frac) => {
            const pct = Math.round(frac * 100);
            process.stdout.write(`\r  Rendering ${probe.clipId} v${v}: ${pct}%`);
            if (frac >= 1) process.stdout.write("\n");
          },
    });

    const reports: ValidationReport[] = [];
    for (const m of manifests) {
      const report = await validateRender({
        clipId: probe.clipId,
        variant: m.variant,
        renderPath: m.outputPath,
        manifest: m,
        copy,
        profile: ctx.profile,
        campaignDir: ctx.campaignDir,
      });
      writeJson(path.join(cDir, `report_v${m.variant}.json`), report);
      reports.push(report);
    }

    const passCount = reports.filter((r) => r.passed).length;
    if (passCount > 0) passingClipIds.push(probe.clipId);
    const reasons = reports
      .flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => c.detail))
      .join("; ");

    summaryRows.push({
      clipId: probe.clipId,
      window: `${analysis.window.start.toFixed(1)}-${analysis.window.end.toFixed(1)}s`,
      estimatedHits: hitsInWindow.length,
      score: analysis.actionScore,
      variants: manifests.length,
      status: passCount === manifests.length ? "PASS" : passCount > 0 ? "PARTIAL" : "FAIL",
      reasons,
    });
  }

  const exportRes = exportPassingRenders({
    workspaceDir: ctx.workspaceDir,
    campaign: ctx.campaign,
    profile: ctx.profile,
    clipIds: passingClipIds,
  });

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          campaign: ctx.campaign,
          summary: summaryRows,
          outDir: exportRes.outDir,
          exportedCount: exportRes.exported.length,
          llmUsage: ctx.llm.getUsage(),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(pc.bold("\nRun Summary:"));
  for (const row of summaryRows) {
    const badge =
      row.status === "PASS"
        ? pc.green("PASS")
        : row.status === "PARTIAL"
          ? pc.yellow("PARTIAL")
          : pc.red("FAIL");
    console.log(
      `  [${badge}] ${row.clipId} | win=${row.window} | estHits=${row.estimatedHits} | score=${row.score} | variants=${row.variants}${row.reasons ? ` | ${row.reasons}` : ""}`,
    );
  }
  console.log(
    pc.green(
      `\nOutput: ${exportRes.outDir} (${exportRes.exported.length} file(s), captions.md)`,
    ),
  );
  const usage = ctx.llm.getUsage();
  if (Object.keys(usage).length > 0) {
    console.log(pc.dim(`LLM usage: ${JSON.stringify(usage)}`));
  }
}

