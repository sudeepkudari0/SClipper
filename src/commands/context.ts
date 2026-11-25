import path from "node:path";
import { loadEnv } from "../core/env.js";
import {
  loadCampaignProfile,
  printCampaignHeader,
  resolveCampaignName,
  type CampaignProfile,
} from "../core/profile.js";
import { MistralClient } from "../llm/mistral.js";
import type { CliModelOverrides } from "../llm/models.js";

export interface GlobalOptions {
  campaign?: string;
  workspace: string;
  json?: boolean;
  modelPlan?: string;
  modelMoments?: string;
  modelDraft?: string;
  modelVision?: string;
  modelTranscribe?: string;
}

export interface CommandContext {
  campaign: string;
  profile: CampaignProfile;
  campaignDir: string;
  workspaceDir: string;
  json: boolean;
  cliModelOverrides: CliModelOverrides;
  llm: MistralClient;
}

export function extractCliModelOverrides(opts: GlobalOptions): CliModelOverrides {
  return {
    plan: opts.modelPlan,
    moments: opts.modelMoments,
    draft: opts.modelDraft,
    vision: opts.modelVision,
    transcribe: opts.modelTranscribe,
  };
}

export function resolveCommandContext(opts: GlobalOptions): CommandContext {
  loadEnv();
  const workspaceDir = path.resolve(opts.workspace || "./workspace");
  const campaign = resolveCampaignName({
    campaignOpt: opts.campaign,
    workspaceDir,
  });
  const { profile, campaignDir } = loadCampaignProfile(campaign);
  const json = Boolean(opts.json);
  printCampaignHeader(campaign, json);

  const cliModelOverrides = extractCliModelOverrides(opts);
  const llm = new MistralClient({
    profile,
    cliOverrides: cliModelOverrides,
  });

  return {
    campaign,
    profile,
    campaignDir,
    workspaceDir,
    json,
    cliModelOverrides,
    llm,
  };
}

