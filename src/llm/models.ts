import type { CampaignProfile } from "../core/profile.js";
import type { LLMTask } from "./provider.js";

export const ALL_TASKS: LLMTask[] = [
  "plan",
  "moments",
  "draft",
  "vision",
  "transcribe",
];

export const BUILTIN_DEFAULT_MODELS: Record<LLMTask, string> = {
  plan: "ministral-8b-2512",
  moments: "ministral-8b-2512",
  draft: "ministral-8b-2512",
  vision: "ministral-8b-2512",
  transcribe: "voxtral-mini-latest",
};

export type CliModelOverrides = Partial<Record<LLMTask, string>>;

/**
 * Resolution order:
 * 1. CLI flag --model-<task>
 * 2. Campaign profile.models.<task>
 * 3. Env MISTRAL_MODEL_<TASK>
 * 4. Env MISTRAL_MODEL
 * 5. Built-in default
 */
export function resolveTaskModel(
  task: LLMTask,
  opts: {
    cliOverrides?: CliModelOverrides;
    profile?: CampaignProfile;
  } = {},
): string {
  const cliVal = opts.cliOverrides?.[task]?.trim();
  if (cliVal) return cliVal;

  const profileVal = opts.profile?.models?.[task]?.trim();
  if (profileVal) return profileVal;

  const envTaskKey = `MISTRAL_MODEL_${task.toUpperCase()}`;
  const envTaskVal = process.env[envTaskKey]?.trim();
  if (envTaskVal) return envTaskVal;

  const envGlobal = process.env.MISTRAL_MODEL?.trim();
  if (envGlobal) return envGlobal;

  return BUILTIN_DEFAULT_MODELS[task];
}

export function resolveAllTaskModels(opts: {
  cliOverrides?: CliModelOverrides;
  profile?: CampaignProfile;
} = {}): Record<LLMTask, string> {
  return {
    plan: resolveTaskModel("plan", opts),
    moments: resolveTaskModel("moments", opts),
    draft: resolveTaskModel("draft", opts),
    vision: resolveTaskModel("vision", opts),
    transcribe: resolveTaskModel("transcribe", opts),
  };
}

