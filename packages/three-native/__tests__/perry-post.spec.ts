import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { type IEffectTsl, definePostEffects } from "../src/addons/post-effects.js";
import { TSL_NODE } from "../src/browser-backend.js";
import type { defineRenderPipeline } from "../src/browser-entry.js";
import { RENDER_AGAIN } from "../src/browser-renderer.js";
import type { IPerryRuntime } from "../src/perry-transport.js";

type Tsl = typeof import("three/tsl");

const native = vi.hoisted(() => {
  let next = 0;
  const types = new Map<string, number>();
  return {
    tsl: {
      call: vi.fn(() => ++next),
      release() {},
      set() {},
      setUniform() {},
      effectParameter: () => 0,
      setPost: vi.fn(),
    },
    typeId: (name: string) => {
      if (!types.has(name)) types.set(name, types.size + 1);
      return types.get(name);
    },
    construct: (name: string) => ({ type: types.get(name), key: `${name}:${++next}` }),
    render: vi.fn(),
  };
});

it("transports a post id and null through the Perry C entry and preserves named errors", () => {
  const values = new Map<number, number>();
  let next = 64;
  let refusal = false;
  const transport = {
    layout: (field: number) => [8, 12, 56, 32, 32, 40, 48, 64][field],
    alloc: (bytes: number) => {
      const at = next;
      next += bytes;
      return at;
    },
    free: vi.fn(),
    memory: (kind: number, at: number, value: number) => {
      if (kind >= 16) values.set(at, value);
      return values.get(at) ?? 0;
    },
    call: (op: number, out: number) => {
      if (op === 1) values.set(out, 123);
      return 0;
    },
    readString: (at: number) => (at ? "TN_PERRY_POST: not a TSL node of this context" : ""),
    setPost: vi.fn((_context: number, _at: number) => (refusal ? 999 : 0)),
  };
  const source = readFileSync(new URL("../src/perry-transport.ts", import.meta.url), "utf8")
    .replace(/import\s*\{([^}]+)\}\s*from "tn-native-transport";/u, "const {$1} = native;")
    .replace("alloc as malloc", "alloc: malloc");
  const sandbox = { native: transport, exports: {} as { createPerryRuntime(): IPerryRuntime } };
  runInNewContext(
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
  );
  const tsl = sandbox.exports.createPerryRuntime().tsl;
  if (!tsl) throw new Error("missing TSL runtime");
  tsl.setPost(42);
  const call = transport.setPost.mock.calls[0];
  expect(call?.[0]).toBe(123);
  expect(values.get(call?.[1] as number)).toBe(42);
  expect(transport.free).toHaveBeenLastCalledWith(call?.[1]);
  tsl.setPost(null);
  expect(transport.setPost).toHaveBeenLastCalledWith(123, 0);
  refusal = true;
  expect(() => tsl.setPost(999)).toThrow("TN_PERRY_POST: not a TSL node of this context");
});
vi.mock("../src/perry-transport.js", () => ({ createPerryRuntime: () => native }));
vi.mock("tn-native-transport", () => ({
  playerRenderInfo: (field: number) => (field === 0 ? 3 : 36),
  playerAdapterInfo: () => '{"architecture":"swiftshader","vendor":"google"}',
}));
const { bindPerryEngine } = await import("../src/perry-entry.js");

it("wires the bound renderer to the player's observation transport", async () => {
  const bound = bindPerryEngine(["WebGPURenderer"]);
  const Renderer = bound.WebGPURenderer as ReturnType<
    typeof import("../src/perry-renderer.js").definePerryRenderer
  >;
  const renderer = new Renderer();
  expect(renderer.info.render).toMatchObject({ drawCalls: 3, calls: 3, triangles: 36 });
  expect(await renderer.backend.gpu.requestAdapter()).toEqual({
    info: { architecture: "swiftshader", vendor: "google" },
    limits: {},
  });
});

