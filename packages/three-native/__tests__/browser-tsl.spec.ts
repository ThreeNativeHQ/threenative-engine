import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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

describe("Wasm modelWorldMatrix", () => {
  it("uses one engine-provided mat4 node for multiplication and column selection", () => {
    const { tsl, runtime } = setup();
    const exports = tsl as unknown as {
      modelWorldMatrix: INode & { element(index: number): INode };
      vec4(...args: number[]): INode;
    };
    const matrix = exports.modelWorldMatrix;
    expect(exports.modelWorldMatrix).toBe(matrix);
    matrix.mul(exports.vec4(0, 0, 0, 1));
    matrix.element(3);
    expect(runtime.call).toHaveBeenCalledWith("constant:modelWorldMatrix", null, []);
    expect(runtime.call).toHaveBeenCalledWith("mul", matrix[TSL_NODE], expect.any(Array));
    expect(runtime.call).toHaveBeenCalledWith("element", matrix[TSL_NODE], expect.any(Array));
    expect(
      vi.mocked(runtime.call).mock.calls.filter(([name]) => name === "constant:modelWorldMatrix"),
    ).toHaveLength(1);
  });
});

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

describe("r185 math surface census", () => {
  const root = resolve(
    dirname(createRequire(import.meta.url).resolve("three")),
    "../src/nodes/math",
  );
  for (const file of ["MathNode.js", "OperatorNode.js"]) {
    const source = readFileSync(resolve(root, file), "utf8");
    const exports = [...source.matchAll(/export const (\w+)/g)].map((match) => match[1] ?? "");
    const methods = [...source.matchAll(/addMethodChaining\( '(\w+)'/g)].map(
      (match) => match[1] ?? "",
    );
    it(`${file}: exposes every export`, () => {
      const { tsl } = setup();
      expect(
        exports.filter((name) => {
          const value = (tsl as unknown as Record<string, unknown>)[name];
          return /^[A-Z_]+$/.test(name) || name === "PI2"
            ? typeof value !== "object"
            : typeof value !== "function";
        }),
      ).toEqual([]);
    });
    it(`${file}: keeps the V8 player exports and registrations in sync`, () => {
      const player = readFileSync(
        new URL("../../runtime-native/src/engine/player/core-tsl.mjs", import.meta.url),
        "utf8",
      );
      const adapter = readFileSync(
        new URL("../../runtime-native/src/adapters/v8/tsl.cpp", import.meta.url),
        "utf8",
      );
      const playerExports = new Set(
        [...player.matchAll(/export const \{([^}]+)\}/g)].flatMap(
          (match) => (match[1] ?? "").match(/\w+/g) ?? [],
        ),
      );
      expect(exports.filter((name) => !playerExports.has(name))).toEqual([]);
      expect(methods.filter((name) => !adapter.includes(`"${name}"`))).toEqual([]);
    });
    it(`${file}: exposes every registered method`, () => {
      const { tsl } = setup();
      const node = tsl.float(0.5);
      expect(
        methods.filter(
          (name) => typeof (node as unknown as Record<string, unknown>)[name] !== "function",
        ),
      ).toEqual([]);
    });
  }
});

describe("Wasm MaterialX scalar Worley noise", () => {
  it("forwards omitted arguments and explicit zero jitter to the shared engine call", () => {
    const { tsl, runtime } = setup();
    const noise = (
      tsl as unknown as { mx_worley_noise_float(position?: INode, jitter?: number): INode }
    ).mx_worley_noise_float;
    expect(noise()[TSL_NODE]).toBeGreaterThan(0);
    expect(runtime.call).toHaveBeenLastCalledWith("mx_worley_noise_float", null, []);
    const point = tsl.vec2(0.25, -0.75);
    expect(noise(point, 0)[TSL_NODE]).toBeGreaterThan(0);
    expect(runtime.call).toHaveBeenLastCalledWith("mx_worley_noise_float", null, [
      { kind: "node", node: point[TSL_NODE] },
      { kind: "number", number: 0 },
    ]);
  });
});

/**
 * three's `material*` accessors each build `material.<value> * material.<map>` (MaterialNode.js). The engine
 * bridges four, and `tsl_material_accessors_test.cpp` proves each samples its map. A bridged accessor that
 * dropped its map left a bare factor: a glTF emissiveFactor of 1 beside a near-black emissiveMap drew a white part.
 * A three accessor must be in one list: a new one fails here until it is bridged with its map or named unbridged.
 */
describe("MaterialNode accessor census", () => {
  const MAP_AWARE = ["materialColor", "materialEmissive", "materialMetalness", "materialRoughness"];
  // Not bridged: an import of one is refused by name (TN_NATIVE_UNCATALOGUED_<NAME>) at its use.
  const UNBRIDGED = [
    "materialAO",
    "materialAlphaTest",
    "materialAnisotropy",
    "materialAnisotropyVector",
    "materialAttenuationColor",
    "materialAttenuationDistance",
    "materialClearcoat",
    "materialClearcoatNormal",
    "materialClearcoatRoughness",
    "materialDispersion",
    "materialIOR",
    "materialIridescence",
    "materialIridescenceIOR",
    "materialIridescenceThickness",
    "materialLightMap",
    "materialLineDashOffset",
    "materialLineDashSize",
    "materialLineGapSize",
    "materialLineScale",
    "materialLineWidth",
    "materialNormal",
    "materialOpacity",
    "materialPointSize",
    "materialReflectivity",
    "materialRotation",
    "materialSheen",
    "materialSheenRoughness",
    "materialShininess",
    "materialSpecular",
    "materialSpecularColor",
    "materialSpecularIntensity",
    "materialSpecularStrength",
    "materialThickness",
    "materialTransmission",
  ];
  const source = readFileSync(
    resolve(
      dirname(createRequire(import.meta.url).resolve("three")),
      "../src/nodes/accessors/MaterialNode.js",
    ),
    "utf8",
  );
  const accessors = [...source.matchAll(/export const (material\w+)/g)].map(
    (match) => match[1] ?? "",
  );

  it("lists every accessor three declares", () => {
    expect(accessors.filter((name) => ![...MAP_AWARE, ...UNBRIDGED].includes(name))).toEqual([]);
  });
  it("bridges exactly the map-aware accessors", () => {
    const { tsl } = setup();
    const bridged = accessors.filter(
      (name) => (tsl as unknown as Record<string, unknown>)[name] !== undefined,
    );
    expect(bridged.sort()).toEqual([...MAP_AWARE].sort());
  });
});
