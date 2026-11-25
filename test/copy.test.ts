import { describe, expect, it } from "vitest";
import { CampaignProfileSchema } from "../src/core/profile.js";
import { enforceCaption } from "../src/copy/enforce.js";
import { buildFallbackCopy } from "../src/copy/fallback.js";
import { filterValidHooks, isHookGrounded } from "../src/copy/grounding.js";
import type { PlanFacts } from "../src/llm/prompts.js";
import { validateCopyAgainstProfile } from "../src/validate/checks.js";

const sampleFacts: PlanFacts = {
  clipId: "test-1234",
  durationSec: 18.4,
  windowStartSec: 1.2,
  windowEndSec: 15.2,
  estimatedHits: 14,
  hitConfidence: 0.85,
  rallyLengthSec: 14,
  peakTimeSec: 9.5,
  userContext: "Semifinal match",
};

describe("copy enforcement", () => {
  it("enforces case-sensitive hashtags, mentions, maxHashtags, forbidden words, and length limits", () => {
    const out = enforceCaption(
      "Amazing rally! #cnplclips #extra1 #extra2 #extra3 #extra4 #extra5 #extra6 badword",
      {
        requiredHashtags: ["#CNPLclips"],
        requiredMentions: ["@officialcnpl"],
        extraHashtags: ["#pickleball"],
        maxHashtags: 4,
        limit: 120,
        forbiddenWords: ["badword"],
      },
    );

    expect(out).toContain("#CNPLclips");
    expect(out).not.toContain("#cnplclips");
    expect(out).toContain("@officialcnpl");
    expect(out.toLowerCase()).not.toContain("badword");
    const tags = out.match(/#[A-Za-z0-9_]+/g) ?? [];
    expect(tags.length).toBeLessThanOrEqual(4);
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe("hook grounding and length limits", () => {
  it("rejects fake digits not present in facts and enforces maxChars", () => {
    expect(isHookGrounded("14 shots. Watch the finish.", sampleFacts)).toBe(true);
    expect(isHookGrounded("99-0 comeback! 25 shots!", sampleFacts)).toBe(false);

    const filtered = filterValidHooks(
      [
        "14 shots. Watch the finish.",
        "99-0 blowout!",
        "This hook is way too long to fit inside thirty eight characters limit",
        "Wait for the finish.",
      ],
      sampleFacts,
      38,
      [],
    );

    expect(filtered).toEqual([
      "14 shots. Watch the finish.",
      "Wait for the finish.",
    ]);
  });

  it("enforces platform-specific mentions and required credit phrases", () => {
    const profile = CampaignProfileSchema.parse({
      name: "naya-yeira",
      captions: {
        platformMentions: {
          tiktok: ["@nayayeiraofficial"],
          instagram: ["@nayayeira"],
        },
        requiredPhrases: ["Hit Record — Naya Yeira"],
      },
    });
    const copy = buildFallbackCopy(sampleFacts, profile);
    expect(copy.captions.tiktok).toContain("@nayayeiraofficial");
    expect(copy.captions.tiktok).toContain("Hit Record — Naya Yeira");
    expect(copy.captions.instagram).toContain("@nayayeira");
    expect(copy.captions.instagram).toContain("Hit Record — Naya Yeira");

    const checks = validateCopyAgainstProfile(copy, profile);
    expect(checks.every((c) => c.passed)).toBe(true);
  });
});

