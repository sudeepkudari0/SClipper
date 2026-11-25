import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import pc from "picocolors";
import { getActiveCampaignFile } from "./workspace.js";

export const PostingWindowSchema = z.object({
  tz: z.string().min(1),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const CampaignProfileSchema = z.object({
  name: z.string().min(1),
  niche: z.string().default("general"),
  sources: z
    .object({
      localDir: z.string().default("./sources/default"),
      fetch: z.string().optional(),
    })
    .default({ localDir: "./sources/default" }),
  models: z.record(z.string(), z.string()).default({}),
  output: z
    .object({
      aspect: z.string().default("9:16"),
      width: z.number().int().positive().default(1080),
      height: z.number().int().positive().default(1920),
      fps: z.number().positive().default(30),
      minSeconds: z.number().positive().default(8),
      maxSeconds: z.number().positive().default(60),
      targetSeconds: z.tuple([z.number().positive(), z.number().positive()]).default([12, 25]),
      dropAtSec: z.number().positive().nullable().default(null),
      audio: z.enum(["keep", "mute"]).default("keep"),
      loudnessLUFS: z.number().default(-14),
      maxFileSizeMB: z.number().positive().default(250),
    })
    .default({}),
  reframe: z
    .object({
      mode: z.enum(["auto", "center", "motion", "none"]).default("auto"),
      allowBlurFill: z.boolean().default(false),
    })
    .default({}),
  watermark: z
    .object({
      file: z.string().nullable().default(null),
      position: z
        .enum(["bottom-left", "bottom-right", "top-left", "top-right"])
        .default("bottom-left"),
      marginPct: z
        .object({
          x: z.number().min(0).max(40).default(4),
          bottom: z.number().min(0).max(40).default(14),
          top: z.number().min(0).max(40).optional(),
        })
        .default({ x: 4, bottom: 14 }),
      widthPct: z.number().min(1).max(50).default(14),
      opacity: z.number().min(0).max(1).default(1.0),
      fullDuration: z.boolean().default(true),
    })
    .default({}),
  text: z
    .object({
      hook: z
        .object({
          enabled: z.boolean().default(true),
          maxChars: z.number().int().positive().default(38),
          topPct: z.number().min(1).max(80).default(14),
          fontFile: z.string().nullable().default(null),
          fontSize: z.number().int().positive().default(84),
          durationSec: z.number().positive().default(2.2),
        })
        .default({}),
      counter: z
        .object({
          enabled: z.boolean().default(false),
          label: z.string().default("SHOT"),
          minConfidence: z.number().min(0).max(1).default(0.7),
        })
        .default({}),
      captions: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  effects: z
    .object({
      slowmo: z
        .object({
          enabled: z.boolean().default(false),
          factor: z.number().min(0.2).max(0.95).default(0.45),
          windowSec: z.number().positive().default(1.2),
        })
        .default({}),
      zoom: z
        .object({
          enabled: z.boolean().default(false),
          maxScale: z.number().min(1.0).max(2.0).default(1.12),
        })
        .default({}),
    })
    .default({}),
  captions: z
    .object({
      requiredHashtags: z.array(z.string()).default([]),
      requiredMentions: z.array(z.string()).default([]),
      platformMentions: z.record(z.string(), z.array(z.string())).default({}),
      requiredPhrases: z.array(z.string()).default([]),
      extraHashtags: z.array(z.string()).default([]),
      maxHashtags: z.number().int().nonnegative().default(6),
      limits: z
        .object({
          tiktok: z.number().int().positive().default(2000),
          instagram: z.number().int().positive().default(2000),
          youtubeTitle: z.number().int().positive().default(95),
          youtubeDescription: z.number().int().positive().default(4500),
        })
        .default({}),
      forbiddenWords: z.array(z.string()).default([]),
    })
    .default({}),
  voice: z
    .object({
      tone: z.string().default("positive, factual, energetic"),
      rules: z.array(z.string()).default([]),
    })
    .default({}),
  bans: z
    .object({
      aiVoiceover: z.boolean().default(true),
      aiFootage: z.boolean().default(true),
      bakedMusic: z.boolean().default(true),
    })
    .default({}),
  postingWindows: z.array(PostingWindowSchema).default([]),
  fallbackHooks: z
    .array(z.string())
    .default(["Watch until the end.", "Wait for the finish."]),
});

export type CampaignProfile = z.infer<typeof CampaignProfileSchema>;

export function getCampaignsDir(cwd = process.cwd()): string {
  return path.join(cwd, "campaigns");
}

export function listAvailableCampaigns(campaignsDir = getCampaignsDir()): string[] {
  if (!fs.existsSync(campaignsDir)) return [];
  return fs
    .readdirSync(campaignsDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(campaignsDir, e.name, "profile.yaml")),
    )
    .map((e) => e.name)
    .sort();
}

export function resolveCampaignName(opts: {
  campaignOpt?: string;
  workspaceDir: string;
  campaignsDir?: string;
}): string {
  const campaignsDir = opts.campaignsDir ?? getCampaignsDir();
  if (opts.campaignOpt && opts.campaignOpt.trim().length > 0) {
    return opts.campaignOpt.trim();
  }

  const activeFile = getActiveCampaignFile(opts.workspaceDir);
  if (fs.existsSync(activeFile)) {
    const active = fs.readFileSync(activeFile, "utf8").trim();
    if (active.length > 0) return active;
  }

  const available = listAvailableCampaigns(campaignsDir);
  if (available.length === 1) {
    return available[0];
  }

  const listStr =
    available.length > 0
      ? `Available campaigns: ${available.join(", ")}`
      : "No campaigns found in campaigns/. Run `clipper campaign init <name>` first.";
  throw new Error(
    `No campaign specified and no active campaign set. Use --campaign <name> or \`clipper use <name>\`. ${listStr}`,
  );
}

export function loadCampaignProfile(
  name: string,
  campaignsDir = getCampaignsDir(),
): { profile: CampaignProfile; campaignDir: string; profilePath: string } {
  const campaignDir = path.join(campaignsDir, name);
  const profilePath = path.join(campaignDir, "profile.yaml");
  if (!fs.existsSync(profilePath)) {
    const available = listAvailableCampaigns(campaignsDir);
    throw new Error(
      `Campaign "${name}" not found at ${profilePath}. Available: ${available.join(", ") || "(none)"}`,
    );
  }
  const rawYaml = fs.readFileSync(profilePath, "utf8");
  const parsed = YAML.parse(rawYaml);
  const result = CampaignProfileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid profile.yaml for campaign "${name}":\n${issues}`);
  }
  return { profile: result.data, campaignDir, profilePath };
}

export function resolveWatermarkPath(
  profile: CampaignProfile,
  campaignDir: string,
): string | null {
  if (!profile.watermark.file) return null;
  if (path.isAbsolute(profile.watermark.file)) {
    return profile.watermark.file;
  }
  return path.resolve(campaignDir, profile.watermark.file);
}

export function printCampaignHeader(name: string, jsonMode = false): void {
  if (!jsonMode) {
    console.log(pc.bold(pc.cyan(`Campaign: ${name}`)));
  }
}

