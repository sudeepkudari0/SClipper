import { pipeFfmpegRaw } from "../core/ffmpeg.js";

export interface MotionAnalysis {
  fps: number;
  width: number;
  height: number;
  energyPerFrame: number[];
  centroidXPerFrame: number[];
  centroidYPerFrame: number[];
  dominantSide: "left" | "center" | "right";
  meanEnergy: number;
}

export function analyzeMotionFromBuffer(
  raw: Buffer,
  width = 160,
  height = 90,
  fps = 8,
): MotionAnalysis {
  const frameBytes = width * height;
  const numFrames = Math.floor(raw.byteLength / frameBytes);
  const energyPerFrame: number[] = [];
  const centroidXPerFrame: number[] = [];
  const centroidYPerFrame: number[] = [];

  let prevX = 0.5;
  let prevY = 0.5;

  for (let f = 1; f < numFrames; f++) {
    const prevOffset = (f - 1) * frameBytes;
    const currOffset = f * frameBytes;
    let sumDiff = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        const idx = rowOff + x;
        const diff = Math.abs(raw[currOffset + idx] - raw[prevOffset + idx]);
        if (diff > 12) {
          // Ignore tiny compression noise
          sumDiff += diff;
          weightedX += diff * (x / (width - 1));
          weightedY += diff * (y / (height - 1));
        }
      }
    }

    const energy = sumDiff / (frameBytes * 255);
    energyPerFrame.push(Number(energy.toFixed(5)));

    if (sumDiff > 0) {
      prevX = weightedX / sumDiff;
      prevY = weightedY / sumDiff;
    }
    centroidXPerFrame.push(Number(prevX.toFixed(4)));
    centroidYPerFrame.push(Number(prevY.toFixed(4)));
  }

  const meanEnergy =
    energyPerFrame.length > 0
      ? energyPerFrame.reduce((a, b) => a + b, 0) / energyPerFrame.length
      : 0;

  let weightedSideSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < centroidXPerFrame.length; i++) {
    const w = energyPerFrame[i] + 1e-4;
    weightedSideSum += centroidXPerFrame[i] * w;
    weightTotal += w;
  }
  const avgX = weightTotal > 0 ? weightedSideSum / weightTotal : 0.5;
  const dominantSide: "left" | "center" | "right" =
    avgX < 0.42 ? "left" : avgX > 0.58 ? "right" : "center";

  return {
    fps,
    width,
    height,
    energyPerFrame,
    centroidXPerFrame,
    centroidYPerFrame,
    dominantSide,
    meanEnergy: Number(meanEnergy.toFixed(5)),
  };
}

export async function analyzeMotion(videoPath: string): Promise<MotionAnalysis> {
  const width = 160;
  const height = 90;
  const fps = 8;

  const raw = await pipeFfmpegRaw([
    "-i",
    videoPath,
    "-an",
    "-vf",
    `fps=${fps},scale=${width}:${height},format=gray`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);

  return analyzeMotionFromBuffer(raw, width, height, fps);
}

