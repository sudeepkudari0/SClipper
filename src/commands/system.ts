import { execa } from "execa";
import pc from "picocolors";
import { detectVideoEncoder } from "../core/encoder.js";
import { loadEnv } from "../core/env.js";
import {
  loadCampaignProfile,
  printCampaignHeader,
  resolveCampaignName,
  type CampaignProfile,
} from "../core/profile.js";
import { MistralClient } from "../llm/mistral.js";
import { ALL_TASKS, resolveAllTaskModels } from "../llm/models.js";
import { extractCliModelOverrides, type GlobalOptions } from "./context.js";
import path from "node:path";

export async function doctorCommand(opts: GlobalOptions): Promise<void> {
  loadEnv();
  const workspaceDir = path.resolve(opts.workspace || "./workspace");
  let campaign: string | null = null;
  let profile: CampaignProfile | undefined;

  try {
    campaign = resolveCampaignName({ campaignOpt: opts.campaign, workspaceDir });
    profile = loadCampaignProfile(campaign).profile;
    printCampaignHeader(campaign, Boolean(opts.json));
  } catch {
    if (!opts.json) {
      console.log(pc.bold(pc.cyan("Campaign: (none)")));
    }
  }

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // ffmpeg & ffprobe
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const res = await execa(bin, ["-version"], { reject: false });
    checks.push({
      name: bin,
      ok: res.exitCode === 0,
      detail: res.exitCode === 0 ? res.stdout.split("\n")[0] : "not found on PATH",
    });
  }

  // encoder
  const encoder = await detectVideoEncoder(true);
  checks.push({
    name: "encoder",
    ok: true,
    detail: `${encoder} (real 1s test encode)`,
  });

  // fonts
  const fcRes = await execa("fc-match", ["sans:bold", "-f", "%{family} (%{file})"], {
    reject: false,
  });
  checks.push({
    name: "fonts",
    ok: fcRes.exitCode === 0 && fcRes.stdout.trim().length > 0,
    detail: fcRes.exitCode === 0 ? fcRes.stdout.trim() : "fc-match failed",
  });

  // Mistral API key & models
  const apiKey = process.env.MISTRAL_API_KEY ?? "";
  checks.push({
    name: "MISTRAL_API_KEY",
    ok: apiKey.length > 0,
    detail: apiKey.length > 0 ? "set (hidden)" : "NOT SET — add to .env",
  });

  const modelMap = resolveAllTaskModels({
    cliOverrides: extractCliModelOverrides(opts),
    profile,
  });

  if (apiKey.length > 0) {
    const client = new MistralClient({
      profile,
      cliOverrides: extractCliModelOverrides(opts),
    });
    try {
      const available = await client.listModels();
      const byId = new Map(available.map((m) => [m.id, m]));

      for (const task of ALL_TASKS) {
        const id = modelMap[task];
        const info = byId.get(id);
        if (!info) {
          checks.push({
            name: `model:${task}`,
            ok: false,
            detail: `"${id}" not found in GET /v1/models. Set MISTRAL_MODEL_${task.toUpperCase()} or run \`clipper models\`.`,
          });
          continue;
        }

        if (task === "vision" && info.capabilities && info.capabilities.vision === false) {
          checks.push({
            name: `model:${task}`,
            ok: false,
            detail: `"${id}" does not report vision capability. Set MISTRAL_MODEL_VISION to a vision-capable model.`,
          });
          continue;
        }

        if (task === "plan" || task === "moments" || task === "draft") {
          try {
            await client.testChatModel(id);
            checks.push({ name: `model:${task}`, ok: true, detail: `${id} (verified)` });
          } catch (e) {
            checks.push({
              name: `model:${task}`,
              ok: false,
              detail: `${id} test call failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        } else {
          checks.push({ name: `model:${task}`, ok: true, detail: `${id} (exists)` });
        }
      }
    } catch (e) {
      checks.push({
        name: "mistral:models",
        ok: false,
        detail: `Failed to query /v1/models: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ campaign, modelMap, checks }, null, 2));
  } else {
    for (const c of checks) {
      const badge = c.ok ? pc.green("PASS") : pc.red("FAIL");
      console.log(`  [${badge}] ${c.name}: ${c.detail}`);
    }
  }

  if (checks.some((c) => !c.ok)) {
    process.exitCode = 1;
  }
}

export async function modelsCommand(opts: GlobalOptions): Promise<void> {
  loadEnv();
  const workspaceDir = path.resolve(opts.workspace || "./workspace");
  let campaign = "(none)";
  let profile: CampaignProfile | undefined;

  try {
    campaign = resolveCampaignName({ campaignOpt: opts.campaign, workspaceDir });
    profile = loadCampaignProfile(campaign).profile;
  } catch {
    // optional for models listing
  }
  printCampaignHeader(campaign, Boolean(opts.json));

  const modelMap = resolveAllTaskModels({
    cliOverrides: extractCliModelOverrides(opts),
    profile,
  });

  const client = new MistralClient({
    profile,
    cliOverrides: extractCliModelOverrides(opts),
  });
  const models = await client.listModels();

  if (opts.json) {
    console.log(JSON.stringify({ campaign, taskModels: modelMap, models }, null, 2));
    return;
  }

  console.log(pc.bold("\nConfigured task-to-model map:"));
  for (const task of ALL_TASKS) {
    console.log(`  ${task.padEnd(12)} -> ${pc.cyan(modelMap[task])}`);
  }

  console.log(pc.bold(`\nAvailable Mistral models (${models.length}):`));
  for (const m of models) {
    const caps = m.capabilities
      ? Object.entries(m.capabilities)
          .filter(([, v]) => v === true)
          .map(([k]) => k)
          .join(", ")
      : "";
    console.log(`  - ${m.id}${caps ? pc.dim(` [${caps}]`) : ""}`);
  }
}

