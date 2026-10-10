import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { loadCatalog } from "../src/catalog.js";
import * as textures from "../src/texture-sources.js";

afterEach(() => vi.unstubAllGlobals());

it("decodes encoded bytes natively and adopts each bitmap once with the V8 flipY semantics", async () => {
  const writes = vi.fn();
  const types = new Map<string, number>();
  const typeId = (name: string) =>
    types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
  const construct = vi.fn((name: string) => ({ type: typeId(name), key: name }));
  const runtime: IBrowserRuntime = {
    typeId,
    construct,
    invoke: () => undefined,
    release() {},
    setCallback() {},
    get: (_ref, name) =>
      name === "image.width"
        ? 4
        : name === "image.height"
          ? 2
          : name === "flipY"
            ? true
            : undefined,
    set: writes,
  };
  const registry = JSON.parse(
    readFileSync(new URL("../api/native-registry.json", import.meta.url), "utf8"),
  ) as IRegistryDump;
  const engine = defineBrowserClasses(registry, runtime, loadCatalog(process.cwd()));
  const bound = textures.defineTextureSources(engine.classes, runtime);
  const load = vi.fn((_kind: number, bytes: Uint8Array) => {
    if (bytes[0] !== 137) throw new Error("TN_NATIVE_IMAGE_DECODE: invalid image");
    return [engine.wrap({ type: typeId("Texture"), key: `image:${load.mock.calls.length}` })];
  });
  const source = readFileSync(new URL("../src/perry-host.ts", import.meta.url), "utf8")
    .replace(/import\s*\{([^}]+)\}\s*from "tn-native-transport";/u, "const {$1} = native;")
    .replace(
      'import { createPerryAudioHost } from "./perry-audio.js";',
      "const createPerryAudioHost = () => ({ AudioContext: class {}, update() {}, close() {} });",
    )
    .replace(
      'import { createPerryPhysicsHost } from "./perry-physics.js";',
      "const createPerryPhysicsHost = () => ({});",
    )
    .replace('import { __tnLoadAsset } from "three";', "const __tnLoadAsset = load;")
    .replace(
      'import { nativeImageBitmaps } from "./texture-sources.js";',
      "const nativeImageBitmaps = bitmaps;",
    );
  const sandbox = {
    native: { playerRunner: () => 0, playerBind: () => 0 },
    load,
    bitmaps: textures.nativeImageBitmaps,
    exports: {},
    require: createRequire(import.meta.url),
    process: { env: {} },
    fetch,
    setTimeout,
    // Perry: Blob/Response.arrayBuffer() answer a Buffer, a Uint8Array that isView rejects.
    ArrayBuffer: {
      [Symbol.hasInstance]: (value: unknown) => value instanceof ArrayBuffer,
      isView: () => false,
    },
    Uint8Array,
  } as unknown as {
    createImageBitmap(source: unknown, ...options: unknown[]): Promise<ImageBitmap>;
  };
  runInNewContext(
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
  );
  expect(typeof sandbox.createImageBitmap).toBe("function");
  const Texture = bound.Texture as new (image: unknown) => { flipY: boolean; needsUpdate: boolean };
  for (const flipped of [false, true]) {
    const bytes = new Uint8Array([0, 137, 80, 0]).subarray(1, 3);
    const bitmap = await sandbox.createImageBitmap(
      { arrayBuffer: async () => bytes },
      { imageOrientation: flipped ? "flipY" : "none" },
    );
    expect(bitmap).toMatchObject({ width: 4, height: 2 });
    expect(load).toHaveBeenLastCalledWith(2, new Uint8Array([137, 80]));
    const texture = new Texture(bitmap);
    expect(texture.flipY).toBe(true);
    expect(writes.mock.calls.at(-1)?.slice(1)).toEqual(["flipY", !flipped]);
    texture.flipY = false;
    expect(writes.mock.calls.at(-1)?.slice(1)).toEqual(["flipY", flipped]);
    texture.needsUpdate = true;
    expect(writes.mock.calls.at(-1)?.slice(1)).toEqual(["needsUpdate", true]);
    expect(() => new Texture(bitmap)).toThrow("TN_NATIVE_IMAGE_BITMAP_CLOSED");
    bitmap.close();
  }
  const bitmap = await sandbox.createImageBitmap(new Uint8Array([137]).buffer);
  bitmap.close();
  expect(() => new Texture(bitmap)).toThrow("TN_NATIVE_IMAGE_BITMAP_CLOSED");
  expect(construct).not.toHaveBeenCalled();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([137]))),
  );
  vi.stubGlobal("createImageBitmap", sandbox.createImageBitmap);
  const loader = new (
    bound.ImageBitmapLoader as new () => {
      loadAsync(url: string): Promise<ImageBitmap>;
    }
  )();
  const loaded = await loader.loadAsync("sky.jpg");
  new Texture(loaded).needsUpdate = true;
  expect(load).toHaveBeenLastCalledWith(2, new Uint8Array([137]));
  for (const option of [
    { premultiplyAlpha: "premultiply" },
    { resizeWidth: 1 },
    { resizeHeight: 1 },
    { resizeQuality: "high" },
  ]) {
    await expect(sandbox.createImageBitmap(new Uint8Array([137]), option)).rejects.toThrow(
      `TN_NATIVE_IMAGE_BITMAP_OPTION: ${Object.keys(option)[0]}`,
    );
  }
  await expect(sandbox.createImageBitmap(new Uint8Array([137]), 0, 0, 1, 1)).rejects.toThrow(
    "TN_NATIVE_IMAGE_BITMAP_CROP",
  );
  await expect(sandbox.createImageBitmap("image.png")).rejects.toThrow(
    "TN_NATIVE_IMAGE_BITMAP_SOURCE",
  );
  await expect(sandbox.createImageBitmap(new Uint8Array([0]))).rejects.toThrow(
    "TN_NATIVE_IMAGE_DECODE",
  );
});
