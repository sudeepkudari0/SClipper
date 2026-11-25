import { z } from "zod";
import type { CampaignProfile } from "../core/profile.js";
import type { LLMProvider, TranscriptSegment } from "../llm/provider.js";
import { buildMomentsPrompt } from "../llm/prompts.js";

const MomentsResponseSchema = z.object({
  moments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      why: z.string(),
      hookIdea: z.string(),
      score: z.number(),
    }),
  ),
});

export interface RankedMoment {
  start: number;
  end: number;
  why: string;
  hookIdea: string;
  score: number;
  transcriptExcerpt: string;
}

export function chunkTranscriptSegments(
  segments: TranscriptSegment[],
  maxCharsPerChunk = 24000, // ~6000 tokens
  overlapSegments = 4,
): TranscriptSegment[][] {
  if (segments.length === 0) return [];
  const chunks: TranscriptSegment[][] = [];
  let idx = 0;

  while (idx < segments.length) {
    const chunk: TranscriptSegment[] = [];
    let charCount = 0;
    let j = idx;
    while (j < segments.length) {
      const lineLen = segments[j].text.length + 24;
      if (chunk.length > 0 && charCount + lineLen > maxCharsPerChunk) break;
      chunk.push(segments[j]);
      charCount += lineLen;
      j++;
    }
    chunks.push(chunk);
    if (j >= segments.length) break;
    idx = Math.max(idx + 1, j - overlapSegments);
  }
  return chunks;
}

function snapToSegments(
  start: number,
  end: number,
  segments: TranscriptSegment[],
  minSec: number,
  maxSec: number,
): { start: number; end: number } {
  if (segments.length === 0) return { start, end };

  let bestStart = start;
  let minStartDist = Infinity;
  for (const s of segments) {
    const d = Math.abs(s.start - start);
    if (d < minStartDist) {
      minStartDist = d;
      bestStart = s.start;
    }
  }

  let bestEnd = end;
  let minEndDist = Infinity;
  for (const s of segments) {
    if (s.end <= bestStart) continue;
    const d = Math.abs(s.end - end);
    if (d < minEndDist) {
      minEndDist = d;
      bestEnd = s.end;
    }
  }

  let dur = bestEnd - bestStart;
  if (dur < minSec) {
    bestEnd = bestStart + minSec;
  } else if (dur > maxSec) {
    bestEnd = bestStart + maxSec;
  }

  return {
    start: Number(bestStart.toFixed(2)),
    end: Number(bestEnd.toFixed(2)),
  };
}

export async function findTopMoments(
  segments: TranscriptSegment[],
  profile: CampaignProfile,
  llm: LLMProvider,
  topN = 10,
): Promise<RankedMoment[]> {
  const chunks = chunkTranscriptSegments(segments);
  const rawCandidates: Array<z.infer<typeof MomentsResponseSchema>["moments"][number]> = [];

  for (const chunk of chunks) {
    const text = chunk
      .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
      .join("\n");
    const prompt = buildMomentsPrompt(text, profile);
    const res = await llm.json("moments", prompt, MomentsResponseSchema);
    rawCandidates.push(...res.moments);
  }

  const snapped: RankedMoment[] = [];
  for (const cand of rawCandidates) {
    if (cand.end <= cand.start) continue;
    const { start, end } = snapToSegments(
      cand.start,
      cand.end,
      segments,
      profile.output.minSeconds,
      profile.output.maxSeconds,
    );
    const excerpt = segments
      .filter((s) => s.end >= start && s.start <= end)
      .map((s) => s.text)
      .join(" ")
      .trim();

    // Deduplicate overlapping moments (IoU > 0.5)
    const overlaps = snapped.some((existing) => {
      const inter = Math.max(0, Math.min(existing.end, end) - Math.max(existing.start, start));
      const union = Math.max(existing.end, end) - Math.min(existing.start, start);
      return union > 0 && inter / union > 0.5;
    });
    if (!overlaps) {
      snapped.push({
        start,
        end,
        why: cand.why,
        hookIdea: cand.hookIdea,
        score: cand.score,
        transcriptExcerpt: excerpt,
      });
    }
  }

  return snapped.sort((a, b) => b.score - a.score).slice(0, topN);
}

