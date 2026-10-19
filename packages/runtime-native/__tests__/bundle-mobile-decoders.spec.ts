import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { type CompressedTexture, RGBA_ASTC_4x4_Format } from "three";
import type { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { expect, test, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const run = promisify(execFile);
const bundlerScript = path.resolve("packages/runtime-native/scripts/bundle.mjs");
const viteInstall = path.resolve("packages/create-threenative/node_modules/vite");

/** A stand-in `three` whose three decoder modules sit at the paths the stub plugin matches. */
async function project(): Promise<string> {
  const root = path.join(await makeTempDir("threenative-mobile-decoders-"), "project");
  const three = path.join(root, "node_modules/three");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(three, "examples/jsm/loaders"), { recursive: true });
  await mkdir(path.join(three, "examples/jsm/libs"), { recursive: true });
  await symlink(viteInstall, path.join(root, "node_modules/vite"));
  await writeFile(path.join(root, "package.json"), '{"name":"decoders","type":"module"}\n');
  await writeFile(path.join(three, "package.json"), '{"name":"three","type":"module"}\n');
  await writeFile(
    path.join(three, "examples/jsm/loaders/KTX2Loader.js"),
    'export class KTX2Loader { kind() { return "real-ktx2"; } }\n',
  );
  await writeFile(
    path.join(three, "examples/jsm/libs/meshopt_decoder.module.js"),
    'export const MeshoptDecoder = { kind: "real-meshopt" };\n',
  );
  await writeFile(
    path.join(three, "examples/jsm/loaders/DRACOLoader.js"),
    'export class DRACOLoader { kind() { return "real-draco"; } }\n',
  );
  await writeFile(
    path.join(root, "src/game.ts"),
    `import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
export default { start() { globalThis.used = [KTX2Loader, MeshoptDecoder, DRACOLoader]; return Promise.resolve(); } };
`,
  );
  return root;
}

async function bundle(root: string, extra: string[]): Promise<string> {
  const output = path.join(root, "dist/android.js");
  await run(
    process.execPath,
    [bundlerScript, "--project", root, "--entry", "src/game.ts", "--target", "android"]
      .concat(["--output", output])
      .concat(extra),
    { cwd: root },
  );
  return readFile(output, "utf8");
}

test("an Android bundle keeps the real loader only for the codecs --decoders admits", async () => {
  const root = await project();
  const stubbed = await bundle(root, []);
  expect(stubbed).toContain("TN_NATIVE_KTX2_UNSUPPORTED");
  expect(stubbed).toContain("TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED");
  expect(stubbed).toContain("real-ktx2");
  expect(stubbed).not.toMatch(/real-meshopt|real-draco/u);

  const admitted = await bundle(root, ["--decoders", "ktx2,meshopt"]);
  expect(admitted).toContain("real-ktx2");
  expect(admitted).toContain("real-meshopt");
  expect(admitted).not.toContain("TN_NATIVE_KTX2_UNSUPPORTED");
  // Draco is not admitted, so its stub (which shares the mesh message) still replaces it.
  expect(admitted).not.toContain("real-draco");
  expect(admitted).toContain("TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED");
}, 60_000);

test("--decoders refuses a codec name it does not know", async () => {
  const root = await project();
  await expect(bundle(root, ["--decoders", "ktx2,basis"])).rejects.toThrow(
    /unknown codec\(s\): basis/u,
  );
}, 60_000);

// Encoder/emitter captures shared with core's raw-ASTC loader checks: full 8x8 mip chains.
const rawAstc = [
  "q0tUWCAyMLsNChoKnQAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAAAAAAAsAAAACwAAADcAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAwAQAAAAAAAEAAAAAAAAAAQAAAAAAAAAAgAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAQAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACiAQEAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////xsAAABLVFh3cml0ZXIAS1RYLVBhcnNlIHYxLjEuMAAAAAAAAPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogIA=",
  "q0tUWCAyMLsNChoKngAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAAAAAAAsAAAACwAAADcAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAwAQAAAAAAAEAAAAAAAAAAQAAAAAAAAAAgAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAQAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACiAQIAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////xsAAABLVFh3cml0ZXIAS1RYLVBhcnNlIHYxLjEuMAAAAAAAAPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogIA=",
];

test("decoder-free bundles retain Three's raw ASTC loader and refuse Basis and ZSTD", async () => {
  const root = await project();
  await rm(path.join(root, "node_modules/three"), { recursive: true });
  await symlink(
    path.resolve("packages/runtime-native/node_modules/three"),
    path.join(root, "node_modules/three"),
  );
  await writeFile(
    path.join(root, "src/game.ts"),
    `
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { KTX2Loader as alias } from "three/addons/loaders/KTX2Loader.js";
import { createKtx2Loader } from ${JSON.stringify(path.resolve("packages/core/src/assets.ts"))};
export default { async start() { globalThis.used = { KTX2Loader, alias, createKtx2Loader }; } };
`,
  );
  const source = await bundle(root, []);
  expect(source).not.toMatch(/\bWebAssembly\b/u);
  const fetchSpy = vi.fn(fetch);
  const worker = vi.fn(() => {
    throw new Error("unexpected worker");
  });
  const context = {
    URL,
    TextDecoder,
    AbortController,
    AbortSignal,
    Headers,
    Request,
    fetch: fetchSpy,
    Worker: worker,
    console,
    document: { getElementById: () => ({}), querySelector: () => null },
    used: undefined as unknown,
  };
  runInNewContext(source, context);
  const {
    KTX2Loader: Loader,
    alias,
    createKtx2Loader,
  } = context.used as {
    KTX2Loader: typeof KTX2Loader;
    alias: typeof KTX2Loader;
    createKtx2Loader: typeof import("../../core/src/assets.js").createKtx2Loader;
  };
  expect(alias).toBe(Loader);
  const shared = await createKtx2Loader({
    renderer: {
      isWebGPURenderer: true,
      hasFeature: (feature: string) => feature === "texture-compression-astc",
    },
  });
  expect(shared).toBeInstanceOf(Loader);
  (shared as unknown as KTX2Loader).dispose();
  await expect(
    createKtx2Loader({ renderer: { isWebGPURenderer: true, hasFeature: () => false } }),
  ).rejects.toThrow(/TN_ASSETS_KTX2_UNSUPPORTED/u);
  const loader = new Loader();
  expect(loader.setTranscoderPath("/never-fetch-basis/").setWorkerLimit(1)).toBe(loader);
  const support = vi.fn((feature: string) => feature === "texture-compression-astc");
  expect(loader.detectSupport({ isWebGPURenderer: true, hasFeature: support } as never)).toBe(
    loader,
  );
  expect(support).toHaveBeenCalledWith("texture-compression-astc");
  const init = vi.spyOn(loader, "init");
  const parse = (bytes: Uint8Array) =>
    new Promise<CompressedTexture>((resolve, reject) => {
      loader.parse(bytes.buffer as ArrayBuffer, resolve, reject);
    });
  for (const [index, base64] of rawAstc.entries()) {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    expect(new DataView(bytes.buffer).getUint32(12, true)).toBe(157 + index);
    const texture = await parse(bytes);
    expect(texture.format).toBe(RGBA_ASTC_4x4_Format);
    expect(texture.colorSpace).toBe(index === 0 ? "srgb-linear" : "srgb");
    expect(texture.mipmaps.map((mip) => [mip.width, mip.height, mip.data.byteLength])).toEqual([
      [8, 8, 64],
      [4, 4, 16],
      [2, 2, 16],
      [1, 1, 16],
    ]);
    for (const mip of texture.mipmaps) {
      expect(Buffer.from(mip.data).toString("hex")).toBe(
        "fcfdfffffffffffff0f0141428288080".repeat(mip.data.byteLength / 16),
      );
    }
    texture.dispose();
  }
  const loaded = await new Promise<CompressedTexture>((resolve, reject) => {
    loader.load(`data:application/octet-stream;base64,${rawAstc[0]}`, resolve, undefined, reject);
  });
  expect(loaded.mipmaps).toHaveLength(4);
  loaded.dispose();
  expect(init).not.toHaveBeenCalled();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  // Valid captures: UASTC Basis from the installed encoder, raw ASTC with each mip ZSTD-compressed.
  const basis =
    "q0tUWCAyMLsNChoKAAAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAACAAAAsAAAACwAAADcAAAAJAAAAAAAAAAAAAAAAAAAAAAAAABLAQAAAAAAABoAAAAAAAAAQAAAAAAAAAAyAQAAAAAAABkAAAAAAAAAEAAAAAAAAAAZAQAAAAAAABkAAAAAAAAAEAAAAAAAAAAAAQAAAAAAABkAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACmAQIAAwMAABAAAAAAAAAAAAB/AwAAAAAAAAAA/////x8AAABLVFh3cml0ZXIAQmFzaXMgVW5pdmVyc2FsIDIuNTAAACi1L/0gEIEAABcQEBAQQAgBAAAAAAAAAAAotS/9IBCBAAAXEBAQEEAIAQAAAAAAAAAAKLUv/SAQgQAAFxAQEBBACAEAAAAAAAAAACi1L/0gQI0AAEgXEBAQEEAIAQACAM2MIANH";
  const zstd =
    "q0tUWCAyMLsNChoKnQAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAACAAAAsAAAACwAAADcAAAAIAAAAAAAAAAAAAAAAAAAAAAAAABTAQAAAAAAACAAAAAAAAAAQAAAAAAAAAA2AQAAAAAAAB0AAAAAAAAAEAAAAAAAAAAZAQAAAAAAAB0AAAAAAAAAEAAAAAAAAAD8AAAAAAAAAB0AAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACiAQEAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////xsAAABLVFh3cml0ZXIAS1RYLVBhcnNlIHYxLjAuMQAAKLUv/QRYgQAA/P3////////w8BQUKCiAgBANsXYotS/9BFiBAAD8/f////////DwFBQoKICAEA2xdii1L/0EWIEAAPz9////////8PAUFCgogIAQDbF2KLUv/QRYnQAAWPz9//DwFBQoKICAAgDNDN6CIXAwVtk=";
  for (const base64 of [basis, zstd]) {
    await expect(parse(Uint8Array.from(Buffer.from(base64, "base64")))).rejects.toThrow(
      /TN_NATIVE_KTX2_UNSUPPORTED/u,
    );
  }
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(worker).not.toHaveBeenCalled();
  expect(init).toHaveBeenCalledTimes(1);
  loader.dispose();
  for (const extra of [
    ["--decoders", "ktx2"],
    ["--target", "desktop"],
  ]) {
    const unrestricted = await bundle(root, extra);
    expect(unrestricted).toMatch(/\bWebAssembly\b/u);
    expect(unrestricted).not.toContain("TN_NATIVE_KTX2_UNSUPPORTED");
  }
}, 60_000);
