import { PerspectiveCamera, Scene } from "three";
import { float, vec4 } from "three/tsl";
import { expect, it, vi } from "vitest";
import { type OutputRenderer, WorldEnvironment } from "../src/look/world-environment.js";

const filters = vi.hoisted(() => [] as { resolutionScale?: number }[]);
vi.mock("three/addons/tsl/display/DenoiseNode.js", async (actual) => {
  const real = await actual<typeof import("three/addons/tsl/display/DenoiseNode.js")>();
  return {
    ...real,
    denoise: () => {
      const node = Object.assign(vec4(0), { index: { value: 0 }, radius: { value: 0 } });
      filters.push(node as { resolutionScale?: number });
      return node;
    },
  };
});
vi.mock("three/addons/tsl/display/SSGINode.js", async (actual) => {
  const real = await actual<typeof import("three/addons/tsl/display/SSGINode.js")>();
  return {
    ...real,
    ssgi: () => ({
      sliceCount: { value: 0 },
      stepCount: { value: 0 },
      radius: { value: 0 },
      getAONode: () => float(1),
      getGINode: () => vec4(0),
    }),
  };
});

// Lantern Vale at 2560x1440 on an RTX 2080: the SSGI denoise filtered at full resolution over a gather taken at
// half, 3.7 ms of a 15 ms GPU frame. It filters at the gather's resolution, as the AO denoise filters at the AO's.
it("filters the owned engine's SSGI at the resolution it gathers at", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const target: OutputRenderer = {
    kind: "webgpu",
    raw: { info: { engine: {} } },
    createRenderChain({ stages }) {
      const stage = stages?.find((entry) => entry.name === "ssgi");
      if (!stage) throw new Error("missing ssgi stage");
      try {
        stage.build(vec4(1), { tier: "high" });
      } catch {
        // The fake gather is enough to reach the denoise; the rest of the composite is not under test.
      }
      return { applied: { stages: ["ssgi"], dropped: [] }, dispose() {} };
    },
  };
  new WorldEnvironment({
    autoExposureEnabled: false,
    tonemapMode: "aces",
    ssgiEnabled: true,
    ssgiResolutionScale: 0.5,
    giDenoisePasses: 2,
    bloomEnabled: false,
    screenSpaceAA: "disabled",
  })
    .apply(target, new Scene(), new PerspectiveCamera())
    ?.dispose?.();
  expect(filters.length).toBeGreaterThan(0);
  for (const filter of filters) expect(filter.resolutionScale).toBe(0.5);
});
