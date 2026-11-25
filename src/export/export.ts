import fs from "node:fs";
import path from "node:path";
import type { CopyPlan } from "../copy/fallback.js";
import type { CampaignProfile } from "../core/profile.js";
import {
  ensureDir,
  getCampaignWorkspaceDir,
  getClipDir,
  getOutDir,
  listClipIds,
  readJson,
  writeJson,
} from "../core/workspace.js";
import type { ValidationReport } from "../validate/checks.js";

export interface ExportRecord {
  clipId: string;
  variant: number;
  outPath: string;
  exportedAt: string;
}

export function formatPostingWindowsLocal(
  windows: CampaignProfile["postingWindows"],
): string[] {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);

  return windows.map((w) => {
    try {
      // Approximate conversion for today's date using tz offset
      const formatInTz = (date: Date, tz: string) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(date);

      const [sh, sm] = w.start.split(":").map(Number);
      const [eh, em] = w.end.split(":").map(Number);
      // Find UTC instant matching w.start in w.tz by binary/iterative offset
      const guess = new Date(`${datePart}T${w.start}:00Z`);
      const tzStr = formatInTz(guess, w.tz);
      const [gh, gm] = tzStr.split(":").map(Number);
      const diffMin = (sh * 60 + sm) - (gh * 60 + gm);
      const startUtc = new Date(guess.getTime() + diffMin * 60_000);
      const durMin = (eh * 60 + em) - (sh * 60 + sm);
      const endUtc = new Date(startUtc.getTime() + durMin * 60_000);

      const localStart = formatInTz(startUtc, localTz);
      const localEnd = formatInTz(endUtc, localTz);
      return `${w.start}-${w.end} ${w.tz} -> ${localStart}-${localEnd} ${localTz}`;
    } catch {
      return `${w.start}-${w.end} ${w.tz}`;
    }
  });
}

export function exportPassingRenders(opts: {
  workspaceDir: string;
  campaign: string;
  profile: CampaignProfile;
  clipIds?: string[];
}): { outDir: string; exported: ExportRecord[]; captionsPath: string } {
  const { workspaceDir, campaign, profile } = opts;
  const targetClipIds =
    opts.clipIds && opts.clipIds.length > 0
      ? opts.clipIds
      : listClipIds(workspaceDir, campaign);

  const outDir = getOutDir(campaign);
  ensureDir(outDir);

  const exported: ExportRecord[] = [];
  const captionBlocks: string[] = [];

  const localWindows = formatPostingWindowsLocal(profile.postingWindows);

  captionBlocks.push(`# ${campaign} Export Checklist & Captions`);
  captionBlocks.push("");
  captionBlocks.push("## Manual Upload Checklist");
  captionBlocks.push(
    "- [ ] Upload **natively** on each platform (do NOT re-upload a downloaded platform copy with another platform's watermark).",
  );
  if (profile.bans.bakedMusic) {
    captionBlocks.push(
      "- [ ] Add **in-app sound/music only** inside TikTok / Reels / Shorts (no baked-in music).",
    );
  }
  captionBlocks.push(
    "- [ ] Post from **one authorized account per platform** only.",
  );
  captionBlocks.push(
    "- [ ] Save/send analytics screenshots proving audience geography if required by the campaign brief.",
  );
  if (localWindows.length > 0) {
    captionBlocks.push("");
    captionBlocks.push("## Posting Windows (Local Time)");
    for (const lw of localWindows) {
      captionBlocks.push(`- ${lw}`);
    }
  }
  captionBlocks.push("");

  const exportedIndexPath = path.join(
    getCampaignWorkspaceDir(workspaceDir, campaign),
    "exported.json",
  );
  const existingExported =
    readJson<Record<string, ExportRecord[]>>(exportedIndexPath) ?? {};

  for (const clipId of targetClipIds) {
    const cDir = getClipDir(workspaceDir, campaign, clipId);
    if (!fs.existsSync(cDir)) continue;

    const files = fs.readdirSync(cDir);
    const reports = files
      .filter((f) => /^report_v\d+\.json$/.test(f))
      .sort();

    const copy = readJson<CopyPlan>(path.join(cDir, "copy.json"));
    const clipExports: ExportRecord[] = [];

    for (const repFile of reports) {
      const report = readJson<ValidationReport>(path.join(cDir, repFile));
      if (!report || !report.passed) continue;

      const destName = `${clipId}_v${report.variant}.mp4`;
      const destPath = path.join(outDir, destName);
      fs.copyFileSync(report.renderPath, destPath);

      const rec: ExportRecord = {
        clipId,
        variant: report.variant,
        outPath: destPath,
        exportedAt: new Date().toISOString(),
      };
      exported.push(rec);
      clipExports.push(rec);
    }

    if (clipExports.length > 0 && copy) {
      existingExported[clipId] = clipExports;
      captionBlocks.push(`---`);
      captionBlocks.push(`## ${clipId}`);
      captionBlocks.push(
        `Files: ${clipExports.map((e) => `\`${path.basename(e.outPath)}\``).join(", ")}`,
      );
      captionBlocks.push("");
      captionBlocks.push("### TikTok");
      captionBlocks.push("```");
      captionBlocks.push(copy.captions.tiktok);
      captionBlocks.push("```");
      captionBlocks.push("");
      captionBlocks.push("### Instagram Reels");
      captionBlocks.push("```");
      captionBlocks.push(copy.captions.instagram);
      captionBlocks.push("```");
      captionBlocks.push("");
      captionBlocks.push("### YouTube Shorts");
      captionBlocks.push(`**Title:** \`${copy.captions.youtubeTitle}\``);
      captionBlocks.push("```");
      captionBlocks.push(copy.captions.youtubeDescription);
      captionBlocks.push("```");
      captionBlocks.push("");
    }
  }

  writeJson(exportedIndexPath, existingExported);
  const captionsPath = path.join(outDir, "captions.md");
  fs.writeFileSync(captionsPath, captionBlocks.join("\n"), "utf8");

  return { outDir, exported, captionsPath };
}

