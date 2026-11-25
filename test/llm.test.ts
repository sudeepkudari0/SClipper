import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findTopMoments } from "../src/analysis/moments.js";
import { CampaignProfileSchema } from "../src/core/profile.js";
import { MistralClient } from "../src/llm/mistral.js";

describe("MistralClient (mocked fetch)", () => {
  it("retries on 429, repairs invalid JSON once, and hits disk cache on repeat", async () => {
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-llm-test-"));
    let callCount = 0;

    const mockFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      if (callCount === 2) {
        // Invalid schema (missing count field) -> triggers 1 auto-repair retry
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ wrong: true }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true, count: 3 }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const client = new MistralClient({
        apiKey: "test-key",
        minIntervalMs: 0,
        fetchFn: mockFetch,
        cacheDir: tmpCache,
      });

      const schema = z.object({ ok: z.boolean(), count: z.number() });
      const res1 = await client.json("plan", "test prompt", schema);
      expect(res1).toEqual({ ok: true, count: 3 });
      expect(callCount).toBe(3); // 1x 429 + 1x bad JSON + 1x repaired JSON

      // Second identical call should hit disk cache (no new fetch)
      const res2 = await client.json("plan", "test prompt", schema);
      expect(res2).toEqual({ ok: true, count: 3 });
      expect(callCount).toBe(3);
    } finally {
      fs.rmSync(tmpCache, { recursive: true, force: true });
    }
  });

  it("ranks moments from a fixture transcript using mocked HTTP", async () => {
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-moments-test-"));
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  moments: [
                    {
                      start: 10.2,
                      end: 22.8,
                      why: "Strong point",
                      hookIdea: "Watch this rally",
                      score: 92,
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const client = new MistralClient({
        apiKey: "test-key",
        minIntervalMs: 0,
        fetchFn: mockFetch,
        cacheDir: tmpCache,
      });
      const profile = CampaignProfileSchema.parse({ name: "podcast" });
      const segments = [
        { start: 0, end: 10, text: "Intro chatter." },
        { start: 10, end: 16, text: "Here is the key insight." },
        { start: 16, end: 23, text: "And that is why it worked." },
        { start: 23, end: 35, text: "Moving on to the next topic." },
      ];

      const ranked = await findTopMoments(segments, profile, client, 5);
      expect(ranked.length).toBe(1);
      expect(ranked[0].start).toBe(10);
      expect(ranked[0].end).toBe(23);
      expect(ranked[0].score).toBe(92);
    } finally {
      fs.rmSync(tmpCache, { recursive: true, force: true });
    }
  });
});

