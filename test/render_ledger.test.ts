import { describe, expect, it } from "vitest";
import { CampaignProfileSchema } from "../src/core/profile.js";
import { computeLedgerSummary } from "../src/ledger/report.js";
import { generateAssContent } from "../src/render/ass.js";
import { smoothMotionCentroidX } from "../src/render/reframe.js";

describe("ASS generation", () => {
  it("generates valid ASS with hook and shot counter when confidence >= minConfidence", () => {
    const profile = CampaignProfileSchema.parse({ name: "test" });
    const ass = generateAssContent({
      width: 1080,
      height: 1920,
      durationSec: 12,
      fontName: "DejaVu Sans",
      hookText: "Wait for the finish.",
      profile,
      preset: "punchy",
      hits: [
        { time: 2.0, strength: 0.8 },
        { time: 4.5, strength: 0.9 },
      ],
      hitConfidence: 0.85,
      windowStartSec: 1.0,
      enableCounter: true,
    });

    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Wait for the finish.");
    expect(ass).toContain("SHOT 1");
    expect(ass).toContain("SHOT 2");
  });
});

describe("pan smoothing", () => {
  it("respects deadzone and max pan speed", () => {
    const raw = [0.2, 0.21, 0.22, 0.9, 0.9, 0.9, 0.9];
    const smoothed = smoothMotionCentroidX(raw, 8, {
      emaAlpha: 0.5,
      deadzone: 0.04,
      maxPanSpeedPerSec: 0.4, // max 0.05 per frame at 8fps
    });

    // Inside deadzone stays flat
    expect(smoothed[1]).toBe(0.2);
    // Large jump is clamped by maxPanSpeedPerSec
    expect(smoothed[3] - smoothed[2]).toBeLessThanOrEqual(0.0501);
  });
});

describe("ledger report math", () => {
  it("computes totals and effective $/hour per platform", () => {
    const summary = computeLedgerSummary([
      {
        clipId: "c1",
        platform: "tiktok",
        postedAt: "2026-01-01T00:00:00Z",
        url: "",
        views: 10000,
        payoutUsd: 15,
        minutesSpent: 30,
      },
      {
        clipId: "c2",
        platform: "instagram",
        postedAt: "2026-01-01T01:00:00Z",
        url: "",
        views: 5000,
        payoutUsd: 15,
        minutesSpent: 30,
      },
    ]);

    expect(summary.totalPosts).toBe(2);
    expect(summary.totalViews).toBe(15000);
    expect(summary.totalPayoutUsd).toBe(30);
    expect(summary.totalMinutesSpent).toBe(60);
    expect(summary.dollarsPerHour).toBe(30);
    expect(summary.byPlatform.length).toBe(2);
  });
});

