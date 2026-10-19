import { describe, expect, it } from "vitest";
import {
  QUALITY_ALIASES,
  automationRequest,
  qualityTier,
} from "../templates/rain/src/ui/automation.js";

describe("rain automation quality vocabulary", () => {
  it("accepts the source study's four names and the engine's four", () => {
    expect(Object.keys(QUALITY_ALIASES).sort()).toEqual([
      "balanced",
      "cinematic",
      "high",
      "low",
      "performance",
      "ultra",
    ]);
    expect(qualityTier("low")).toBe("performance");
    expect(qualityTier("cinematic")).toBe("ultra");
    expect(qualityTier("balanced")).toBe("balanced");
    expect(qualityTier("high")).toBe("high");
  });

  it("refuses a name in neither vocabulary, and an inherited one", () => {
    expect(() => qualityTier("ultra")).not.toThrow();
    expect(() => qualityTier("cinematic_")).toThrow(/TN_RAIN_QUALITY_UNKNOWN/);
    expect(() => qualityTier("toString")).toThrow(/TN_RAIN_QUALITY_UNKNOWN/);
    expect(() => qualityTier(3)).toThrow(/TN_RAIN_QUALITY_UNKNOWN/);
  });
});

describe("rain automation query", () => {
  it("reads still and the tier alias together", () => {
    expect(automationRequest("?still&quality=high")).toEqual({ quality: "high", still: true });
    expect(automationRequest("?quality=low")).toEqual({ quality: "performance", still: false });
    expect(automationRequest("")).toEqual({ still: false });
  });

  it("names an unreadable tier instead of opening the page on a guessed one", () => {
    expect(automationRequest("?quality=cinematiques")).toEqual({
      rejectedQuality: "cinematiques",
      still: false,
    });
    expect(automationRequest("?still&quality=lwo")).toEqual({
      rejectedQuality: "lwo",
      still: true,
    });
  });
});
