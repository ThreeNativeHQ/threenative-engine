import { PerspectiveCamera, Scene } from "three";
import { vec4 } from "three/tsl";
import { expect, it, vi } from "vitest";
import { type OutputRenderer, WorldEnvironment } from "../src/look/world-environment.js";

const normals = vi.hoisted(() => [] as { levelNode?: unknown }[]);
vi.mock("three/addons/tsl/display/SSRNode.js", async (actual) => {
  const real = await actual<typeof import("three/addons/tsl/display/SSRNode.js")>();
  return {
    ...real,
    ssr: (_color: unknown, _depth: unknown, normal: { levelNode?: unknown }) => {
      normals.push(normal);
      return Object.assign(vec4(0), { maxDistance: { value: 0 }, maxSteps: { value: 0 } });
    },
  };
});

// The starter on Windows CI (D3D12, Microsoft Basic Render Driver): three's SSRNode samples the normal inside
// its march loop, and an implicit-gradient sample in a dynamic loop makes FXC try to unroll it and fail
// ("X3511: unable to unroll loop"). The normal target has no mips, so level 0 reads the same texels.
it("hands the reflection march a normal sampled at level 0, so FXC compiles the loop", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const target: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain({ stages }) {
      const stage = stages?.find((entry) => entry.name === "ssr");
      if (!stage) throw new Error("missing ssr stage");
      try {
        stage.build(vec4(1), { tier: "high" });
      } catch {
        // The fake march is enough to reach the normal input; the composite is not under test.
      }
      return { applied: { stages: ["ssr"], dropped: [] }, dispose() {} };
    },
  };
  new WorldEnvironment({
    autoExposureEnabled: false,
    tonemapMode: "aces",
    ssrEnabled: true,
    bloomEnabled: false,
    screenSpaceAA: "disabled",
  })
    .apply(target, new Scene(), new PerspectiveCamera())
    ?.dispose?.();
  expect(normals.length).toBeGreaterThan(0);
  for (const normal of normals) expect(normal.levelNode ?? null).not.toBeNull();
});
