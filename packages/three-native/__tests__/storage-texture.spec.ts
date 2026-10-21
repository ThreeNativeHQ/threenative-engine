import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { bindUpstreamExports } from "../src/browser-entry.js";
import { type ITslRuntime, type TslArgValue, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";

const catalog = loadCatalog(process.cwd());
const registry = JSON.parse(
  readFileSync(path.join(process.cwd(), "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

function facade() {
  let serial = 0;
  const runtime: IBrowserRuntime = {
    typeId: () => 137,
    construct: vi.fn(() => ({ key: `StorageTexture:0:${++serial}:1`, type: 137 })),
    invoke: vi.fn(() => null),
    get: vi.fn(() => 0),
    set: vi.fn(),
    release: vi.fn(),
    setCallback: vi.fn(),
  };
  const { classes } = defineBrowserClasses(registry, runtime, catalog);
  const calls: { name: string; args: readonly TslArgValue[] }[] = [];
  const tslRuntime: ITslRuntime = {
    call: (name, _receiver, args) => {
      calls.push({ name, args });
      return ++serial;
    },
    release: vi.fn(),
    set: vi.fn(),
    setUniform: vi.fn(),
    setPost: vi.fn(),
    effectParameter: vi.fn(),
    compute: vi.fn(),
    readStorage: vi.fn(),
    deleteStorage: vi.fn(),
  };
  return { classes, calls, runtime, tsl: defineTsl(tslRuntime, classes as never).exports };
}

interface INode {
  isStorageTextureNode: boolean;
  value: unknown;
  store(uv: unknown, value: unknown): INode;
  toStack(): INode;
  compute(count: number): { isComputeNode: boolean };
}

describe("native storage textures", () => {
  it("catalogs the Texture subclass and binds the public export without a refusal", () => {
    const entry = catalog.entries.find((entry) => entry.name === "StorageTexture");
    expect(entry).toMatchObject({
      kind: "class",
      source: "three/webgpu",
      extends: "Texture",
      status: { kind: "supported" },
      constructor: [
        { name: "width", default: "1" },
        { name: "height", default: "1" },
      ],
    });
    const { classes, runtime } = facade();
    const bound = bindUpstreamExports(["StorageTexture"], catalog, classes);
    const Texture = bound.StorageTexture as new (
      width?: number,
      height?: number,
    ) => {
      isStorageTexture: boolean;
      setSize(width: number, height: number): void;
      dispose(): void;
    };
    const texture = new Texture(4, 4);
    expect(texture).toBeInstanceOf(classes.Texture as never);
    expect(texture.isStorageTexture).toBe(true);
    texture.setSize(8, 2);
    texture.dispose();
    expect(runtime.construct).toHaveBeenCalledWith("StorageTexture", [4, 4]);
    expect(runtime.invoke).toHaveBeenCalledWith(expect.anything(), "setSize", [8, 2]);
    expect(runtime.invoke).toHaveBeenCalledWith(expect.anything(), "dispose", []);
  });

  it("passes the same texture handle to compute stores and later sampled reads", () => {
    const { classes, tsl, calls } = facade();
    const texture = new (classes.StorageTexture as new (w: number, h: number) => object)(4, 4);
    const uvec2 = tsl.uvec2 as (...args: unknown[]) => INode;
    const vec4 = tsl.vec4 as (...args: unknown[]) => INode;
    const textureStore = tsl.textureStore as (...args: unknown[]) => INode;
    const storageTexture = tsl.storageTexture as (...args: unknown[]) => INode;
    const Fn = tsl.Fn as (callback: () => void) => () => INode;
    const kernel = Fn(() => {
      const coordinate = uvec2(1, 2);
      const value = vec4(0.25, 0.5, 0.375, 1);
      const stored = textureStore(texture, coordinate, value);
      expect(stored.isStorageTextureNode).toBe(true);
      expect(stored.value).toBe(texture);
      const node = storageTexture(texture);
      expect(node.isStorageTextureNode).toBe(true);
      expect(node.value).toBe(texture);
      textureStore(node, coordinate, value);
      node.store(coordinate, value);
      storageTexture(texture, coordinate, value).toStack();
    })().compute(16);
    expect(kernel.isComputeNode).toBe(true);
    const stores = calls.filter((call) => call.name === "textureStore");
    expect(stores).toHaveLength(4);
    expect(stores[0]?.args.map((arg) => arg.kind)).toEqual(["handle", "node", "node"]);
    expect(stores[1]?.args.map((arg) => arg.kind)).toEqual(["node", "node", "node"]);
    const sample = (tsl.texture as (...args: unknown[]) => { level(value: number): object })(
      texture,
    );
    sample.level(0);
    expect(calls.find((call) => call.name === "texture")?.args[0]).toEqual(stores[0]?.args[0]);
    expect(calls.at(-1)?.name).toBe("level");
    expect(() => textureStore(texture, uvec2(0), vec4(1))).toThrow(/outside Fn|Fn/u);
  });
});
