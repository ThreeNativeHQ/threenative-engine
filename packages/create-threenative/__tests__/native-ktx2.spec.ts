import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Document, GLB_BUFFER, NodeIO } from "@gltf-transform/core";
import { compileAssets, modelPass } from "@threenative/assets";
import { read as readKTX2, write as writeKTX2 } from "ktx-parse";
import { encodeToKTX2 } from "ktx2-encoder";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFixtureGlb } from "../../../test-support/generate-fixture-model.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  assertNativeAssetsCompatible,
  assertNativeBundleCompatible,
  build,
  resolveRuntimeAssetCapabilities,
} from "../src/build.js";
import { loadConfig } from "../src/config.js";

const run = promisify(execFile);
const roots: string[] = [];
const bundler = path.resolve("packages/runtime-native/scripts/bundle.mjs");
const desktopV8 = () =>
  resolveRuntimeAssetCapabilities(
    "desktop",
    path.resolve("packages/create-threenative/src/build.ts"),
    (() => ({ status: 0, stdout: "+ v8 build" })) as never,
  );
const androidV8 = () =>
  resolveRuntimeAssetCapabilities("android", undefined, undefined, {
    THREENATIVE_GRADLE_ARGS: "-PthreenativeJsEngine=v8",
  });
const androidQuickJs = () =>
  resolveRuntimeAssetCapabilities("android", undefined, undefined, {
    THREENATIVE_GRADLE_ARGS: "-PthreenativeJsEngine=quickjs",
  });
const viteInstall = path.resolve(import.meta.dirname, "../node_modules/vite");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * A project laid out the way a scaffolded game is: its own `package.json`, the pinned Vite the
 * native bundler requires, and `@threenative/core` installed under `node_modules`.
 */
async function gameProject(prefix: string): Promise<string> {
  const project = await makeTempDir(prefix);
  roots.push(project);
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "node_modules/@threenative"), { recursive: true });
  await symlink(viteInstall, path.join(project, "node_modules/vite"));
  await symlink(
    path.resolve("packages/core"),
    path.join(project, "node_modules/@threenative/core"),
  );
  await writeFile(path.join(project, "package.json"), '{"name":"ktx2-proof","type":"module"}\n');
  await writeFile(
    path.join(project, "src/game.ts"),
    `import { defineGame } from "@threenative/core";
export default defineGame({ scenes: {} });
`,
  );
  return project;
}

async function bundle(
  project: string,
  target: "android" | "desktop" | "ios",
  nativeBackend = false,
): Promise<string> {
  const output = path.join(project, `dist/${target}.js`);
  await run(
    process.execPath,
    [
      bundler,
      "--project",
      project,
      "--entry",
      "src/game.ts",
      "--target",
      target,
      "--output",
      output,
      ...(nativeBackend ? ["--native-backend"] : []),
    ],
    { cwd: project },
  );
  return output;
}

/** A plain web bundle of the project, built by the project's own Vite. */
const WEB_BUILD_SCRIPT = `import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { build } = await import(
  pathToFileURL(createRequire(\`\${process.cwd()}/package.json\`).resolve("vite")).href
);
await build({
  build: {
    emptyOutDir: false,
    lib: { entry: "src/game.ts", fileName: () => "web.js", formats: ["es"] },
    minify: false,
    outDir: "dist-web",
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  configFile: false,
  logLevel: "silent",
  root: process.cwd(),
});
`;

/** Writes a compiled-asset manifest of the shape `@threenative/assets` emits. */
async function writeManifest(
  project: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  await mkdir(path.join(project, "public"), { recursive: true });
  await writeFile(
    path.join(project, "public/assets.manifest.json"),
    `${JSON.stringify({ entries, version: 1 }, null, 2)}\n`,
  );
}

