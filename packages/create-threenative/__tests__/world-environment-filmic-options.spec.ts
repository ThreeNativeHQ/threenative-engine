import { CustomToneMapping, PerspectiveCamera, Scene } from "three";
import { float, vec3 } from "three/tsl";
import { describe, expect, it } from "vitest";
import {
  type OutputRenderer,
  WorldEnvironment,
} from "../../../test-support/isolated-world-environment.js";

// PRD-632 Phase 4, GAP-5: a game reaches Unreal's film curve numbers and colour grade through the options.
function apply(options: ConstructorParameters<typeof WorldEnvironment>[0]) {
  const mapped: { node: (color: unknown, exposure: unknown) => unknown; mode: number }[] = [];
  const raw = {
    info: {},
    library: { addToneMapping: (node: never, mode: number) => mapped.push({ node, mode }) },
    toneMapping: 0,
  };
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw,
    createRenderChain: (received) => ({
      applied: { stages: received.request?.stages ?? [], dropped: [] },
      dispose() {},
    }),
  };
  new WorldEnvironment(options).apply(renderer, new Scene(), new PerspectiveCamera());
  return { mapped, raw };
}

describe("filmic options", () => {
  it("registers the curve with the grade the game set", () => {
    const { mapped, raw } = apply({
      tonemapMode: "filmic",
      filmicCurve: { shoulder: 0.3, lutClip: 0 },
      colorGrade: { whiteTemp: 5500, shadows: { gain: [1, 1, 1, 1.1] } },
    });
    expect(raw.toneMapping).toBe(CustomToneMapping);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.node(vec3(0.4, 0.3, 0.2), float(1))).toBeDefined();
  });
  it("refuses a malformed grade when the environment is built", () => {
    expect(
      () => new WorldEnvironment({ tonemapMode: "filmic", colorGrade: { whiteTemp: 100 } }),
    ).toThrow(/whiteTemp/);
  });
  it("refuses the options under another tone mapper instead of ignoring them", () => {
    expect(() => new WorldEnvironment({ colorGrade: { toneCurveAmount: 0.5 } })).toThrow(
      /TN_TONEMAP_OPTIONS_IGNORED/,
    );
    expect(() => new WorldEnvironment({ tonemapMode: "agx", filmicCurve: { slope: 0.9 } })).toThrow(
      /TN_TONEMAP_OPTIONS_IGNORED/,
    );
  });
});
