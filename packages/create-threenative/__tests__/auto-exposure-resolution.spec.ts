import { describe, expect, it, vi } from "vitest";
import { resolveRendererScaleSetting } from "../../core/src/renderer-config.js";

const define = vi.hoisted(() => vi.fn((config: unknown) => config));
vi.mock("../../core/dist/index.js", () => ({ Scene: class {}, defineGame: define }));
vi.mock("../../core/dist/playtest.js", () => ({ playtest: () => ({}) }));
import { createExposureFixture } from "./fixtures/auto-exposure/game.js";

describe("controlled exposure drawing buffer", () => {
  it("pins the historical fixture buffer while production defaults adapt", () => {
    createExposureFixture({ enabled: true, bright: true, stops: 11, snapGain: 1 });
    const config = define.mock.lastCall?.[0] as {
      renderer: { resolutionScale?: number | "auto" };
    };
    expect(resolveRendererScaleSetting(undefined, undefined, "linux").scaleSource).toBe("auto");
    expect(resolveRendererScaleSetting(config.renderer, undefined, "linux")).toEqual({
      resolutionScale: 1,
      scaleSource: "pinned",
    });
    expect(resolveRendererScaleSetting(config.renderer, 0.32, "linux")).toEqual({
      resolutionScale: 1,
      scaleSource: "pinned",
    });
  });
});