// Captured from the installed encodeToKTX2 + transcodeKtx2ToAstc at e49bb087f:
// separate UNORM/sRGB UASTC cooks of 8x8 RGBA [240,20,40,128], with all four mip levels.
const CAPTURED_ASTC = {
  linear:
    "q0tUWCAyMLsNChoKnQAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAAAAAAAsAAAACwAAADcAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAwAQAAAAAAAEAAAAAAAAAAQAAAAAAAAAAgAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAQAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACiAQEAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////xsAAABLVFh3cml0ZXIAS1RYLVBhcnNlIHYxLjEuMAAAAAAAAPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogIA=",
  srgb: "q0tUWCAyMLsNChoKngAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAAAAAAAsAAAACwAAADcAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAwAQAAAAAAAEAAAAAAAAAAQAAAAAAAAAAgAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAQAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAQAAAAAAABAAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACiAQIAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////xsAAABLVFh3cml0ZXIAS1RYLVBhcnNlIHYxLjEuMAAAAAAAAPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogID8/f////////DwFBQoKICA/P3////////w8BQUKCiAgPz9////////8PAUFCgogIA=",
} as const;

async function mobileAstcFixture(srgb = true): Promise<{ basis: Uint8Array; astc: Uint8Array }> {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([240, 20, 40, 128], i);
  const basis = await encodeToKTX2(new Uint8Array([0]), {
    generateMipmap: true,
    imageDecoder: async () => ({ data, height: 8, width: 8 }),
    isSetKTX2SRGBTransferFunc: srgb,
    isUASTC: true,
  });
  return {
    basis,
    astc: Uint8Array.from(Buffer.from(srgb ? CAPTURED_ASTC.srgb : CAPTURED_ASTC.linear, "base64")),
  };
}

async function packagedAstcModel(project: string, srgb = true): Promise<string> {
  const astc = Uint8Array.from(
    Buffer.from(srgb ? CAPTURED_ASTC.srgb : CAPTURED_ASTC.linear, "base64"),
  );
  const container = readKTX2(astc);
  const descriptor = container.dataFormatDescriptor[0];
  assert(descriptor);
  descriptor.colorPrimaries = srgb ? 1 : 0;
  const document = new Document();
  document.createBuffer();
  const texture = document.createTexture().setImage(writeKTX2(container)).setMimeType("image/ktx2");
  const material = document.createMaterial();
  if (srgb) material.setBaseColorTexture(texture);
  else material.setNormalTexture(texture);
  const io = new (class extends NodeIO {
    override async writeJSON(
      ...args: Parameters<NodeIO["writeJSON"]>
    ): ReturnType<NodeIO["writeJSON"]> {
      const output = await super.writeJSON(...args);
      output.json.extensionsUsed = ["EXT_texture_astc"];
      output.json.extensionsRequired = ["EXT_texture_astc"];
      output.json.textures = [{ extensions: { EXT_texture_astc: { source: 0 } } }];
      return output;
    }
  })();
  await mkdir(path.join(project, "public"), { recursive: true });
  await writeFile(path.join(project, "public/model.glb"), await io.writeBinary(document));
  await writeManifest(project, { model: { kind: "model", output: "model.glb" } });
  return path.join(project, "public/model.glb");
}

