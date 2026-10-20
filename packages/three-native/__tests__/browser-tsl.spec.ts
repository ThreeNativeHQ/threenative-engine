import { describe, expect, it, vi } from "vitest";
import { TSL_NODE } from "../src/browser-backend.js";
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";
import { definePass } from "../src/pass-node.js";

interface INode {
  readonly [TSL_NODE]: number;
  mul(value: unknown): INode;
  add(value: unknown): INode;
}
interface ITslExports {
  Fn(callback: (parameters: never) => INode): (...args: unknown[]) => INode;
  vec2(...args: number[]): INode;
  float(value: number): INode;
}

function setup() {
  let next = 0;
  const runtime: ITslRuntime = {
    call: vi.fn(() => ++next),
    release: vi.fn(),
    set: vi.fn(),
    setUniform: vi.fn(),
    effectParameter: vi.fn(() => 0),
    setPost: vi.fn(),
    compute: vi.fn(),
    readStorage: vi.fn(),
    deleteStorage: vi.fn(),
  };
  return { runtime, tsl: defineTsl(runtime).exports as unknown as ITslExports };
}

describe("Wasm TSL Fn parameters", () => {
  it("defers the blue-noise style destructuring callback until called", () => {
    const { tsl, runtime } = setup();
    const callback = vi.fn(([uv, scale]: [INode, INode]) => uv.mul(scale));
    const noise = tsl.Fn(callback);
    expect(callback).not.toHaveBeenCalled();
    const uv = tsl.vec2(0.25, 0.75);
    const a = noise(uv, 2);
    const b = noise([uv, 4]);
    const single = tsl.Fn(([value]: [INode]) => value.mul(2));
    expect(single(uv)[TSL_NODE]).toBeGreaterThan(0);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(a[TSL_NODE]).not.toBe(b[TSL_NODE]);
    expect(runtime.call).toHaveBeenCalledWith("mul", uv[TSL_NODE], expect.any(Array));
  });

  it("passes named parameters and closes a failed callback scope", () => {
    const { tsl, runtime } = setup();
    const named = tsl.Fn(({ value }: { value: INode }) => value.add(1));
    expect(named({ value: 3 })[TSL_NODE]).toBeGreaterThan(0);
    const broken = tsl.Fn(() => {
      throw new Error("callback failed");
    });
    expect(() => broken()).toThrow("callback failed");
    expect(runtime.call).toHaveBeenLastCalledWith("scope:close", null, []);
    expect(tsl.Fn(() => tsl.float(1))()[TSL_NODE]).toBeGreaterThan(0);
  });
});

describe("Wasm TSL extras", () => {
  it("builds densityFogFactor and saturate over the engine's functions, as the V8 player does", () => {
    const { tsl, runtime } = setup();
    const extras = tsl as unknown as {
      densityFogFactor(density: number): INode;
      saturate(value: INode): INode;
      fog(color: unknown, factor: unknown): { isFogNode: boolean };
      velocity: unknown;
    };
    expect(extras.densityFogFactor(0.02)[TSL_NODE]).toBeGreaterThan(0);
    expect(runtime.call).toHaveBeenCalledWith("linearDepth", null, expect.any(Array));
    expect(extras.saturate(tsl.float(2))[TSL_NODE]).toBeGreaterThan(0);
    expect(runtime.call).toHaveBeenCalledWith("clamp", null, expect.any(Array));
    expect(extras.fog(1, 2).isFogNode).toBe(true);
    expect(() => (extras.velocity as { x: number }).x).toThrow("TN_NATIVE_UNSUPPORTED_VELOCITY");
  });
});

describe("Wasm TSL normal target", () => {
  it("names the engine normal target by vec4(normalView, 0), as three's templates and the V8 player do", () => {
    const { tsl } = setup();
    const exports = tsl as unknown as {
      vec4(...args: unknown[]): INode;
      normalView: INode;
    };
    const { mrt, output, metalness, roughness } = definePass(tsl as never);
    expect(() =>
      mrt({
        output,
        normal: exports.vec4(exports.normalView, 0),
        metalness,
        roughness,
      }),
    ).not.toThrow();
  });
});

describe("Wasm TSL fog", () => {
  // r185's fog(color, factor) is what `scene.fogNode` holds. The engine applies one graph node, so fog() is a
  // real node, vec4(color, factor): a frozen description had no engine node to set and the fog was dropped.
  it("answers an engine node that joins the colour and the factor", () => {
    const { tsl, runtime } = setup();
    const fog = (
      tsl as unknown as { fog(color: unknown, factor: unknown): INode & { isFogNode?: boolean } }
    ).fog;
    const haze = tsl.vec2(0.25, 0.75);
    const node = fog(haze, 0);
    expect(typeof node[TSL_NODE]).toBe("number");
    expect(node.isFogNode).toBe(true);
    expect(runtime.call).toHaveBeenCalledWith("vec4", null, expect.any(Array));
  });
});

describe("mutable texture values", () => {
  it("retains the graph node and rebinds its replacement texture", () => {
    const { runtime } = setup();
    const { exports } = defineTsl(runtime);
    const texture = exports.texture as (value: unknown) => { value: unknown; [TSL_NODE]: number };
    const first = { name: "first" };
    const second = { name: "second" };
    const sampled = texture(first);
    const id = sampled[TSL_NODE];
    sampled.value = second;
    expect(sampled.value).toBe(second);
    expect(sampled[TSL_NODE]).toBe(id);
    expect(runtime.call).toHaveBeenLastCalledWith("textureValue", id, [
      { kind: "named", text: "second" },
    ]);
  });
});
