import fs from "node:fs";
import { execa } from "execa";
import type { CopyPlan } from "../copy/fallback.js";
import type { CampaignProfile } from "../core/profile.js";
import { probeVideo } from "../core/probe.js";
import type { RenderManifest } from "../render/render.js";
import { checkWatermark } from "./watermark.js";

export interface CheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ValidationReport {
  clipId: string;
  variant: number;
  renderPath: string;
  passed: boolean;
  checks: CheckItem[];
  warnings: string[];
  validatedAt: string;
}

async function detectBlackBars(
  renderPath: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<{ hasBars: boolean; detail: string }> {
  const res = await execa(
    "ffmpeg",
    ["-i", renderPath, "-t", "4", "-vf", "cropdetect=10:2:0", "-f", "null", "-"],
    { reject: false },
  );
  const matches = [...res.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (matches.length === 0) {
    return { hasBars: false, detail: "no cropdetect output" };
  }
  const last = matches[matches.length - 1];
  const cw = Number(last[1]);
  const ch = Number(last[2]);
  const barW = expectedWidth - cw;
  const barH = expectedHeight - ch;
  const threshold = 24;
  if (barW > threshold || barH > threshold) {
    return {
      hasBars: true,
      detail: `Detected black bars: active area ${cw}x${ch} vs ${expectedWidth}x${expectedHeight}`,
    };
  }
  return {
    hasBars: false,
    detail: `No significant black bars (${cw}x${ch})`,
  };
}

export function validateCopyAgainstProfile(
  copy: CopyPlan,
  profile: CampaignProfile,
): CheckItem[] {
  const items: CheckItem[] = [];
  const platforms: Array<{
    key: keyof CopyPlan["captions"];
    limit: number;
  }> = [
    { key: "tiktok", limit: profile.captions.limits.tiktok },
    { key: "instagram", limit: profile.captions.limits.instagram },
    { key: "youtubeTitle", limit: profile.captions.limits.youtubeTitle },
    {
      key: "youtubeDescription",
      limit: profile.captions.limits.youtubeDescription,
    },
  ];

  for (const { key, limit } of platforms) {
    const text = copy.captions[key];
    const reasons: string[] = [];

    if (text.length > limit) {
      reasons.push(`length ${text.length} > ${limit}`);
    }

    for (const tag of profile.captions.requiredHashtags) {
      if (!text.includes(tag)) {
        reasons.push(`missing exact hashtag "${tag}"`);
      }
    }

    const platformMentions = [
      ...profile.captions.requiredMentions,
      ...(profile.captions.platformMentions[key] ?? []),
    ];
    for (const mention of platformMentions) {
      if (!text.includes(mention)) {
        reasons.push(`missing exact mention "${mention}"`);
      }
    }

    if (key !== "youtubeTitle") {
      for (const phrase of profile.captions.requiredPhrases) {
        if (phrase.trim() && !text.includes(phrase.trim())) {
          reasons.push(`missing required phrase "${phrase}"`);
        }
      }
    }

    const hashtags = text.match(/#[A-Za-z0-9_]+/g) ?? [];
    if (hashtags.length > profile.captions.maxHashtags) {
      reasons.push(`hashtags ${hashtags.length} > max ${profile.captions.maxHashtags}`);
    }

    for (const bad of profile.captions.forbiddenWords) {
      if (bad.trim() && new RegExp(`\\b${bad.trim()}\\b`, "i").test(text)) {
        reasons.push(`contains forbidden word "${bad}"`);
      }
    }

    items.push({
      name: `copy:${key}`,
      passed: reasons.length === 0,
      detail: reasons.length === 0 ? `OK (${text.length}/${limit} chars)` : reasons.join("; "),
    });
  }

  return items;
}

export async function validateRender(opts: {
  clipId: string;
  variant: number;
  renderPath: string;
  manifest: RenderManifest | null;
  copy: CopyPlan | null;
  profile: CampaignProfile;
  campaignDir: string;
}): Promise<ValidationReport> {
  const { clipId, variant, renderPath, manifest, copy, profile, campaignDir } = opts;
  const checks: CheckItem[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(renderPath)) {
    return {
      clipId,
      variant,
      renderPath,
      passed: false,
      checks: [{ name: "file", passed: false, detail: `Missing file: ${renderPath}` }],
      warnings,
      validatedAt: new Date().toISOString(),
    };
  }

  const probe = await probeVideo(renderPath);
  const { width, height, minSeconds, maxSeconds, audio, fps, maxFileSizeMB } =
    profile.output;

  checks.push({
    name: "duration",
    passed: probe.durationSec >= minSeconds && probe.durationSec <= maxSeconds,
    detail: `${probe.durationSec.toFixed(2)}s (bounds ${minSeconds}-${maxSeconds}s)`,
  });

  checks.push({
    name: "resolution",
    passed: probe.effectiveWidth === width && probe.effectiveHeight === height,
    detail: `${probe.effectiveWidth}x${probe.effectiveHeight} (expected ${width}x${height})`,
  });

  const aspect = probe.effectiveWidth / Math.max(1, probe.effectiveHeight);
  const targetAspect = width / height;
  checks.push({
    name: "aspect",
    passed: Math.abs(aspect - targetAspect) < 0.02,
    detail: `${aspect.toFixed(3)} (expected ${targetAspect.toFixed(3)})`,
  });

  if (audio === "keep") {
    checks.push({
      name: "audio",
      passed: probe.hasAudio,
      detail: probe.hasAudio ? `present (${probe.audioCodec})` : "missing audio stream",
    });
  }

  checks.push({
    name: "fps",
    passed: probe.fps >= 15 && probe.fps <= 120 && Math.abs(probe.fps - fps) <= 2,
    detail: `${probe.fps} fps (target ${fps})`,
  });

  const sizeMB = probe.sizeBytes / (1024 * 1024);
  checks.push({
    name: "fileSize",
    passed: sizeMB <= maxFileSizeMB,
    detail: `${sizeMB.toFixed(2)} MB (cap ${maxFileSizeMB} MB)`,
  });

  const bars = await detectBlackBars(renderPath, width, height);
  checks.push({
    name: "blackBars",
    passed: !bars.hasBars,
    detail: bars.detail,
  });

  const wm = await checkWatermark({
    renderPath,
    durationSec: probe.durationSec,
    manifest,
    profile,
    campaignDir,
  });
  if (wm.warning) warnings.push(wm.warning);
  checks.push({
    name: "watermark",
    passed: wm.passed,
    detail: wm.passed
      ? `${wm.mode}${wm.meanOpaqueMae !== undefined ? ` (MAE ${wm.meanOpaqueMae})` : ""}`
      : (wm.reason ?? "failed"),
  });

  if (copy) {
    checks.push(...validateCopyAgainstProfile(copy, profile));
  } else {
    checks.push({
      name: "copy",
      passed: false,
      detail: "Missing copy.json (run `clipper plan` first)",
    });
  }

  return {
    clipId,
    variant,
    renderPath,
    passed: checks.every((c) => c.passed),
    checks,
    warnings,
    validatedAt: new Date().toISOString(),
  };
}

