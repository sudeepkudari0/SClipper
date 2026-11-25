import type { CampaignProfile } from "../core/profile.js";

export interface PlanFacts {
  clipId: string;
  durationSec: number;
  windowStartSec: number;
  windowEndSec: number;
  estimatedHits: number;
  hitConfidence: number;
  rallyLengthSec: number;
  peakTimeSec: number;
  frameDescription?: string;
  transcriptExcerpt?: string;
  userContext?: string;
}

export function buildPlanPrompt(
  facts: PlanFacts,
  profile: CampaignProfile,
): string {
  return `Generate social media hooks and platform captions for a vertical short-form video clip.

CAMPAIGN PROFILE:
- Name: ${profile.name}
- Niche: ${profile.niche}
- Voice tone: ${profile.voice.tone}
- Voice rules:
${profile.voice.rules.map((r) => `  - ${r}`).join("\n") || "  - Keep it positive and factual."}
- Hook max chars: ${profile.text.hook.maxChars}
- Required hashtags (case-sensitive): ${profile.captions.requiredHashtags.join(", ") || "none"}
- Required mentions: ${profile.captions.requiredMentions.join(", ") || "none"}
- Platform-specific mentions: ${JSON.stringify(profile.captions.platformMentions)}
- Required credit phrases: ${profile.captions.requiredPhrases.join(", ") || "none"}
- Extra hashtags: ${profile.captions.extraHashtags.join(", ") || "none"}
- Max hashtags: ${profile.captions.maxHashtags}
- Forbidden words: ${profile.captions.forbiddenWords.join(", ") || "none"}

MEASURED FACTS (use ONLY these facts; NEVER invent scores, player names, or stats):
${JSON.stringify(facts, null, 2)}

REQUIREMENTS:
1. Return JSON with shape:
   {
     "hooks": [5 strings],
     "captions": {
       "tiktok": string,
       "instagram": string,
       "youtubeTitle": string,
       "youtubeDescription": string
     }
   }
2. Each hook in "hooks" MUST be <= ${profile.text.hook.maxChars} characters, and the 5 hooks should vary in style: curiosity, stakes, count-based, direct instruction, and punchy reaction.
3. Only include digits/numbers in hooks if those exact numbers appear in MEASURED FACTS.
4. Include required hashtags and mentions in captions exactly as written.`;
}

export function buildMomentsPrompt(
  transcriptChunk: string,
  profile: CampaignProfile,
): string {
  return `You are finding the best short-form vertical clip moments from a long-form transcript.

CAMPAIGN NICHE: ${profile.niche}
VOICE TONE: ${profile.voice.tone}
DURATION BOUNDS: ${profile.output.minSeconds}s to ${profile.output.maxSeconds}s (target ${profile.output.targetSeconds[0]}-${profile.output.targetSeconds[1]}s)

TRANSCRIPT CHUNK (timestamps in seconds):
${transcriptChunk}

Return JSON:
{
  "moments": [
    {
      "start": number,
      "end": number,
      "why": string,
      "hookIdea": string,
      "score": number
    }
  ]
}
Keep each moment duration between ${profile.output.minSeconds} and ${profile.output.maxSeconds} seconds. Score 0-100.`;
}

export function buildVisionPrompt(): string {
  return "Describe the visible action in these frames neutrally and concisely (2-3 sentences). Do NOT identify or name any person.";
}

export function buildDraftProfilePrompt(
  name: string,
  briefText: string,
): string {
  return `Extract a campaign profile YAML-compatible JSON object for campaign "${name}" from the following campaign brief.

BRIEF:
${briefText}

Return JSON with fields:
{
  "name": "${name}",
  "niche": string,
  "output": { "minSeconds": number, "maxSeconds": number, "targetSeconds": [number, number], "audio": "keep" | "mute" },
  "captions": {
    "requiredHashtags": string[],
    "requiredMentions": string[],
    "extraHashtags": string[],
    "maxHashtags": number,
    "forbiddenWords": string[]
  },
  "voice": { "tone": string, "rules": string[] },
  "bans": { "aiVoiceover": boolean, "aiFootage": boolean, "bakedMusic": boolean },
  "postingWindows": [{ "tz": string, "start": "HH:MM", "end": "HH:MM" }],
  "fallbackHooks": string[]
}`;
}

