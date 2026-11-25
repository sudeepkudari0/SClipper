import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCampaignProfile } from "../src/core/profile.js";

describe("profile parsing", () => {
  it("loads and validates campaigns/cnpl/profile.yaml", () => {
    const { profile } = loadCampaignProfile(
      "cnpl",
      path.resolve(process.cwd(), "campaigns"),
    );
    expect(profile.name).toBe("cnpl");
    expect(profile.niche).toBe("sports-highlights");
    expect(profile.output.width).toBe(1080);
    expect(profile.output.height).toBe(1920);
    expect(profile.output.minSeconds).toBe(8);
    expect(profile.output.maxSeconds).toBe(60);
    expect(profile.reframe.allowBlurFill).toBe(false);
    expect(profile.captions.requiredHashtags).toEqual(["#CNPLclips"]);
    expect(profile.captions.requiredMentions).toEqual(["@officialcnpl"]);
    expect(profile.bans.bakedMusic).toBe(true);
  });
});