describe("compressed assets on native targets", () => {
  it.each([
    ["android", false],
    ["ios", true],
  ] as const)(
    "admits actual compiled ASTC models on %s (shared=%s)",
    async (target, sharedImages) => {
      const project = await gameProject("threenative-cooked-model-admission-");
      const document = await new NodeIO().readBinary(await buildFixtureGlb());
      const base = document.getRoot().listTextures()[0];
      const sourceImage = base?.getImage();
      assert(base && sourceImage);
      base.setImage(PNG.sync.write(PNG.sync.read(Buffer.from(sourceImage)), { deflateLevel: 0 }));
      await mkdir(path.join(project, "assets"), { recursive: true });
      await writeFile(
        path.join(project, "assets/model.glb"),
        await new NodeIO().writeBinary(document),
      );
      const decoders = { ktx2: false, meshopt: true, draco: false };
      await compileAssets({
        cwd: project,
        platform: target,
        runtimeDecoders: decoders,
        config: {
          budget: "none",
          models: {
            compact: false,
            virtual: "none",
            sharedImages,
            textures: {
              overrides: [
                { slot: "baseColorTexture", codec: "etc1s" },
                { slot: "normalTexture", codec: "none" },
              ],
            },
          },
        },
      });
      const manifest = JSON.parse(
        await readFile(path.join(project, "public/assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { output: string; sharedImages?: { output: string }[] }> };
      const entry = manifest.entries["model.glb"];
      assert(entry);
      if (sharedImages) expect(entry.sharedImages?.length).toBeGreaterThan(0);
      else expect(entry.sharedImages ?? []).toHaveLength(0);
      const { json, resources } = await new NodeIO().readAsJSON(
        path.join(project, "public", entry.output),
      );
      expect(json.extensionsUsed).toContain("EXT_texture_astc");
      expect(json.extensionsRequired).toContain("EXT_texture_astc");
      expect(json.extensionsUsed).not.toContain("KHR_texture_basisu");
      const owner = json.textures?.find((texture) => texture.extensions?.EXT_texture_astc);
      assert(owner);
      const source = (owner.extensions?.EXT_texture_astc as { source: number }).source;
      const image = json.images?.[source];
      assert(image);
      expect(image.mimeType).toBe("image/ktx2");
      const view = json.bufferViews?.[image.bufferView ?? -1];
      const resource = image.uri ? resources[image.uri] : resources[GLB_BUFFER];
      assert(resource);
      const bytes = image.uri
        ? resource
        : resource.subarray(
            view?.byteOffset ?? 0,
            (view?.byteOffset ?? 0) + (view?.byteLength ?? 0),
          );
      const container = readKTX2(bytes);
      expect(container.vkFormat).toBe(158);
      expect(container.supercompressionScheme).toBe(0);
      expect(container.levels).toHaveLength(
        Math.floor(Math.log2(Math.max(container.pixelWidth, container.pixelHeight))) + 1,
      );
      const capabilities =
        target === "android" ? androidQuickJs() : resolveRuntimeAssetCapabilities("ios");
      await expect(
        assertNativeAssetsCompatible(project, target, await loadConfig(project), {
          ...capabilities,
          decoders,
        }),
      ).resolves.toBeUndefined();
    },
    60_000,
  );

  it("rejects standalone ASTC symlinks outside the compiled root", async () => {
    const project = await gameProject("threenative-standalone-astc-symlink-");
    await writeManifest(project, { texture: { kind: "texture", output: "escape.ktx2" } });
    await writeFile(path.join(project, "outside.ktx2"), Buffer.from(CAPTURED_ASTC.srgb, "base64"));
    await symlink(path.join(project, "outside.ktx2"), path.join(project, "public/escape.ktx2"));
    await expect(
      assertNativeAssetsCompatible(project, "android", await loadConfig(project), androidQuickJs()),
    ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/u);
  });

  it.each([true, false])(
    "inspects embedded glTF ASTC bytes and primaries (sRGB=%s)",
    async (srgb) => {
      const project = await gameProject("threenative-embedded-astc-");
      const file = await packagedAstcModel(project, srgb);
      const config = await loadConfig(project);
      for (const target of ["android", "ios"] as const) {
        const caps =
          target === "android" ? androidQuickJs() : resolveRuntimeAssetCapabilities("ios");
        await expect(
          assertNativeAssetsCompatible(project, target, config, caps),
        ).resolves.toBeUndefined();
        const original = await readFile(file);
        await writeFile(file, original.subarray(0, original.length - 32));
        await expect(assertNativeAssetsCompatible(project, target, config, caps)).rejects.toThrow(
          /TN_NATIVE_KTX2_UNSUPPORTED/u,
        );
        await writeFile(file, original);
      }
    },
  );

  it("rejects false ASTC ownership, missing payloads, mixed Basis and independent geometry", async () => {
    const project = await gameProject("threenative-astc-ownership-");
    const file = await packagedAstcModel(project);
    const config = await loadConfig(project);
    const original = await new NodeIO().readAsJSON(file);
    const image = original.json.images?.[0];
    assert(image?.bufferView !== undefined);
    const bufferView = original.json.bufferViews?.[image.bufferView];
    const resource = original.resources[GLB_BUFFER];
    assert(bufferView && resource);
    const bytes = resource.subarray(
      bufferView.byteOffset ?? 0,
      (bufferView.byteOffset ?? 0) + bufferView.byteLength,
    );
    const { basis } = await mobileAstcFixture();
    for (const defect of [
      "source",
      "required",
      "ordinary",
      "basis-owner",
      "missing",
      "used",
      "basis",
      "mixed",
      "mime",
      "primaries",
      "alpha",
      "orientation",
      "mip",
      "bounds",
    ]) {
      const json = structuredClone(original.json);
      json.buffers = [];
      json.bufferViews = [];
      const image = {
        mimeType: "image/ktx2",
        uri: `data:image/ktx2;base64,${Buffer.from(bytes).toString("base64")}`,
      };
      json.images = [image];
      const texture = json.textures?.[0];
      assert(texture?.extensions);
      if (defect === "source") texture.extensions.EXT_texture_astc = { source: 20 };
      if (defect === "required") json.extensionsRequired = [];
      if (defect === "ordinary") {
        texture.source = 0;
        texture.extensions.EXT_texture_astc = undefined;
      }
      if (defect === "basis-owner") texture.extensions.KHR_texture_basisu = { source: 0 };
      if (defect === "missing") image.uri = "missing.ktx2";
      if (defect === "used") json.extensionsUsed = [];
      if (defect === "basis")
        image.uri = `data:image/ktx2;base64,${Buffer.from(basis).toString("base64")}`;
      if (defect === "mixed")
        json.images.push({
          mimeType: "image/ktx2",
          uri: `data:image/ktx2;base64,${Buffer.from(basis).toString("base64")}`,
        });
      if (defect === "mime") image.mimeType = "image/png";
      if (defect === "bounds") {
        json.images = [{ mimeType: "image/ktx2", bufferView: 0 }];
        json.buffers = [
          {
            byteLength: resource.byteLength,
            uri: `data:application/octet-stream;base64,${Buffer.from(resource).toString("base64")}`,
          },
        ];
        json.bufferViews = [{ buffer: 0, byteOffset: Number.MAX_SAFE_INTEGER, byteLength: 16 }];
      }
      if (["primaries", "alpha", "orientation", "mip"].includes(defect)) {
        const container = readKTX2(bytes);
        const descriptor = container.dataFormatDescriptor[0];
        const mip = container.levels[1];
        assert(descriptor && mip);
        if (defect === "primaries") descriptor.colorPrimaries = 0;
        if (defect === "alpha") descriptor.flags = 1;
        if (defect === "orientation") container.keyValue.KTXorientation = "ru";
        if (defect === "mip") mip.levelData = new Uint8Array(1);
        image.uri = `data:image/ktx2;base64,${Buffer.from(writeKTX2(container)).toString("base64")}`;
      }
      await writeFile(path.join(project, "public/model.gltf"), JSON.stringify(json));
      await writeManifest(project, {
        model: { kind: "model", output: "model.gltf", extensions: ["EXT_texture_astc"] },
      });
      await expect(
        assertNativeAssetsCompatible(project, "android", config, androidQuickJs()),
      ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/u);
    }
    for (const extension of ["EXT_meshopt_compression", "KHR_draco_mesh_compression"] as const) {
      const json = structuredClone(original.json);
      const buffer = json.buffers?.[0];
      assert(buffer && json.extensionsUsed);
      json.extensionsUsed.push(extension);
      buffer.uri = `data:application/octet-stream;base64,${Buffer.from(resource).toString("base64")}`;
      await writeFile(path.join(project, "public/model.gltf"), JSON.stringify(json));
      await expect(
        assertNativeAssetsCompatible(project, "android", config, androidQuickJs()),
      ).rejects.toThrow(/TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED/u);
      await expect(
        assertNativeAssetsCompatible(project, "android", config, {
          ...androidQuickJs(),
          decoders: { ktx2: false, meshopt: true, draco: true },
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("confines shared glTF resources lexically and through symlinks", async () => {
    const project = await gameProject("threenative-shared-astc-");
    const file = await packagedAstcModel(project);
    const original = await new NodeIO().readAsJSON(file);
    const image = original.json.images?.[0];
    assert(image?.bufferView !== undefined);
    const view = original.json.bufferViews?.[image.bufferView];
    const resource = original.resources[GLB_BUFFER];
    assert(view && resource);
    const bytes = resource.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const json = original.json;
    json.buffers = [];
    json.bufferViews = [];
    await writeFile(path.join(project, "outside.ktx2"), bytes);
    await writeFile(path.join(project, "public/inside.ktx2"), bytes);
    await symlink(path.join(project, "outside.ktx2"), path.join(project, "public/escape.ktx2"));
    await writeManifest(project, { model: { kind: "model", output: "model.gltf" } });
    for (const uri of [
      "inside.ktx2",
      "../outside.ktx2",
      "escape.ktx2",
      "https://example.invalid/a.ktx2",
    ]) {
      json.images = [{ mimeType: "image/ktx2", uri }];
      await writeFile(path.join(project, "public/model.gltf"), JSON.stringify(json));
      const check = assertNativeAssetsCompatible(project, "ios", await loadConfig(project));
      if (uri === "inside.ktx2") await expect(check).resolves.toBeUndefined();
      else await expect(check).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/u);
    }
  });

  it.each([
    ["android", false],
    ["android", true],
    ["ios", false],
    ["ios", true],
  ] as const)("admits actual raw ASTC but refuses Basis on %s (sRGB=%s)", async (target, srgb) => {
    const project = await gameProject("threenative-raw-astc-admission-");
    const config = await loadConfig(project);
    const capabilities =
      target === "android" ? androidQuickJs() : resolveRuntimeAssetCapabilities("ios");
    const { basis, astc } = await mobileAstcFixture(srgb);
    await mkdir(path.join(project, "public/textures"), { recursive: true });
    const output = "textures/colour.ktx2";
    await writeFile(
      path.join(project, "public/model.glb"),
      await buildFixtureGlb({ textured: false }),
    );
    for (const shared of [false, true]) {
      await writeManifest(project, {
        fixture: shared
          ? { kind: "model", output: "model.glb", sharedImages: [{ output }] }
          : { kind: "texture", output },
      });
      await writeFile(path.join(project, "public", output), astc);
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).resolves.toBeUndefined();
      await writeFile(path.join(project, "public", output), basis);
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
    }
  });

  it.each(["android", "ios"] as const)(
    "rejects invalid raw ASTC and mixed shared outputs on %s",
    async (target) => {
      const project = await gameProject("threenative-raw-astc-invalid-");
      const config = await loadConfig(project);
      const capabilities =
        target === "android" ? androidQuickJs() : resolveRuntimeAssetCapabilities("ios");
      const { basis, astc } = await mobileAstcFixture();
      await writeManifest(project, { colour: { kind: "texture", output: "colour.ktx2" } });
      const output = path.join(project, "public/colour.ktx2");
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
      const corruptions = [
        (bytes: Uint8Array) => bytes.subarray(0, 79),
        (bytes: Uint8Array) => bytes.subarray(0, bytes.length - 1),
        ...[
          [12, 145],
          [12, 165],
          [16, 2],
          [20, 0],
          [28, 1],
          [32, 1],
          [36, 6],
          [40, 1],
          [44, 2],
        ].map(([offset, value]) => (bytes: Uint8Array) => {
          new DataView(bytes.buffer).setUint32(offset ?? 0, value ?? 0, true);
          return bytes;
        }),
        ...[80, 88, 96].map((offset) => (bytes: Uint8Array) => {
          new DataView(bytes.buffer).setBigUint64(offset, 1n, true);
          return bytes;
        }),
        (bytes: Uint8Array) => {
          const v = new DataView(bytes.buffer);
          v.setBigUint64(104, v.getBigUint64(80, true), true);
          return bytes;
        },
        (bytes: Uint8Array) => {
          const v = new DataView(bytes.buffer);
          v.setUint8(v.getUint32(48, true) + 14, 1);
          return bytes;
        },
      ];
      for (const corrupt of corruptions) {
        await writeFile(output, corrupt(astc.slice()));
        await expect(
          assertNativeAssetsCompatible(project, target, config, capabilities),
        ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
      }
      await writeFile(output, astc);
      await writeFile(path.join(project, "public/basis.ktx2"), basis);
      await writeManifest(project, {
        colour: {
          kind: "texture",
          output: "colour.ktx2",
          sharedImages: [{ output: "basis.ktx2" }],
        },
      });
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
      await writeManifest(project, {
        colour: {
          kind: "model",
          output: "model.glb",
          extensions: ["KHR_texture_basisu"],
          sharedImages: [{ output: "colour.ktx2" }],
        },
      });
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
      await writeManifest(project, {
        colour: { kind: "model", output: "model.glb", extensions: ["KHR_texture_basisu"] },
      });
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
      await writeManifest(project, {
        colour: { kind: "texture", output: "colour.ktx2", extensions: ["EXT_meshopt_compression"] },
      });
      await expect(
        assertNativeAssetsCompatible(project, target, config, capabilities),
      ).rejects.toThrow(/TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED/);
    },
  );

  it("keeps the mobile raw ASTC exception out of decoder-free desktop", async () => {
    const project = await gameProject("threenative-raw-astc-desktop-");
    const { astc } = await mobileAstcFixture();
    await writeManifest(project, { colour: { kind: "texture", output: "colour.ktx2" } });
    await writeFile(path.join(project, "public/colour.ktx2"), astc);
    const capabilities = resolveRuntimeAssetCapabilities("desktop", undefined, (() => ({
      status: 0,
      stdout: "+ quickjs build",
    })) as never);
    await expect(
      assertNativeAssetsCompatible(project, "desktop", await loadConfig(project), capabilities),
    ).rejects.toThrow(/TN_NATIVE_KTX2_UNSUPPORTED/);
  });

  it("bundles a game that ships no compressed asset for mobile without WASM", async () => {
    const project = await gameProject("threenative-ktx2-mobile-");

    for (const target of ["android", "ios"] as const) {
      const output = await bundle(project, target);
      const source = await readFile(output, "utf8");
      await expect(assertNativeBundleCompatible(output, target)).resolves.toBeUndefined();
      expect(source, `${target} bundle must not carry a WASM decoder`).not.toMatch(
        /\bWebAssembly\b/u,
      );
      expect(source).toContain("TN_NATIVE_KTX2_UNSUPPORTED");
      expect(source).toContain("TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED");
    }
  }, 180_000);

  it("bundles decoder-free desktop QuickJS without WASM decoders", async () => {
    const project = await gameProject("threenative-ktx2-quickjs-");
    const output = await bundle(project, "desktop", true);
    const source = await readFile(output, "utf8");
    expect(source).not.toMatch(/\bWebAssembly\b/u);
    expect(source).toContain("TN_NATIVE_KTX2_UNSUPPORTED");
    expect(source).toContain("TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED");
    await expect(assertNativeBundleCompatible(output, "desktop")).resolves.toBeUndefined();
  }, 180_000);

  it("keeps three's real decoders on desktop, which has a WASM engine", async () => {
    const project = await gameProject("threenative-ktx2-desktop-");

    const output = await bundle(project, "desktop");
    const source = await readFile(output, "utf8");
    await expect(
      assertNativeBundleCompatible(output, "desktop", desktopV8()),
    ).resolves.toBeUndefined();
    expect(source).toMatch(/\bWebAssembly\b/u);
    expect(source).not.toContain("TN_NATIVE_KTX2_UNSUPPORTED");
  }, 180_000);

  it("still fails TN_NATIVE_WASM_ON_MOBILE when the game itself reaches WASM", async () => {
    const project = await gameProject("threenative-wasm-guard-");
    await writeFile(
      path.join(project, "src/wasm.ts"),
      `const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
export const compiled = (): Promise<unknown> => WebAssembly.compile(bytes);
`,
    );
    await writeFile(
      path.join(project, "src/game.ts"),
      `import { defineGame } from "@threenative/core";
import { compiled } from "./wasm.js";
console.info(compiled);
export default defineGame({ scenes: {} });
`,
    );

    const output = await bundle(project, "android");
    expect(await readFile(output, "utf8")).toMatch(/\bWebAssembly\b/u);
    await expect(assertNativeBundleCompatible(output, "android", androidQuickJs())).rejects.toThrow(
      /TN_NATIVE_WASM_ON_MOBILE/u,
    );
    await expect(assertNativeBundleCompatible(output, "ios")).rejects.toThrow(
      /TN_NATIVE_WASM_ON_MOBILE/u,
    );
    // Android V8 runs WebAssembly for its admitted decoders; Rapier and Recast stay refused.
    await expect(
      assertNativeBundleCompatible(output, "android", androidV8()),
    ).resolves.toBeUndefined();
  }, 180_000);

  it("refuses a mobile build whose compiled assets include KTX2, by name", async () => {
    const project = await gameProject("threenative-ktx2-refusal-");
    await mkdir(path.join(project, "assets", "textures"), { recursive: true });
    const ktx2 = await encodeToKTX2(new Uint8Array([0]), {
      generateMipmap: false,
      imageDecoder: async () => ({
        data: new Uint8Array(4 * 4 * 4).fill(255),
        height: 4,
        width: 4,
      }),
      isUASTC: true,
    });
    await writeFile(path.join(project, "assets", "textures", "rock.ktx2"), ktx2);

    let failure: unknown;
    vi.stubEnv("THREENATIVE_GRADLE_ARGS", "-PthreenativeJsEngine=quickjs");
    try {
      await build({ cwd: project, target: "android" });
    } catch (error) {
      failure = error;
    } finally {
      vi.unstubAllEnvs();
    }
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toMatch(
      /TN_NATIVE_KTX2_UNSUPPORTED: android cannot ship compiled KTX2 textures \(textures\/rock\.ktx2\)/u,
    );
    expect(message).toMatch(/replace|transcode/iu);
    expect(message).toMatch(/exclude.*mobile/iu);
    expect(message).not.toMatch(/rebuild.*native/iu);
    // The refusal must land before anything is written, not after an APK exists.
    await expect(readFile(path.join(project, ".threenative/build/game.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("accepts a mobile build after normalizing compressed model sources", async () => {
    const project = await gameProject("threenative-meshopt-normalization-");
    await mkdir(path.join(project, "assets", "models"), { recursive: true });
    const compressed = await modelPass({ textures: "none" }).apply(
      Buffer.from(await buildFixtureGlb()),
      "models/hero.glb",
    );
    if (Buffer.isBuffer(compressed)) throw new Error("model fixture was not compressed");
    await writeFile(path.join(project, "assets", "models", "hero.glb"), compressed.buffer);

    const result = await compileAssets({
      config: { budget: "none" },
      cwd: project,
      platform: "ios",
    });
    expect(result.written).toBe(1);
    const manifest = JSON.parse(
      await readFile(path.join(project, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { extensions?: string[] }> };
    expect(manifest.entries["models/hero.glb"]?.extensions ?? []).not.toContain(
      "EXT_meshopt_compression",
    );
    await expect(
      assertNativeAssetsCompatible(project, "ios", await loadConfig(project)),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("accepts the same compiled assets on desktop and on web", async () => {
    const project = await gameProject("threenative-ktx2-desktop-assets-");
    await writeManifest(project, {
      "models/hero.glb": {
        extensions: ["EXT_meshopt_compression"],
        kind: "model",
        output: "models/hero.a1b2c3d4.glb",
      },
      "textures/rock.png": { kind: "texture", output: "textures/rock.a1b2c3d4.ktx2" },
    });
    const config = await loadConfig(project);

    for (const target of ["desktop", "web"] as const) {
      await expect(
        assertNativeAssetsCompatible(project, target, config, desktopV8()),
      ).resolves.toBeUndefined();
    }
  }, 60_000);

  it("fails closed on a manifest it cannot read", async () => {
    const project = await gameProject("threenative-manifest-closed-");
    await mkdir(path.join(project, "public"), { recursive: true });
    await writeFile(path.join(project, "public/assets.manifest.json"), "{not json");
    const config = await loadConfig(project);

    await expect(assertNativeAssetsCompatible(project, "android", config)).rejects.toThrow(
      /TN_NATIVE_ASSET_MANIFEST_INVALID/u,
    );
  }, 60_000);

  it("leaves the browser KTX2 path on three's real loader", async () => {
    const project = await gameProject("threenative-ktx2-browser-");
    // The project's own Vite, driven exactly as `threenative build` drives it for the web
    // target: no native conditions, no bundler plugins of ours.
    await run(process.execPath, ["--input-type=module", "-e", WEB_BUILD_SCRIPT], { cwd: project });

    const source = await readFile(path.join(project, "dist-web/web.js"), "utf8");
    // three's own KTX2Loader, its zstd decoder and its Basis transcoder wiring, untouched.
    expect(source).toContain("class KTX2Loader");
    expect(source).toContain("basis_transcoder");
    expect(source).toMatch(/\bWebAssembly\b/u);
    expect(source).not.toContain("TN_NATIVE_KTX2_UNSUPPORTED");
    expect(source).not.toContain("TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED");
  }, 180_000);
});
