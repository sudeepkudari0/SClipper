import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import pc from "picocolors";
import { z } from "zod";
import { loadEnv } from "../core/env.js";
import {
  CampaignProfileSchema,
  getCampaignsDir,
  listAvailableCampaigns,
  printCampaignHeader,
} from "../core/profile.js";
import { ensureDir, getActiveCampaignFile } from "../core/workspace.js";
import { MistralClient } from "../llm/mistral.js";
import { buildDraftProfilePrompt } from "../llm/prompts.js";
import { extractCliModelOverrides, type GlobalOptions } from "./context.js";

export async function campaignInitCommand(
  name: string,
  opts: GlobalOptions,
): Promise<void> {
  printCampaignHeader(name, Boolean(opts.json));
  const campaignDir = path.join(getCampaignsDir(), name);
  const assetsDir = path.join(campaignDir, "assets");
  const profilePath = path.join(campaignDir, "profile.yaml");

  if (fs.existsSync(profilePath)) {
    throw new Error(`Campaign "${name}" already exists at ${profilePath}`);
  }

  ensureDir(assetsDir);
  const defaultProfile = CampaignProfileSchema.parse({
    name,
    sources: { localDir: `./sources/${name}` },
  });

  fs.writeFileSync(profilePath, YAML.stringify(defaultProfile), "utf8");
  fs.writeFileSync(
    path.join(campaignDir, "README.md"),
    `# ${name} Campaign\n\nEdit \`profile.yaml\` and place watermark assets in \`assets/\`.\n`,
    "utf8",
  );

  if (opts.json) {
    console.log(JSON.stringify({ campaign: name, profilePath, assetsDir }, null, 2));
  } else {
    console.log(pc.green(`Initialized campaign "${name}" at ${profilePath}`));
  }
}

export async function campaignDraftCommand(
  cmdOpts: { brief: string; name: string },
  opts: GlobalOptions,
): Promise<void> {
  loadEnv();
  printCampaignHeader(cmdOpts.name, Boolean(opts.json));
  if (!fs.existsSync(cmdOpts.brief)) {
    throw new Error(`Brief file not found: ${cmdOpts.brief}`);
  }

  const ext = path.extname(cmdOpts.brief).toLowerCase();
  let briefText = "";
  if (ext === ".pdf") {
    // Extract text via pdftotext if installed, else fail clearly
    const { execa } = await import("execa");
    const res = await execa("pdftotext", [cmdOpts.brief, "-"], { reject: false });
    if (res.exitCode !== 0) {
      throw new Error(
        "Reading .pdf briefs requires `pdftotext` (poppler) on PATH, or pass a .txt/.md brief.",
      );
    }
    briefText = res.stdout;
  } else {
    briefText = fs.readFileSync(cmdOpts.brief, "utf8");
  }

  const client = new MistralClient({
    cliOverrides: extractCliModelOverrides(opts),
  });
  const drafted = await client.json(
    "draft",
    buildDraftProfilePrompt(cmdOpts.name, briefText),
    z.record(z.string(), z.unknown()),
    { temperature: 0.2 },
  );

  const merged = CampaignProfileSchema.parse({
    ...drafted,
    name: cmdOpts.name,
    sources: { localDir: `./sources/${cmdOpts.name}` },
  });

  const campaignDir = path.join(getCampaignsDir(), cmdOpts.name);
  ensureDir(path.join(campaignDir, "assets"));
  const profilePath = path.join(campaignDir, "profile.yaml");
  fs.writeFileSync(profilePath, YAML.stringify(merged), "utf8");

  if (opts.json) {
    console.log(JSON.stringify({ campaign: cmdOpts.name, profilePath, profile: merged }, null, 2));
  } else {
    console.log(pc.green(`Drafted profile for "${cmdOpts.name}" at ${profilePath}`));
    console.log(pc.yellow("Review the generated profile.yaml before running."));
  }
}

export async function useCommand(
  name: string,
  opts: GlobalOptions,
): Promise<void> {
  const available = listAvailableCampaigns();
  if (!available.includes(name)) {
    throw new Error(
      `Campaign "${name}" does not exist. Available: ${available.join(", ") || "(none)"}`,
    );
  }
  const workspaceDir = path.resolve(opts.workspace || "./workspace");
  ensureDir(workspaceDir);
  fs.writeFileSync(getActiveCampaignFile(workspaceDir), `${name}\n`, "utf8");
  printCampaignHeader(name, Boolean(opts.json));
  if (opts.json) {
    console.log(JSON.stringify({ activeCampaign: name }, null, 2));
  } else {
    console.log(pc.green(`Active campaign set to "${name}".`));
  }
}

