import type { EstimatedHit } from "./audio.js";

export interface WindowSelectionInput {
  durationSec: number;
  rmsPer50ms: number[];
  motionEnergy: number[];
  motionFps?: number;
  sceneCuts: number[];
  estimatedHits: EstimatedHit[];
  minSeconds: number;
  maxSeconds: number;
  targetSeconds: [number, number];
  dropAtSec?: number | null;
  noTrim?: boolean;
}

export interface WindowSelectionResult {
  start: number;
  end: number;
  score: number;
  trimmed: boolean;
}

function sliceAvg(arr: number[], startIdx: number, endIdx: number): number {
  const s = Math.max(0, startIdx);
  const e = Math.min(arr.length, endIdx);
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) sum += arr[i];
  return sum / (e - s);
}

/**
 * Pure function to select the best [start, end] window within [minSeconds, maxSeconds].
 */
export function selectWindow(input: WindowSelectionInput): WindowSelectionResult {
  const {
    durationSec,
    rmsPer50ms,
    motionEnergy,
    motionFps = 8,
    sceneCuts,
    estimatedHits,
    minSeconds,
    maxSeconds,
    targetSeconds,
    dropAtSec = null,
    noTrim = false,
  } = input;

  if (noTrim || durationSec <= 0) {
    return {
      start: 0,
      end: Number(durationSec.toFixed(2)),
      score: 1,
      trimmed: false,
    };
  }

  // Drop-aligned window (e.g., 0-3s buildup, visual peak/drop at dropAtSec, >= minSeconds total)
  if (dropAtSec && dropAtSec > 0 && durationSec >= minSeconds) {
    const maxRms = rmsPer50ms.length > 0 ? Math.max(...rmsPer50ms, 1e-6) : 1;
    const maxMot = motionEnergy.length > 0 ? Math.max(...motionEnergy, 1e-6) : 1;
    const minTail = Math.max(0, minSeconds - dropAtSec);
    const earliestPeak = Math.min(durationSec - minTail, dropAtSec);
    const latestPeak = Math.max(earliestPeak, durationSec - minTail);

    let bestPeak = earliestPeak;
    let bestPeakScore = -Infinity;
    for (let t = earliestPeak; t <= latestPeak + 0.01; t += 0.25) {
      const rIdx = Math.min(rmsPer50ms.length - 1, Math.max(0, Math.floor(t / 0.05)));
      const mIdx = Math.min(motionEnergy.length - 1, Math.max(0, Math.floor(t * motionFps)));
      const rVal = rmsPer50ms.length > 0 ? rmsPer50ms[rIdx] / maxRms : 0;
      const mVal = motionEnergy.length > 0 ? motionEnergy[mIdx] / maxMot : 0;
      const score = 0.65 * mVal + 0.35 * rVal;
      if (score > bestPeakScore) {
        bestPeakScore = score;
        bestPeak = t;
      }
    }

    const desiredLen = Math.min(
      maxSeconds,
      Math.max(minSeconds, (targetSeconds[0] + targetSeconds[1]) / 2),
    );
    let start = Math.max(0, bestPeak - dropAtSec);
    let end = Math.min(durationSec, start + desiredLen);
    if (end - start < minSeconds) {
      start = Math.max(0, end - minSeconds);
    }

    return {
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      score: Number(Math.max(0, bestPeakScore).toFixed(3)),
      trimmed: start > 0.05 || end < durationSec - 0.05,
    };
  }

  // Case 1: Source is already within maxSeconds -> trim dead lead-in and dead tail
  if (durationSec <= maxSeconds) {
    if (durationSec <= minSeconds) {
      return {
        start: 0,
        end: Number(durationSec.toFixed(2)),
        score: 1,
        trimmed: false,
      };
    }

    // Find first and last active time from hits or motion bursts
    let firstActive = 0;
    let lastActive = durationSec;

    const motionMean =
      motionEnergy.length > 0
        ? motionEnergy.reduce((a, b) => a + b, 0) / motionEnergy.length
        : 0;
    const motionThresh = Math.max(0.005, motionMean * 0.6);

    const activeTimes: number[] = estimatedHits.map((h) => h.time);
    for (let i = 0; i < motionEnergy.length; i++) {
      if (motionEnergy[i] > motionThresh) {
        activeTimes.push(i / motionFps);
      }
    }

    if (activeTimes.length > 0) {
      firstActive = Math.min(...activeTimes);
      lastActive = Math.max(...activeTimes);
    }

    let start = Math.max(0, firstActive - 0.3);
    let end = Math.min(durationSec, lastActive + 0.8);

    // Ensure at least minSeconds
    if (end - start < minSeconds) {
      const deficit = minSeconds - (end - start);
      start = Math.max(0, start - deficit / 2);
      end = Math.min(durationSec, start + minSeconds);
      if (end - start < minSeconds) {
        start = Math.max(0, end - minSeconds);
      }
    }

    const trimmed = start > 0.05 || end < durationSec - 0.05;
    return {
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      score: 1,
      trimmed,
    };
  }

  // Case 2: Source is longer than maxSeconds -> slide window & score
  const [targetMin, targetMax] = targetSeconds;
  const candidateLengths = [
    Math.min(maxSeconds, Math.max(minSeconds, (targetMin + targetMax) / 2)),
    Math.min(maxSeconds, Math.max(minSeconds, targetMax)),
    Math.min(maxSeconds, Math.max(minSeconds, targetMin)),
  ];

  const maxRms = rmsPer50ms.length > 0 ? Math.max(...rmsPer50ms, 1e-6) : 1;
  const maxMot = motionEnergy.length > 0 ? Math.max(...motionEnergy, 1e-6) : 1;

  let bestStart = 0;
  let bestEnd = Math.min(durationSec, candidateLengths[0]);
  let bestScore = -Infinity;

  for (const winLen of candidateLengths) {
    const step = 0.5;
    for (let s = 0; s + winLen <= durationSec + 0.01; s += step) {
      const e = Math.min(durationSec, s + winLen);
      const audioScore =
        rmsPer50ms.length > 0
          ? sliceAvg(
              rmsPer50ms,
              Math.floor(s / 0.05),
              Math.ceil(e / 0.05),
            ) / maxRms
          : 0;
      const motionScore =
        motionEnergy.length > 0
          ? sliceAvg(
              motionEnergy,
              Math.floor(s * motionFps),
              Math.ceil(e * motionFps),
            ) / maxMot
          : 0;

      // Penalize cutting right near a scene cut (mid-action boundary)
      let cutPenalty = 0;
      for (const cut of sceneCuts) {
        if (Math.abs(cut - s) < 0.4 || Math.abs(cut - e) < 0.4) {
          cutPenalty += 0.15;
        }
      }

      const hitsInWindow = estimatedHits.filter(
        (h) => h.time >= s && h.time <= e,
      ).length;
      const hitBonus = Math.min(0.4, hitsInWindow * 0.05);

      const score = 0.5 * audioScore + 0.5 * motionScore + hitBonus - cutPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestStart = s;
        bestEnd = e;
      }
    }
  }

  return {
    start: Number(bestStart.toFixed(2)),
    end: Number(bestEnd.toFixed(2)),
    score: Number(Math.max(0, bestScore).toFixed(3)),
    trimmed: true,
  };
}

