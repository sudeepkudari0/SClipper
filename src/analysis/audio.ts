import { pipeFfmpegRaw } from "../core/ffmpeg.js";

export interface EstimatedHit {
  time: number;
  strength: number;
}

export interface AudioAnalysis {
  sampleRate: number;
  frameDurationSec: number;
  rmsPer50ms: number[];
  /** Estimated audio onsets/hits (heuristic, not ground truth) */
  estimatedHits: EstimatedHit[];
  /** Confidence in 0..1; low when signal is noisy or onsets are irregular */
  hitConfidence: number;
  peakTimeSec: number;
  meanRms: number;
}

export function analyzeAudioFromPcm(
  samples: Float32Array,
  sampleRate = 16000,
): AudioAnalysis {
  const frameDurationSec = 0.05;
  const frameSize = Math.floor(sampleRate * frameDurationSec); // 800 at 16kHz
  const numFrames = Math.floor(samples.length / frameSize);
  const rmsPer50ms: number[] = new Array(numFrames);

  let maxRms = 0;
  let maxRmsIdx = 0;
  let sumRms = 0;

  for (let i = 0; i < numFrames; i++) {
    let sumSq = 0;
    const offset = i * frameSize;
    for (let j = 0; j < frameSize; j++) {
      const s = samples[offset + j];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    rmsPer50ms[i] = rms;
    sumRms += rms;
    if (rms > maxRms) {
      maxRms = rms;
      maxRmsIdx = i;
    }
  }

  const meanRms = numFrames > 0 ? sumRms / numFrames : 0;
  const peakTimeSec = Number(((maxRmsIdx + 0.5) * frameDurationSec).toFixed(2));

  // Onset detection via positive energy delta with adaptive threshold + 120ms refractory
  const deltas: number[] = new Array(numFrames).fill(0);
  for (let i = 1; i < numFrames; i++) {
    deltas[i] = Math.max(0, rmsPer50ms[i] - rmsPer50ms[i - 1]);
  }

  const windowRadius = 10; // +/- 0.5s
  const refractoryFrames = Math.ceil(0.12 / frameDurationSec); // 3 frames = 150ms >= 120ms
  const estimatedHits: EstimatedHit[] = [];
  let lastHitIdx = -refractoryFrames;

  const noiseFloor = Math.max(0.005, meanRms * 0.25);

  for (let i = 1; i < numFrames; i++) {
    const start = Math.max(0, i - windowRadius);
    const end = Math.min(numFrames, i + windowRadius + 1);
    let localSum = 0;
    for (let k = start; k < end; k++) localSum += deltas[k];
    const localMean = localSum / (end - start);

    let localVar = 0;
    for (let k = start; k < end; k++) {
      const d = deltas[k] - localMean;
      localVar += d * d;
    }
    const localStd = Math.sqrt(localVar / (end - start));
    const threshold = Math.max(noiseFloor, localMean + 1.8 * localStd);

    if (deltas[i] > threshold && i - lastHitIdx >= refractoryFrames) {
      const strength = maxRms > 0 ? Math.min(1, deltas[i] / maxRms) : 0;
      estimatedHits.push({
        time: Number((i * frameDurationSec).toFixed(2)),
        strength: Number(strength.toFixed(3)),
      });
      lastHitIdx = i;
    }
  }

  // Compute hitConfidence (0..1)
  let hitConfidence = 0;
  if (numFrames > 0 && estimatedHits.length > 0 && maxRms > 0.01) {
    const avgStrength =
      estimatedHits.reduce((acc, h) => acc + h.strength, 0) /
      estimatedHits.length;
    const snrFactor = Math.min(1, maxRms / Math.max(1e-4, meanRms * 2.5));
    const countFactor = Math.min(1, estimatedHits.length / 3);
    hitConfidence = Number(
      Math.max(
        0,
        Math.min(1, 0.5 * snrFactor + 0.35 * avgStrength + 0.15 * countFactor),
      ).toFixed(3),
    );
  }

  return {
    sampleRate,
    frameDurationSec,
    rmsPer50ms,
    estimatedHits,
    hitConfidence,
    peakTimeSec,
    meanRms: Number(meanRms.toFixed(5)),
  };
}

export async function analyzeAudio(
  videoPath: string,
  hasAudio = true,
): Promise<AudioAnalysis> {
  if (!hasAudio) {
    return {
      sampleRate: 16000,
      frameDurationSec: 0.05,
      rmsPer50ms: [],
      estimatedHits: [],
      hitConfidence: 0,
      peakTimeSec: 0,
      meanRms: 0,
    };
  }

  const raw = await pipeFfmpegRaw([
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "f32le",
    "pipe:1",
  ]);

  const sampleCount = Math.floor(raw.byteLength / 4);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = raw.readFloatLE(i * 4);
  }

  return analyzeAudioFromPcm(samples, 16000);
}

