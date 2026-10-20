import { describe, expect, it } from "vitest";

import { definePass, markNormalTarget } from "../src/pass-node.js";

const normalView = Object.freeze({ name: "normalView" });
const tsl = {
  texture: (source: unknown) => ({ source }),
  uv: () => ({}),
  normalView,
};
const { mrt, output, metalness, roughness } = definePass(tsl);
const vec4 = markNormalTarget((...parts: unknown[]) => ({ parts }), normalView);

describe("native scene pass surface targets", () => {
  const calls: string[] = [];
  const node = (name: string): object =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "a" || property === "r" || property === "g"
            ? node(`${name}.${String(property)}`)
            : (...args: unknown[]) => {
                calls.push(`${name}.${String(property)}(${args.length})`);
                return node(`${name}.${String(property)}`);
              },
      },
    );
  const surfaceTsl = {
    texture: (source: unknown) => node(`texture(${(source as { name: string }).name})`),
    uv: () => ({}),
    normalView,
    floor: () => node("floor"),
    vec4: (...parts: unknown[]) => ({ parts }),
  };

  it("reads metalness and roughness from the normal target's alpha when the MRT asks for them", () => {
    const api = definePass(surfaceTsl);
    const scenePass = api.pass({}, {});
    scenePass.setMRT(
      api.mrt({
        output: api.output,
        normal: normalView,
        metalness: api.metalness,
        roughness: api.roughness,
      }),
    );
    const surface = scenePass.getTextureNode("metalness") as { parts: unknown[] };
    expect(surface.parts).toHaveLength(4);
    expect(scenePass.getTextureNode("roughness")).toBeDefined();
    expect(calls.some((call) => call.includes("greaterThan"))).toBe(true);
  });

  it("refuses a surface target the MRT did not ask for, and a table that cannot unpack it", () => {
    const api = definePass(surfaceTsl);
    const scenePass = api.pass({}, {});
    expect(() => scenePass.getTextureNode("metalness")).toThrow(
      /TN_NATIVE_PASS_TEXTURE_UNSUPPORTED/u,
    );
    scenePass.setMRT(api.mrt({ output: api.output, normal: normalView, metalness: api.metalness }));
    expect(() => scenePass.getTextureNode("roughness")).toThrow(
      /TN_NATIVE_PASS_TEXTURE_UNSUPPORTED/u,
    );
    const bare = definePass(tsl);
    const barePass = bare.pass({}, {});
    barePass.setMRT(
      bare.mrt({ output: bare.output, normal: normalView, metalness: bare.metalness }),
    );
    expect(() => barePass.getTextureNode("metalness")).toThrow(/no floor and vec4/u);
  });
});

describe("native scene pass MRT", () => {
  it("accepts the normal target as normalView or as vec4(normalView, 0)", () => {
    expect(mrt({ output, normal: normalView }).outputs.normal).toBe(normalView);
    // The spelling the templates use: the zero alpha rides with a BlendMode on the same output.
    expect(mrt({ output, normal: vec4(normalView, 0), metalness, roughness }).outputs.normal).toBe(
      normalView,
    );
  });

  it("refuses every other normal spelling by name", () => {
    expect(() => mrt({ normal: vec4(normalView, 1) })).toThrow(
      /TN_NATIVE_MRT_UNSUPPORTED: normal/u,
    );
    expect(() => mrt({ normal: vec4({}, 0) })).toThrow(/TN_NATIVE_MRT_UNSUPPORTED: normal/u);
    expect(() => mrt({ velocity: {} })).toThrow(/TN_NATIVE_MRT_UNSUPPORTED: velocity/u);
  });

  it("records a blend mode per output without touching the others", () => {
    const node = mrt({ output, normal: vec4(normalView, 0) });
    const mode = { blending: 6 };
    expect(node.setBlendMode("normal", mode)).toBe(node);
    expect(node.getBlendMode("normal")).toBe(mode);
    expect(node.getBlendMode("output")).toBeUndefined();
  });
});

class FakeTarget {
  readonly texture = {};
  disposed = false;
  constructor(
    public width: number,
    public height: number,
    readonly options: { type: number },
  ) {}
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
  dispose(): void {
    this.disposed = true;
  }
}

function offscreenSetup(surface?: { width: number; height: number }) {
  const published: unknown[][] = [];
  const draws: unknown[][] = [];
  const api = definePass(
    tsl,
    (scene, camera) => published.push([scene, camera]),
    // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
    { RenderTarget: FakeTarget, ...(surface ? { surface: () => surface } : {}) },
  );
  const frame = (width: number, height: number) =>
    api.updateSecondaryPasses(
      () => ({ width, height }),
      (target, scene, camera) => draws.push([target, scene, camera]),
    );
  return { api, published, draws, frame };
}

