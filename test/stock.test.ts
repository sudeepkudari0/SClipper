import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  downloadPexelsClips,
  pickBestPexelsVideoFile,
} from "../src/sources/pexels.js";

describe("Pexels stock fetcher (mocked fetch)", () => {
  it("picks best HD mp4 file and downloads clips", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-pexels-test-"));
    const best = pickBestPexelsVideoFile([
      {
        id: 1,
        quality: "uhd",
        file_type: "video/mp4",
        width: 2160,
        height: 3840,
        link: "https://example.com/4k.mp4",
      },
      {
        id: 2,
        quality: "hd",
        file_type: "video/mp4",
        width: 1080,
        height: 1920,
        link: "https://example.com/hd.mp4",
      },
    ]);
    expect(best?.id).toBe(2);

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.pexels.com")) {
        return new Response(
          JSON.stringify({
            videos: [
              {
                id: 99,
                duration: 10,
                width: 1080,
                height: 1920,
                url: "https://pexels.com/99",
                video_files: [
                  {
                    id: 2,
                    quality: "hd",
                    file_type: "video/mp4",
                    width: 1080,
                    height: 1920,
                    link: "https://example.com/hd.mp4",
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(Buffer.from("fake-mp4-bytes"), { status: 200 });
    };

    try {
      const files = await downloadPexelsClips({
        query: "night drive",
        outDir: tmpDir,
        count: 1,
        apiKey: "test-pexels-key",
        fetchFn: mockFetch,
      });
      expect(files.length).toBe(1);
      expect(fs.existsSync(files[0])).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

