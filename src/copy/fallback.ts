import type { CampaignProfile } from "../core/profile.js";
import type { PlanFacts } from "../llm/prompts.js";
import { enforceCaption } from "./enforce.js";
import { filterValidHooks } from "./grounding.js";

export interface CopyPlan {
  clipId: string;
  usedLlm: boolean;
  hooks: string[];
  captions: {
    tiktok: string;
    instagram: string;
    youtubeTitle: string;
    youtubeDescription: string;
  };
  facts: PlanFacts;
  plannedAt: string;
}

export function renderFallbackHookTemplate(
  template: string,
  facts: PlanFacts,
): string {
  return template
    .replaceAll("{hits}", String(facts.estimatedHits))
    .replaceAll("{duration}", String(Math.round(facts.rallyLengthSec)))
    .replaceAll("{rallyLength}", String(Math.round(facts.rallyLengthSec)));
}

export function buildFallbackCopy(
  facts: PlanFacts,
  profile: CampaignProfile,
): CopyPlan {
  const rawHooks = profile.fallbackHooks.map((tpl) =>
    renderFallbackHookTemplate(tpl, facts),
  );
  // Ensure at least one digit-free safe hook exists
  rawHooks.push("Wait for the finish.", "Watch until the end.");

  const validHooks = filterValidHooks(
    rawHooks,
    facts,
    profile.text.hook.maxChars,
    profile.captions.forbiddenWords,
  );

  const baseDesc =
    facts.userContext?.trim() ||
    facts.frameDescription?.trim() ||
    `${profile.niche.replace(/-/g, " ")} highlight clip.`;

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
    usedLlm: false,
    hooks: validHooks.length > 0 ? validHooks : ["Watch this."],
    captions: {
      tiktok: enforceFor(baseDesc, profile.captions.limits.tiktok, "tiktok"),
      instagram: enforceFor(baseDesc, profile.captions.limits.instagram, "instagram"),
      youtubeTitle: enforceFor(
        validHooks[0] ?? baseDesc,
        profile.captions.limits.youtubeTitle,
        "youtubeTitle",
      ),
      youtubeDescription: enforceFor(
        baseDesc,
        profile.captions.limits.youtubeDescription,
        "youtubeDescription",
      ),
    },
    facts,
    plannedAt: new Date().toISOString(),
  };
}