it("answers instanceof by the prototype chain, which Perry's class-id check gets wrong", () => {
  const b = bindPerryEngine([
    "Object3D",
    "Mesh",
    "Group",
    "Material",
    "MeshBasicMaterial",
    // A refused export throws on any read, so binding must not probe it.
    "AONode",
  ]) as Record<string, { prototype: object; [Symbol.hasInstance]: (value: unknown) => boolean }>;
  for (const name of ["Object3D", "Mesh", "Group", "Material"])
    expect(Object.hasOwn(b[name] as object, Symbol.hasInstance), name).toBe(true);
  const hasInstance = (cls: string, value: unknown) =>
    (b[cls] as (typeof b)[string])[Symbol.hasInstance](value);
  const group = Object.create((b.Group as (typeof b)[string]).prototype) as object;
  expect(hasInstance("Object3D", group)).toBe(true);
  expect(hasInstance("Mesh", group)).toBe(false);
  const material = Object.create((b.MeshBasicMaterial as (typeof b)[string]).prototype) as object;
  expect(hasInstance("Material", material)).toBe(true);
  expect(hasInstance("Object3D", null)).toBe(false);
});

describe("Perry pass and RenderPipeline", () => {
  function fixture() {
    return bindPerryEngine([
      "pass",
      "mrt",
      "output",
      "normalView",
      "metalness",
      "roughness",
      "float",
      "vec2",
      "max",
      "smoothstep",
      "screenUV",
      "convertToTexture",
      "color",
      "RenderPipeline",
    ]) as unknown as Tsl & {
      RenderPipeline: ReturnType<typeof defineRenderPipeline>;
      __tnTsl: IEffectTsl;
    };
  }

  it("binds pass, MRT and the template's vignette/bloom/AA chain to the shared pipeline", () => {
    const b = fixture();
    const scene = {} as Parameters<Tsl["pass"]>[0];
    const camera = {} as Parameters<Tsl["pass"]>[1];
    const p = b.pass(scene, camera);
    p.setMRT(b.mrt({ output: b.output, normal: b.normalView }));
    const base = p.getTextureNode("output");
    const depth = p.getTextureNode("depth");
    const normal = p.getTextureNode("normal");
    const effects = definePostEffects(b.__tnTsl);
    const contact = effects.ao(depth, normal, camera);
    const occlusion = effects.denoise(
      contact.getTextureNode?.(),
      depth,
      normal,
      camera,
    ) as unknown as ReturnType<Tsl["vec4"]>;
    const radius = b.screenUV.sub(b.vec2(0.5, 0.5)).mul(b.vec2(1.78, 1)).length().mul(1.04);
    const fall = b.smoothstep(b.float(0.55), b.float(1.02), radius).mul(0.2);
    const lit = base.mul(0.62).mul(occlusion.r);
    const glow = effects.bloom(b.convertToTexture(lit), 0.22, 0.6, 1) as unknown as ReturnType<
      Tsl["vec4"]
    >;
    const colour = lit.add(glow).mul(fall.oneMinus());
    const peak = b.max(colour.r, b.max(colour.g, colour.b));
    const squeezed = colour.div(peak.add(1));
    const filtered = effects.smaa(squeezed) as unknown as ReturnType<Tsl["vec4"]>;
    const back = b.max(filtered.r, b.max(filtered.g, filtered.b));
    const output = filtered.div(b.float(1).sub(back).max(1e-4));
    const renderer = { render: vi.fn() };
    const pipeline = new b.RenderPipeline(renderer, output);
    pipeline.render();
    expect(native.tsl.setPost).toHaveBeenLastCalledWith(Reflect.get(output, TSL_NODE));
    expect(renderer.render).toHaveBeenLastCalledWith(scene, camera);
    const otherCamera = {} as Parameters<Tsl["pass"]>[1];
    p.camera = otherCamera;
    pipeline.render();
    expect(renderer.render).toHaveBeenLastCalledWith(scene, otherCamera);
    pipeline.dispose();
    expect(native.tsl.setPost).toHaveBeenLastCalledWith(null);
  });

  it("fails by name for invalid output and for a renderer without a pass target or redraw", () => {
    const b = fixture();
    const renderer = { render: vi.fn() };
    expect(() => new b.RenderPipeline(renderer, {}).render()).toThrow("TN_WASM_POST");
    const pipeline = new b.RenderPipeline(renderer, b.float(1));
    expect(() => pipeline.render()).toThrow("TN_NATIVE_POST_TARGET");
    expect(renderer.render).not.toHaveBeenCalled();
    const redraw = vi.fn();
    new b.RenderPipeline({ [RENDER_AGAIN]: redraw }, b.float(1)).render();
    expect(redraw).toHaveBeenCalledOnce();
  });
});
