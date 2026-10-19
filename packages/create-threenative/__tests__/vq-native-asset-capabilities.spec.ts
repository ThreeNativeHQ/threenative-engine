import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAssets } from "@threenative/assets";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  assertNativeAssetsCompatible,
  resolveRuntimeAssetCapabilities,
  runtimeHasWebAssembly,
} from "../src/build.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const runtime = path.resolve("packages/create-threenative/src/build.ts");

describe("VQ-01 native asset capability contract", () => {
  it.each([
    { target: "web", engine: "v8", expected: "browser", wasm: true, decoder: true },
    { target: "desktop", engine: "v8", expected: "v8", wasm: true, decoder: true },
    { target: "desktop", engine: "quickjs", expected: "quickjs", wasm: false, decoder: false },
    { target: "desktop", engine: "unknown", expected: "unknown", wasm: false, decoder: false },
    { target: "ios", engine: "v8", expected: "unknown", wasm: false, decoder: false },
  ] as const)(
    "keeps $target separate from the build-host $engine engine",
    ({ target, engine, expected, wasm, decoder }) => {
      let probes = 0;
      const capabilities = resolveRuntimeAssetCapabilities(
        target,
        runtime,
        (() => {
          probes++;
          return { status: 0, stdout: `Native WebGPU JS runtime - wgpu-native + ${engine} build` };
        }) as never,
        {},
      );
      expect(capabilities.engine).toBe(expected);
      expect(capabilities.webAssembly).toBe(wasm);
      expect(capabilities.decoders).toEqual({ ktx2: decoder, meshopt: decoder, draco: decoder });
      expect(probes).toBe(target === "desktop" ? 1 : 0);
    },
  );

  it.each([
    { gradle: undefined, engine: "v8", wasm: true, codecs: true },
    {
      gradle: "-PthreenativeJsEngine=v8 -PthreenativeAbis=x86_64",
      engine: "v8",
      wasm: true,
      codecs: true,
    },
    { gradle: "-PthreenativeJsEngine=QuickJS", engine: "quickjs", wasm: false, codecs: false },
    {
      gradle: "-PthreenativeJsEngine=v8 -PthreenativeJsEngine=quickjs",
      engine: "quickjs",
      wasm: false,
      codecs: false,
    },
    { gradle: "-PthreenativeJsEngine=hermes", engine: "unknown", wasm: false, codecs: false },
  ])(
    "takes Android's engine from the Gradle selection ($gradle), never the build host",
    ({ gradle, engine, wasm, codecs }) => {
      const capabilities = resolveRuntimeAssetCapabilities(
        "android",
        runtime,
        (() => {
          throw new Error("an Android build must not probe a host executable");
        }) as never,
        gradle === undefined ? {} : { THREENATIVE_GRADLE_ARGS: gradle },
      );
      expect(capabilities.engine).toBe(engine);
      expect(capabilities.artifact).toBe(`android:${engine}`);
      expect(capabilities.webAssembly).toBe(wasm);
      // Draco has no Android device proof, so it stays refused even on V8.
      expect(capabilities.decoders).toEqual({ ktx2: codecs, meshopt: codecs, draco: false });
    },
  );

  it("changes the runtime identity when the selected bytes change at the same path", async () => {
    const root = await makeTempDir("vq-runtime-identity-");
    roots.push(root);
    const binary = path.join(root, "runtime");
    const probe = (() => ({ status: 0, stdout: "+ v8 build" })) as never;
    await writeFile(binary, "cohort one");
    const before = resolveRuntimeAssetCapabilities("desktop", binary, probe);
    await writeFile(binary, "cohort two");
    const after = resolveRuntimeAssetCapabilities("desktop", binary, probe);
    expect(before.identity).not.toBe(after.identity);
    expect(before.artifact).toBe(after.artifact);
  });

  it.each(["runtimeIdentity", "runtimeDecoders"] as const)(
    "invalidates cooked output when %s changes even with identical passes",
    async (field) => {
      const root = await makeTempDir("vq-runtime-cache-");
      roots.push(root);
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets/unchanged.txt"), "same source bytes");
      const options = {
        cwd: root,
        config: { audio: "none", models: "none", textures: "none" } as const,
        runtimeDecoders: { ktx2: false, meshopt: false },
        runtimeIdentity: "desktop:cohort-one:quickjs",
      };
      await compileAssets(options);
      const before = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      const changed =
        field === "runtimeIdentity"
          ? { ...options, runtimeIdentity: "desktop:cohort-two:quickjs" }
          : { ...options, runtimeDecoders: { ktx2: true, meshopt: false } };
      await compileAssets(changed);
      const after = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      expect(after.entries["unchanged.txt"].output).not.toBe(
        before.entries["unchanged.txt"].output,
      );
      await expect(
        readFile(path.join(root, "public", after.entries["unchanged.txt"].output), "utf8"),
      ).resolves.toBe("same source bytes");
    },
  );

  it.each([
    { name: "missing artifact", binary: "/no/such/runtime", result: { status: 0, stdout: "" } },
    { name: "failed probe", binary: runtime, result: { status: 1, stdout: "" } },
    {
      name: "unrecognized engine",
      binary: runtime,
      result: { status: 0, stdout: "+ future-engine build" },
    },
    {
      name: "no engine declaration",
      binary: runtime,
      result: { status: 0, stdout: "v8 is installed on the host" },
    },
  ])("does not infer WASM from $name", ({ binary, result }) => {
    expect(runtimeHasWebAssembly(binary, (() => result) as never)).toBe(false);
  });

  it.each([
    { codec: "KTX2", entry: { output: "rock.ktx2" }, code: "TN_NATIVE_KTX2_UNSUPPORTED" },
    {
      codec: "Meshopt",
      entry: { output: "rock.glb", extensions: ["EXT_meshopt_compression"] },
      code: "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED",
    },
    {
      codec: "Draco",
      entry: { output: "rock.glb", extensions: ["KHR_draco_mesh_compression"] },
      code: "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED",
    },
    {
      codec: "embedded KTX2",
      entry: { output: "rock.glb", extensions: ["KHR_texture_basisu"] },
      code: "TN_NATIVE_KTX2_UNSUPPORTED",
    },
    {
      codec: "shared KTX2",
      entry: { output: "rock.glb", sharedImages: [{ output: "rock.ktx2", codec: "ktx2" }] },
      code: "TN_NATIVE_KTX2_UNSUPPORTED",
    },
  ])(
    "refuses $codec on an unknown desktop artifact, preserving the previous package",
    async ({ entry, code }) => {
      const root = await makeTempDir("vq-native-assets-");
      roots.push(root);
      await mkdir(path.join(root, "public"));
      await mkdir(path.join(root, "dist-native"));
      await writeFile(path.join(root, "dist-native/game"), "previous working artifact");
      await writeFile(
        path.join(root, "public/assets.manifest.json"),
        JSON.stringify({ entries: { "rocks/rock": entry }, version: 1 }),
      );
      const config = { assets: { output: "public" } } as Parameters<
        typeof assertNativeAssetsCompatible
      >[2];
      await expect(assertNativeAssetsCompatible(root, "desktop", config)).rejects.toThrow(code);
      await expect(readFile(path.join(root, "dist-native/game"), "utf8")).resolves.toBe(
        "previous working artifact",
      );
      await expect(assertNativeAssetsCompatible(root, "web", config)).resolves.toBeUndefined();
    },
  );
});
