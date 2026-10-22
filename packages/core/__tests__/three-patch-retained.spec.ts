import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Data3DTexture, DepthTexture, EventDispatcher } from "three";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const threeRoot = resolve(dirname(createRequire(import.meta.url).resolve("three")), "..");
let root: string;
let utilsModule: Awaited<ReturnType<typeof importModule>>;
let texturesModule: Awaited<ReturnType<typeof importModule>>;

async function importModule(file: string) {
  return import(/* @vite-ignore */ pathToFileURL(join(root, file)).href);
}

beforeAll(async () => {
  root = await makeTempDir("threenative-retained-patch-");
  const files = [
    "src/renderers/common/Textures.js",
    "src/renderers/webgpu/utils/WebGPUTextureUtils.js",
  ];
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await cp(join(threeRoot, file), join(root, file));
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  if (process.env.TN_THREE_PATCH_STOCK === "1") {
    const patch = readFileSync(new URL("../patches/three@0.185.1.patch", import.meta.url), "utf8")
      .split(/(?=^diff --git )/mu)
      .filter((block) => files.includes(/^diff --git a\/(\S+) /mu.exec(block)?.[1] ?? ""))
      .join("");
    const inverse = join(root, "stock.patch");
    await writeFile(inverse, patch);
    await promisify(execFile)(
      "patch",
      ["--reverse", "--batch", "--fuzz=0", "--silent", "-p1", "-i", inverse],
      { cwd: root },
    );
    for (const file of files) {
      const block = patch
        .split(/(?=^diff --git )/mu)
        .find((section) => section.startsWith(`diff --git a/${file} `));
      const expected = /^index ([a-f0-9]{40})/mu.exec(block ?? "")?.[1];
      // @ts-expect-error -- the generator is plain ESM with no type declarations.
      const { blobHash } = await import("../scripts/generate-three-patch.mjs");
      expect(blobHash(await readFile(join(root, file), "utf8"))).toBe(expected);
    }
  }
  // Keep the two observed files isolated; resolve their unchanged dependencies from the pin.
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    await writeFile(
      join(root, file),
      source.replace(
        /from (['"])(\.[^'"]+)\1/gu,
        (_match, quote: string, relative: string) =>
          `from ${quote}${pathToFileURL(resolve(dirname(join(threeRoot, file)), relative)).href}${quote}`,
      ),
    );
  }
  utilsModule = await importModule("src/renderers/webgpu/utils/WebGPUTextureUtils.js");
  texturesModule = await importModule("src/renderers/common/Textures.js");
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

function backendData() {
  const records = new Map<object, Record<string, unknown>>();
  return {
    get(key: object) {
      let data = records.get(key);
      if (!data) {
        data = {};
        records.set(key, data);
      }
      return data;
    },
    delete(key: object) {
      records.delete(key);
    },
  };
}

it("retains distinct depth buffers across sample-count switches and destroys them on resize", () => {
  const canvas = Object.assign(new EventDispatcher<{ resize: object }>(), {
    depthTexture: new DepthTexture(1, 1),
  });
  const renderer = { currentSamples: 4, reversedDepthBuffer: false, getCanvasTarget: () => canvas };
  let width = 16;
  const backend = {
    ...backendData(),
    renderer,
    getDrawingBufferSize: () => ({ width, height: 16 }),
    utils: { getSampleCount: (samples: number) => samples || 1 },
  };
  const utils = new utilsModule.default(backend);
  const create = vi.fn((texture: object) => {
    backend.get(texture).texture = { destroy: vi.fn() };
  });
  utils.createTexture = create;
  const four = utils.getDepthBuffer(true, false);
  renderer.currentSamples = 0;
  const one = utils.getDepthBuffer(true, false);
  renderer.currentSamples = 4;
  expect(utils.getDepthBuffer(true, false)).toBe(four);
  expect(one).not.toBe(four);
  expect(create).toHaveBeenCalledTimes(2);
  canvas.dispatchEvent({ type: "resize" });
  expect(four.destroy).toHaveBeenCalledTimes(1);
  expect(one.destroy).toHaveBeenCalledTimes(1);
  width = 32;
  expect(utils.getDepthBuffer(true, false)).not.toBe(four);
  utils.dispose();
});

it("omits render-attachment usage for sampled 3D textures while preserving attachment overrides", () => {
  vi.stubGlobal("GPUTextureUsage", {
    TEXTURE_BINDING: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  });
  const createTexture = vi.fn((_descriptor: { dimension: string; usage: number }) => ({}));
  const backend = {
    ...backendData(),
    device: { createTexture },
    utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) },
  };
  const utils = new utilsModule.default(backend);
  for (const needsMipmaps of [false, true]) {
    const texture = new Data3DTexture(new Uint8Array(32), 2, 2, 2);
    texture.internalFormat = "rgba8unorm" as unknown as typeof texture.internalFormat;
    utils.createTexture(texture, { width: 2, height: 2, depth: 2, needsMipmaps });
    expect(createTexture.mock.calls.at(-1)?.[0]).toMatchObject({
      dimension: "3d",
      usage: needsMipmaps ? 23 : 7,
    });
  }
});

it("invalidates every cached bind group before recreating a destroyed render-target texture", () => {
  const groups = [{}, {}];
  const backend = {
    ...backendData(),
    destroyTexture: vi.fn(),
    createTexture: vi.fn(),
    createSampler: vi.fn(),
    destroySampler: vi.fn(),
  };
  const manager = new texturesModule.default({}, backend, { memory: { textures: 0 } });
  const texture = new DepthTexture(16, 16);
  texture.needsUpdate = true;
  Object.assign(manager.get(texture), { initialized: true, version: 0, bindGroups: groups });
  for (const group of groups)
    Object.assign(backend.get(group), { groups: ["stale"], versions: [1], unrelated: "keep" });
  backend.createTexture.mockImplementation(() => {
    for (const group of groups)
      expect(backend.get(group)).toEqual({
        forceUpdate: true,
        groups: undefined,
        versions: undefined,
        unrelated: "keep",
      });
  });
  manager.updateTexture(texture);
  expect(backend.destroyTexture).toHaveBeenCalledWith(texture);
  expect(backend.createTexture).toHaveBeenCalledTimes(1);
});
