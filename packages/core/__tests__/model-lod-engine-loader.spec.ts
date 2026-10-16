import { Group } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetLoader } from "../src/assets.js";

// PRD-617: the Wasm engine's GLTFLoader (three-native/src/addons/gltf-loader-web.ts) hosts no
// plugin and refuses `register` by name. A cooked `TN_discrete_lod` model must still load there,
// at the full detail LOD0 holds, instead of failing the whole game's start.
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    readonly hostsPlugins = false;
    register(): never {
      throw new Error(
        "TN_NATIVE_GLTF_PLUGIN_UNSUPPORTED: the engine glTF loader does not take this",
      );
    }
    parse(_data: unknown, _path: string, onLoad: (gltf: object) => void): void {
      onLoad({ scene: new Group(), animations: [] });
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a TN_discrete_lod model on a loader that hosts no plugins", () => {
  it("loads at full detail and names the skipped chain", async () => {
    const json = new TextEncoder().encode(
      JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ["TN_discrete_lod"] }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("assets.manifest.json")
          ? { headers: { get: () => null }, ok: false, status: 404 }
          : {
              arrayBuffer: async () =>
                json.buffer.slice(json.byteOffset, json.byteOffset + json.byteLength),
              ok: true,
              status: 200,
            },
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = await createAssetLoader({ basePath: "" }).model<{ scene: Group }>("ship.glb");
    expect(value.scene).toBeInstanceOf(Group);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TN_DISCRETE_LOD_UNAVAILABLE ship.glb"),
    );
  });
});
