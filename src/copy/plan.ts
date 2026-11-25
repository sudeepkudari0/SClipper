import { z } from "zod";
import type { CampaignProfile } from "../core/profile.js";
import type { LLMProvider } from "../llm/provider.js";
import { buildPlanPrompt, type PlanFacts } from "../llm/prompts.js";
import { enforceCaption } from "./enforce.js";
import { buildFallbackCopy, type CopyPlan } from "./fallback.js";
import { filterValidHooks } from "./grounding.js";

const LlmPlanSchema = z.object({
  hooks: z.array(z.string()).min(1),
  captions: z.object({
    tiktok: z.string(),
    instagram: z.string(),
    youtubeTitle: z.string(),
    youtubeDescription: z.string(),
  }),
});

export async function generateCopyPlan(
  facts: PlanFacts,
  profile: CampaignProfile,
  llm: LLMProvider | null,
  opts: { noLlm?: boolean } = {},
): Promise<CopyPlan> {
  if (opts.noLlm || !llm) {
    return buildFallbackCopy(facts, profile);
  }

  try {
    const prompt = buildPlanPrompt(facts, profile);
    const res = await llm.json("plan", prompt, LlmPlanSchema, {
      temperature: 0.7,
    });

    const fallback = buildFallbackCopy(facts, profile);
    let hooks = filterValidHooks(
      res.hooks,
      facts,
      profile.text.hook.maxChars,
      profile.captions.forbiddenWords,
    );

    if (hooks.length === 0) {
      hooks = fallback.hooks;
    }

    const enforceFor = (text: string, limit: number, platform: string) =>
      enforceCaption(text, {
        requiredHashtags: profile.captions.requiredHashtags,
        requiredMentions: [
          ...profile.captions.requiredMentions,
          ...(profile.captions.platformMentions[platform] ?? []),
        ],
        requiredPhrases:
          platform === "youtubeTitle" ? [] : profile.captions.requiredPhrases,
        extraHashtags: profile.captions.extraHashtags,
        maxHashtags: profile.captions.maxHashtags,
        limit,
        forbiddenWords: profile.captions.forbiddenWords,
      });

    return {
      clipId: facts.clipId,
      usedLlm: true,
      hooks,
      captions: {
        tiktok: enforceFor(res.captions.tiktok, profile.captions.limits.tiktok, "tiktok"),
        instagram: enforceFor(
          res.captions.instagram,
          profile.captions.limits.instagram,
          "instagram",
        ),
        youtubeTitle: enforceFor(
          res.captions.youtubeTitle,
          profile.captions.limits.youtubeTitle,
          "youtubeTitle",
        ),
        youtubeDescription: enforceFor(
          res.captions.youtubeDescription,
          profile.captions.limits.youtubeDescription,
          "youtubeDescription",
        ),
      },
      facts,
      plannedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`LLM plan failed, falling back to templates: ${msg}`);
    return buildFallbackCopy(facts, profile);
  }
}

