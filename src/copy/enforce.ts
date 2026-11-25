export interface EnforceCaptionOptions {
  requiredHashtags: string[];
  requiredMentions: string[];
  requiredPhrases?: string[];
  extraHashtags: string[];
  maxHashtags: number;
  limit: number;
  forbiddenWords: string[];
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripForbiddenWords(
  text: string,
  forbiddenWords: string[],
): string {
  let out = text;
  for (const word of forbiddenWords) {
    const trimmed = word.trim();
    if (!trimmed) continue;
    const re = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "gi");
    out = out.replace(re, "").replace(/\s{2,}/g, " ");
  }
  return out.trim();
}

export function enforceCaption(
  rawText: string,
  opts: EnforceCaptionOptions,
): string {
  let text = stripForbiddenWords(rawText, opts.forbiddenWords);

  // Normalize required hashtags case-sensitively (replace wrong-case matches)
  for (const reqTag of opts.requiredHashtags) {
    const re = new RegExp(`(^|\\s)(${escapeRegExp(reqTag)})(?=\\s|$)`, "gi");
    if (re.test(text)) {
      text = text.replace(re, `$1${reqTag}`);
    } else {
      text = `${text} ${reqTag}`.trim();
    }
  }

  // Normalize required mentions case-sensitively
  for (const reqMention of opts.requiredMentions) {
    const re = new RegExp(
      `(^|\\s)(${escapeRegExp(reqMention)})(?=\\s|$)`,
      "gi",
    );
    if (re.test(text)) {
      text = text.replace(re, `$1${reqMention}`);
    } else {
      text = `${text} ${reqMention}`.trim();
    }
  }

  // Ensure required phrases (e.g. song credits) are present
  for (const phrase of opts.requiredPhrases ?? []) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    if (!text.includes(trimmed)) {
      text = `${text} | ${trimmed}`.trim();
    }
  }

  // Enforce maxHashtags: keep requiredHashtags first, then extraHashtags, then any others
  const allFoundTags = text.match(/#[A-Za-z0-9_]+/g) ?? [];
  const reqSet = new Set(opts.requiredHashtags);
  const keptTags: string[] = [...opts.requiredHashtags];

  for (const extra of opts.extraHashtags) {
    if (keptTags.length >= opts.maxHashtags) break;
    if (!keptTags.includes(extra)) {
      keptTags.push(extra);
    }
  }

  for (const found of allFoundTags) {
    if (keptTags.length >= opts.maxHashtags) break;
    if (!reqSet.has(found) && !keptTags.includes(found)) {
      keptTags.push(found);
    }
  }

  // Remove all hashtags from body, then append keptTags cleanly
  let bodyWithoutTags = text
    .replace(/#[A-Za-z0-9_]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const tagSuffix = keptTags.slice(0, opts.maxHashtags).join(" ");
  let combined = [bodyWithoutTags, tagSuffix].filter(Boolean).join(" ").trim();

  // Enforce character limit while preserving required tags, mentions, and phrases
  if (combined.length > opts.limit) {
    const mustKeep = [
      ...opts.requiredMentions,
      ...(opts.requiredPhrases ?? []),
      ...opts.requiredHashtags,
    ]
      .filter((t) => t.trim().length > 0 && (!bodyWithoutTags.includes(t) || t.startsWith("#")))
      .join(" ");
    const availableForBody = Math.max(0, opts.limit - mustKeep.length - 4);
    const trimmedBody =
      availableForBody > 0
        ? `${bodyWithoutTags.slice(0, availableForBody).trim()}...`
        : "";
    combined = [trimmedBody, mustKeep].filter(Boolean).join(" ").trim();
    if (combined.length > opts.limit) {
      combined = combined.slice(0, opts.limit).trim();
    }
  }

  return combined;
}

