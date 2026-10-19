import { describe, expect, it } from "vitest";
import { SCREENSHOT_TIMEOUT_MS } from "../src/runner/shared.js";

describe("SCREENSHOT_TIMEOUT_MS", () => {
  it("defaults to 120_000 ms to give CPU rasterizers headroom", () => {
    expect(SCREENSHOT_TIMEOUT_MS).toBe(120_000);
  });
});
