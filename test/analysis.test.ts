import { describe, expect, it } from "vitest";
import { analyzeAudioFromPcm } from "../src/analysis/audio.js";
import { selectWindow } from "../src/analysis/window.js";

describe("audio onset detection", () => {
  it("detects synthetic impulse beeps with 120ms refractory period", () => {
    const sr = 16000;
    const durationSec = 4;
    const samples = new Float32Array(sr * durationSec);

    // Add 3 short bursts at 0.5s, 1.5s, 2.5s
    for (const t of [0.5, 1.5, 2.5]) {
      const start = Math.floor(t * sr);
      for (let i = 0; i < 800; i++) {
        samples[start + i] = 0.6 * Math.sin((2 * Math.PI * 1000 * i) / sr);
      }
    }

    const res = analyzeAudioFromPcm(samples, sr);
    expect(res.estimatedHits.length).toBe(3);
    expect(res.estimatedHits[0].time).toBeCloseTo(0.5, 1);
    expect(res.estimatedHits[1].time).toBeCloseTo(1.5, 1);
    expect(res.estimatedHits[2].time).toBeCloseTo(2.5, 1);
    expect(res.hitConfidence).toBeGreaterThan(0.5);
  });
});

describe("window selection", () => {
  it("selects high-energy window inside [minSeconds, maxSeconds] for long clips", () => {
    const durationSec = 40;
    const rmsPer50ms = new Array(durationSec * 20).fill(0.01);
    // High energy between 15s and 25s
    for (let i = 15 * 20; i < 25 * 20; i++) {
      rmsPer50ms[i] = 0.5;
    }
    const motionEnergy = new Array(durationSec * 8).fill(0.01);
    for (let i = 15 * 8; i < 25 * 8; i++) {
      motionEnergy[i] = 0.2;
    }

    const win = selectWindow({
      durationSec,
      rmsPer50ms,
      motionEnergy,
      motionFps: 8,
      sceneCuts: [5, 35],
      estimatedHits: [
        { time: 16, strength: 0.9 },
        { time: 18, strength: 0.8 },
        { time: 21, strength: 0.95 },
      ],
      minSeconds: 8,
      maxSeconds: 25,
      targetSeconds: [12, 18],
    });

    expect(win.end - win.start).toBeGreaterThanOrEqual(8);
    expect(win.end - win.start).toBeLessThanOrEqual(25);
    expect(win.start).toBeGreaterThanOrEqual(10);
    expect(win.end).toBeLessThanOrEqual(30);
  });

  it("trims dead lead-in/tail when source is already within maxSeconds", () => {
    const win = selectWindow({
      durationSec: 20,
      rmsPer50ms: new Array(400).fill(0.01),
      motionEnergy: new Array(160).fill(0),
      motionFps: 8,
      sceneCuts: [],
      estimatedHits: [
        { time: 4.0, strength: 0.8 },
        { time: 13.0, strength: 0.9 },
      ],
      minSeconds: 8,
      maxSeconds: 60,
      targetSeconds: [12, 25],
    });

    expect(win.start).toBeCloseTo(3.7, 1);
    expect(win.end).toBeCloseTo(13.8, 1);
    expect(win.trimmed).toBe(true);
  });

  it("anchors window at dropAtSec before peak when dropAtSec is set", () => {
    const durationSec = 25;
    const motionEnergy = new Array(durationSec * 8).fill(0.01);
    // Strong visual peak at 10.0s
    motionEnergy[10 * 8] = 0.9;

    const win = selectWindow({
      durationSec,
      rmsPer50ms: new Array(durationSec * 20).fill(0),
      motionEnergy,
      motionFps: 8,
      sceneCuts: [],
      estimatedHits: [],
      minSeconds: 15,
      maxSeconds: 60,
      targetSeconds: [16, 22],
      dropAtSec: 3.0,
    });

    expect(win.start).toBeCloseTo(7.0, 1);
    expect(win.end - win.start).toBeGreaterThanOrEqual(15);
  });
});