describe("offscreen PassNode on a non-main scene", () => {
  const mainScene = { name: "main" };
  const mainCamera = { name: "mainCamera" };
  const quadScene = { name: "quad" };
  const quadCamera = { name: "quadCamera" };

  it.each(["frame pass first", "offscreen pass first"])(
    "never publishes its scene whichever is constructed first (%s)",
    (order) => {
      const { api, published, frame } = offscreenSetup();
      const make = {
        frame: () => api.pass(mainScene, mainCamera),
        offscreen: () => new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera),
      };
      if (order === "frame pass first") {
        make.frame();
        make.offscreen();
      } else {
        make.offscreen();
        make.frame();
      }
      frame(100, 50);
      expect(published).toEqual([[mainScene, mainCamera]]);
    },
  );

  it("keeps the frame pass publishing through scene and camera writes while an offscreen pass stays silent", () => {
    const { api, published } = offscreenSetup();
    const main = api.pass(mainScene, mainCamera);
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    const mirror = { name: "mirror" };
    main.scene = mirror;
    main.camera = quadCamera;
    side.scene = mirror;
    side.camera = mainCamera;
    expect(published).toEqual([
      [mainScene, mainCamera],
      [mirror, mainCamera],
      [mirror, quadCamera],
    ]);
  });

  it("draws the pass's own scene and camera into its own target each frame", () => {
    const { api, draws, frame } = offscreenSetup();
    api.pass(mainScene, mainCamera);
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    frame(100, 50);
    frame(100, 50);
    expect(draws).toEqual([
      [side.renderTarget, quadScene, quadCamera],
      [side.renderTarget, quadScene, quadCamera],
    ]);
    expect(side.renderTarget).toBeInstanceOf(FakeTarget);
    expect((side.renderTarget as FakeTarget).options.type).toBe(1016);
  });

  it("allocates floor(surface * scale) and follows the scale and a surface resize", () => {
    const { api, frame } = offscreenSetup();
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    side.setResolutionScale(0.5);
    frame(1001, 501);
    expect([side.renderTarget?.width, side.renderTarget?.height]).toEqual([500, 250]);
    side.setResolutionScale(0.25);
    expect([side.renderTarget?.width, side.renderTarget?.height]).toEqual([250, 125]);
    frame(640, 360);
    expect([side.renderTarget?.width, side.renderTarget?.height]).toEqual([160, 90]);
    expect(side.getResolutionScale()).toBe(0.25);
  });

  it("sizes at construction when the back end knows its surface", () => {
    const { api } = offscreenSetup({ width: 800, height: 600 });
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    side.setResolutionScale(0.5);
    expect([side.renderTarget?.width, side.renderTarget?.height]).toEqual([400, 300]);
  });

  it("samples the target's texture, not the frame's colour", () => {
    const { api } = offscreenSetup();
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    expect(side.getTextureNode()).toEqual({ source: side.renderTarget?.texture });
    const main = api.pass(mainScene, mainCamera);
    expect(main.getTextureNode()).toEqual({ source: { name: "scene" } });
  });

  it("releases the target on dispose and stops drawing the pass", () => {
    const { api, draws, frame } = offscreenSetup();
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    const target = side.renderTarget as FakeTarget;
    frame(100, 50);
    side.dispose();
    side.dispose();
    frame(100, 50);
    expect(target.disposed).toBe(true);
    expect(draws).toHaveLength(1);
    expect(() => side.getTextureNode()).toThrow(/TN_NATIVE_PASS_DISPOSED/u);
  });

  it("refuses what an offscreen pass cannot do, by name", () => {
    const { api, frame } = offscreenSetup();
    const side = new api.PassNode(api.PassNode.COLOR, quadScene, quadCamera);
    expect(() => new api.PassNode(api.PassNode.DEPTH, quadScene, quadCamera)).toThrow(
      /TN_NATIVE_PASS_SCOPE_UNSUPPORTED/u,
    );
    expect(() => side.getTextureNode("depth")).toThrow(/TN_NATIVE_PASS_TEXTURE_UNSUPPORTED/u);
    expect(() => side.setMRT(mrt({ output }))).toThrow(/TN_NATIVE_MRT_UNSUPPORTED/u);
    expect(() => side.setResolutionScale(0)).toThrow(/TN_NATIVE_PASS_RESOLUTION_SCALE/u);
    expect(() => side.setResolutionScale(Number.NaN)).toThrow(/TN_NATIVE_PASS_RESOLUTION_SCALE/u);
    expect(() => api.pass(mainScene, mainCamera).setResolutionScale(0.5)).toThrow(
      /TN_NATIVE_PASS_RESOLUTION_UNSUPPORTED/u,
    );
    expect(() => frame(0, 50)).toThrow(/TN_NATIVE_PASS_SURFACE/u);
    expect(() => new (definePass(tsl).PassNode)("color", quadScene, quadCamera)).toThrow(
      /TN_NATIVE_PASS_HOST/u,
    );
  });
});
