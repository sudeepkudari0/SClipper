import type { PlanFacts } from "../llm/prompts.js";
import { stripForbiddenWords } from "./enforce.js";

/**
 * Collect all numeric tokens present in measured facts and user-supplied context.
 */
export function extractFactNumbers(facts: PlanFacts): Set<string> {
  const nums = new Set<string>();
  const addFromValue = (val: unknown) => {
    if (typeof val === "number" && Number.isFinite(val)) {
      nums.add(String(val));
      nums.add(String(Math.round(val)));
      nums.add(val.toFixed(1));
    } else if (typeof val === "string") {
      const matches = val.match(/\d+(?:\.\d+)?/g) ?? [];
      for (const m of matches) {
        nums.add(m);
        const n = Number(m);
        if (Number.isFinite(n)) nums.add(String(Math.round(n)));
      }
    }
  };

  addFromValue(facts.durationSec);
  addFromValue(facts.windowStartSec);
  addFromValue(facts.windowEndSec);
  addFromValue(facts.estimatedHits);
  addFromValue(facts.rallyLengthSec);
  addFromValue(facts.peakTimeSec);
  if (facts.userContext) addFromValue(facts.userContext);
  if (facts.frameDescription) addFromValue(facts.frameDescription);
  if (facts.transcriptExcerpt) addFromValue(facts.transcriptExcerpt);

  return nums;
}

/**
 * Grounding check: digits in a hook are allowed ONLY if that number exists in the facts.
 */
export function isHookGrounded(hook: string, facts: PlanFacts): boolean {
  const digitsInHook = hook.match(/\d+(?:\.\d+)?/g);
  if (!digitsInHook || digitsInHook.length === 0) return true;
  const allowed = extractFactNumbers(facts);
  return digitsInHook.every((d) => allowed.has(d));
}

export function filterValidHooks(
  hooks: string[],
  facts: PlanFacts,
  maxChars: number,
  forbiddenWords: string[],
): string[] {
  const valid: string[] = [];
  const seen = new Set<string>();

  for (const raw of hooks) {
    const cleaned = stripForbiddenWords(raw, forbiddenWords).trim();
    if (!cleaned) continue;
    if (cleaned.length > maxChars) continue;
    if (!isHookGrounded(cleaned, facts)) continue;
    if (seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    valid.push(cleaned);
  }
  return valid;
}

