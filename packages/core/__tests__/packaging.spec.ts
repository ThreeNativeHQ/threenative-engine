import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { workspacePackages } from "../../../scripts/workspace-packages.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

// Core's base export must stand alone: every module reachable from src/index.ts resolves
// without @threenative/playtest, whose inlined copy tsup used to ship inside dist. The one
// exception is src/playtest.ts itself - the ./playtest subpath is the deliberate bridge to
// the harness, declared as an optional peer dependency rather than bundled.
const PLAYTEST_BRIDGE_ENTRY = "playtest.ts";
const PLAYTEST_PACKAGE = "@threenative/playtest";
/** This package's own name, read rather than written: the entry's JSDoc examples name it. */
const SELF_PACKAGE = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
  }
).name;

/**
 * Build-time machinery a browser-tier or native-bundle module may not import.
 *
 * These are the encoders and compilers the asset cook owns: a page that reaches one of them
 * downloads a transcoder, an image resizer and a glTF rewriter it has no use for, and a native
 * bundle cannot carry them at all. A type-only import is allowed, because it is elided before
 * the graph is built.
 */
const BUILD_TIME_PACKAGES: readonly string[] = [
  "@gltf-transform",
  "pngjs",
  "sharp",
  "wasm-media-encoders",
];
/** The vendored encoders a relative specifier can name without naming a package. */
const BUILD_TIME_PATH_MARKERS: readonly string[] = [
  "basis_encoder",
  "basis_transcoder",
  "ktx2-encoder",
];
/**
 * Sibling workspace packages, derived rather than listed: the runtime reaches none of them, and
 * `packages/assets` is the one that legitimately carries the encoders, so the dependency
 * direction is the rule rather than a case. Two names are exempt: the playtest package, whose
 * subpaths the `./playtest` bridge above imports on purpose, and this package's own name, which
 * appears in the JSDoc examples its entry documents.
 */
const WORKSPACE_PACKAGE_BANNED: ReadonlySet<string> = new Set(
  workspacePackages()
    .map(({ name }) => name)
    .filter((name) => name !== PLAYTEST_PACKAGE && name !== SELF_PACKAGE),
);

/** Every specifier a module imports, in `from "…"` and bare `import "…"` shape alike. */
function importedSpecifiers(text: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function isBuildTime(specifier: string): boolean {
  if (BUILD_TIME_PATH_MARKERS.some((marker) => specifier.includes(marker))) return true;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  const name = specifier.startsWith("@")
    ? (specifier.split("/").slice(0, 2).join("/") ?? specifier)
    : (specifier.split("/")[0] ?? specifier);
  if (WORKSPACE_PACKAGE_BANNED.has(name)) return true;
  // The package name itself, or any of its subpaths (`@gltf-transform/functions`).
  return BUILD_TIME_PACKAGES.some(
    (banned) => name === banned || specifier.startsWith(`${banned}/`),
  );
}

/** The build-time specifiers one module imports, named with the file that reaches them. */
function buildTimeImportOffenders(file: string, text: string): readonly string[] {
  const offenders: string[] = [];
  for (const specifier of importedSpecifiers(text)) {
    if (isBuildTime(specifier)) offenders.push(`${file}: build-time import of ${specifier}`);
  }
  return offenders;
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      files.push(...(await collectSourceFiles(path)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test("should import the protocol from core, not playtest", async () => {
  const sources = await collectSourceFiles(srcRoot);
  // Fail closed: a renamed or emptied tree must fail here, not scan to zero silently.
  expect(sources.length).toBeGreaterThan(5);
  expect(sources).toContain(join(srcRoot, "index.ts"));
  expect(sources).toContain(join(srcRoot, "replay.ts"));
  expect(sources).toContain(join(srcRoot, "replay-protocol.ts"));

  const offenders: string[] = [];
  for (const source of sources) {
    const text = await readFile(source, "utf8");
    if (!text.includes("@threenative/playtest")) continue;
    if (source.endsWith(PLAYTEST_BRIDGE_ENTRY)) continue;
    offenders.push(source);
  }
  expect(offenders).toEqual([]);
});

// The ./playtest bridge subpath loads inside the GAME'S browser page. Its import graph must
// therefore stay free of bare node: builtins - and free of value imports from the harness
// ROOT entry, which transitively drags scenario loading (node:fs/promises) into that graph.
// Regression context: PRD-181 briefly repointed core at the root entry and every example
// using the bridge died at page evaluation with vite's "externalized for browser
// compatibility" error.
test("should keep the playtest bridge tier browser-safe", async () => {
  // Transitive local-import walk from both entries: every reached module must be free of
  // bare node: specifiers AND free of value imports from the harness ROOT entry (whose
  // graph drags scenario loading - node:fs/promises - into the page). Type-only imports of
  // the root are elided at runtime and allowed; multi-line imports must be caught too, so
  // matching happens over whole-file text with import-type statements stripped first.
  const entryFiles = ["index.ts", PLAYTEST_BRIDGE_ENTRY];
  const seen = new Set<string>();
  const offenders: string[] = [];
  async function walk(file: string): Promise<void> {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = await readFile(join(srcRoot, file), "utf8");
    } catch {
      throw new Error(`browser-tier walk could not read ${file}`);
    }
    for (const match of text.matchAll(/(?:from|import) ["'](node:[^"']+)["']/g)) {
      offenders.push(`${file}: bare ${match[1]}`);
    }
    const withoutTypeImports = text.replace(/import type \{[^}]*\} from "[^"]*";/g, "");
    if (/["']@threenative\/playtest["']/.test(withoutTypeImports)) {
      offenders.push(`${file}: value import of @threenative/playtest root`);
    }
    offenders.push(...buildTimeImportOffenders(file, withoutTypeImports));
    for (const match of withoutTypeImports.matchAll(/from ["'](\.[./][^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = join(dirname(file), specifier).replace(/\.js$/, ".ts");
      await walk(resolved);
    }
  }
  for (const entry of entryFiles) await walk(entry);

  expect(seen.size).toBeGreaterThan(3);
  // The asset loader and the playtest bridge both ride on this graph, so the walk has to be
  // reading them: an `assets.ts` that stopped being reachable, or a bridge the entry no longer
  // imports, would leave this test green over a graph it no longer covers.
  expect(seen).toContain("assets.ts");
  expect(seen).toContain(PLAYTEST_BRIDGE_ENTRY);
  expect(offenders).toEqual([]);
});

test("should ship the Three.js batched velocity patch with core", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { files?: string[] };
  expect(manifest.files).toContain("patches");
  const patch = await readFile(new URL("../patches/three@0.185.1.patch", import.meta.url), "utf8");
  expect(patch).toContain("this.object.userData?.useVelocity === true");
  expect(patch).toContain("_previousMatricesTexture ?? matricesTexture");
  expect(patch).toContain("this.gpu = ( typeof navigator !== 'undefined' ) ? navigator.gpu : null");
});

test("should keep the probe-volume import graph on WebGPU render targets", async () => {
  const entry = "render/probe-volume.ts";
  const seen = new Set<string>();
  const offenders: string[] = [];
  async function walk(file: string): Promise<void> {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(join(srcRoot, file), "utf8");
    if (/WebGL\w*RenderTarget|three\/addons\/lighting\/LightProbeGrid\.js/u.test(source)) {
      offenders.push(file);
    }
    for (const match of source.matchAll(/from ["'](\.[./][^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = join(dirname(file), specifier).replace(/\.js$/u, ".ts");
      await walk(resolved);
    }
  }

  await walk(entry);
  expect(seen).toContain(entry);
  expect(offenders).toEqual([]);
});

test("should apply the packed Three.js patch in a clean consumer and remain idempotent", async () => {
  const sandbox = await makeTempDir("threenative-core-package-");
  try {
    const archiveDirectory = join(sandbox, "archive");
    const consumer = join(sandbox, "consumer");
    await run("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: coreRoot });
    const archive = (await readdir(archiveDirectory)).find((file) => file.endsWith(".tgz"));
    if (archive === undefined) throw new Error("core package did not produce a tarball");
    await run("tar", ["-xzf", join(archiveDirectory, archive), "-C", archiveDirectory]);

    const packed = join(archiveDirectory, "package");
    expect(
      await readFile(join(packed, "patches", "three@0.185.1-prd269-upgrade.patch"), "utf8"),
    ).toBe(await readFile(join(coreRoot, "patches", "three@0.185.1-prd269-upgrade.patch"), "utf8"));
    const packageManifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8")) as {
      scripts?: { postinstall?: string };
    };
    expect(packageManifest.scripts?.postinstall).toBe("node ./scripts/postinstall.mjs");

    const installedThree = join(coreRoot, "node_modules", "three");
    const consumerThree = join(consumer, "node_modules", "three");
    await cp(installedThree, consumerThree, { dereference: true, recursive: true });
    await run(
      "patch",
      [
        "--reverse",
        "--batch",
        "--silent",
        "-p1",
        "-i",
        join(packed, "patches", "three@0.185.1.patch"),
      ],
      { cwd: consumerThree },
    );
    const cleanBatchedMesh = await readFile(
      join(consumerThree, "src/objects/BatchedMesh.js"),
      "utf8",
    );
    expect(cleanBatchedMesh).not.toContain("threeNativeBatchedVelocityPatch");

    const environment = {
      ...process.env,
      INIT_CWD: consumer,
      THREENATIVE_SKIP_MCP_SETUP: "1",
    };
    await run(process.execPath, ["./scripts/postinstall.mjs"], {
      cwd: packed,
      env: environment,
    });
    const patchedFiles = [
      "src/objects/BatchedMesh.js",
      "src/nodes/accessors/Instance.js",
      "build/three.webgpu.js",
      "src/renderers/common/RenderContexts.js",
      "src/renderers/common/RenderObject.js",
      "src/renderers/webgpu/utils/WebGPUBindingUtils.js",
      "src/renderers/webgpu/WebGPUBackend.js",
    ];
    const firstRun = await Promise.all(
      patchedFiles.map(
        async (file) => [file, await readFile(join(consumerThree, file), "utf8")] as const,
      ),
    );
    expect(firstRun[0]?.[1]).toContain("threeNativeBatchedVelocityPatch");
    expect(firstRun[1]?.[1]).toContain("threenative.velocity.previousInstanceMatrices");
    expect(firstRun[2]?.[1]).toContain("_previousMatricesTexture ?? matricesTexture");
    const patched = new Map(firstRun);
    expect(patched.get("src/renderers/common/RenderContexts.js")).toContain(
      "this.renderer.currentSamples",
    );
    expect(patched.get("src/renderers/common/RenderObject.js")).toContain(
      "this.context.sampleCount",
    );
    // The dynamic cache key must NOT read `getRenderTarget()`: the engine swaps it for the length
    // of a `compileAsync()` slice, so the key would disagree with a live frame, the render object
    // would be disposed and its pipeline recompiled. On the arm64 CI lane (QuickJS + wgpu +
    // llvmpipe, ~330 ms per frame) those recompiles stalled every window-reaching frame for more
    // than the playtest screenshot budget. `this.context.sampleCount` already keys the samples.
    expect(patched.get("src/renderers/common/RenderObject.js")).not.toContain(
      "this.renderer.getRenderTarget()?.samples",
    );
    expect(patched.get("src/renderers/webgpu/utils/WebGPUBindingUtils.js")).toContain(
      "bindingsData.layoutKey === bindGroupLayoutKey",
    );
    expect(patched.get("build/three.webgpu.js")).toContain("this.context.sampleCount");
    expect(patched.get("build/three.webgpu.js")).not.toContain(
      "this.renderer.getRenderTarget()?.samples",
    );
    expect(patched.get("build/three.webgpu.js")).toContain(
      "bindingsData.layoutKey === bindGroupLayoutKey",
    );
    expect(patched.get("src/renderers/webgpu/WebGPUBackend.js")).toContain(
      "currentBindingGroups[ i ] !== bindingsData.group",
    );
    expect(patched.get("src/renderers/webgpu/WebGPUBackend.js")).toContain(
      "currentBindingGroups[ i ] = bindingsData.group",
    );
    expect(patched.get("build/three.webgpu.js")).toContain(
      "currentBindingGroups[ i ] !== bindingsData.group",
    );
    expect(patched.get("build/three.webgpu.js")).toContain(
      "currentBindingGroups[ i ] = bindingsData.group",
    );
    for (const file of ["src/renderers/webgpu/WebGPUBackend.js", "build/three.webgpu.js"]) {
      const backend = patched.get(file);
      expect(backend).toContain("data.bindGroupLayoutKeys !== bindGroupLayoutKeys");
      expect(backend).toContain("data.bindGroupLayoutKeys = bindGroupLayoutKeys");
      expect(backend).toContain("bindGroupLayoutKeys,");
      expect(backend).toContain("renderObject.getGeometryCacheKey( false )");
    }

    for (const file of ["src/renderers/common/RenderObject.js", "build/three.webgpu.js"]) {
      expect(patched.get(file)).toContain("getGeometryCacheKey( useMorphTargetIds = true )");
      expect(patched.get(file)).toContain("targets.length + ',' + geometry.morphTargetsRelative");
      expect(patched.get(file)).toContain("useMorphTargetIds ? attribute.id");
      expect(patched.get(file)).toContain("attribute.count + ',' + attribute.itemSize");
    }

    await run(process.execPath, ["./scripts/postinstall.mjs"], {
      cwd: packed,
      env: environment,
    });
    const secondRun = await Promise.all(
      patchedFiles.map(
        async (file) => [file, await readFile(join(consumerThree, file), "utf8")] as const,
      ),
    );
    expect(secondRun).toEqual(firstRun);

    const partialFile = join(consumerThree, "src/objects/BatchedMesh.js");
    const firstBatchedMesh = firstRun.find(([file]) => file === "src/objects/BatchedMesh.js");
    if (firstBatchedMesh === undefined) throw new Error("BatchedMesh patch file was not captured");
    const partialText = firstBatchedMesh[1].replace(
      "threeNativeBatchedVelocityPatch",
      "threeNativeBatchedVelocityPatch_removed",
    );
    await writeFile(partialFile, partialText);
    await expect(
      run(process.execPath, ["./scripts/postinstall.mjs"], {
        cwd: packed,
        env: environment,
      }),
    ).rejects.toThrow(/TN_THREE_PATCH_PARTIAL/u);
    const afterRejectedPartial = await Promise.all(
      patchedFiles.map(
        async (file) => [file, await readFile(join(consumerThree, file), "utf8")] as const,
      ),
    );
    expect(afterRejectedPartial[0]?.[1]).toBe(partialText);
    expect(afterRejectedPartial.slice(1)).toEqual(secondRun.slice(1));
    await writeFile(partialFile, firstBatchedMesh[1]);

    const consumerManifestPath = join(consumerThree, "package.json");
    const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8")) as {
      version: string;
    };
    await writeFile(
      consumerManifestPath,
      `${JSON.stringify({ ...consumerManifest, version: "0.185.2" })}\n`,
    );
    await expect(
      run(process.execPath, ["./scripts/postinstall.mjs"], {
        cwd: packed,
        env: environment,
      }),
    ).rejects.toThrow(/TN_THREE_PATCH_VERSION/u);
    const afterRejectedVersion = await Promise.all(
      patchedFiles.map(
        async (file) => [file, await readFile(join(consumerThree, file), "utf8")] as const,
      ),
    );
    expect(afterRejectedVersion).toEqual(secondRun);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("should prefer core's nested Three.js when the consumer has another version", async () => {
  const sandbox = await makeTempDir("threenative-core-nested-three-");
  try {
    const archiveDirectory = join(sandbox, "archive");
    const consumer = join(sandbox, "consumer");
    await run("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: coreRoot });
    const archive = (await readdir(archiveDirectory)).find((file) => file.endsWith(".tgz"));
    if (archive === undefined) throw new Error("core package did not produce a tarball");
    await run("tar", ["-xzf", join(archiveDirectory, archive), "-C", archiveDirectory]);

    const packed = join(archiveDirectory, "package");
    const installedThree = join(coreRoot, "node_modules", "three");
    const coreThree = join(packed, "node_modules", "three");
    const consumerThree = join(consumer, "node_modules", "three");
    for (const threeRoot of [coreThree, consumerThree]) {
      await cp(installedThree, threeRoot, { dereference: true, recursive: true });
      await run(
        "patch",
        [
          "--reverse",
          "--batch",
          "--silent",
          "-p1",
          "-i",
          join(packed, "patches", "three@0.185.1.patch"),
        ],
        { cwd: threeRoot },
      );
    }
    const consumerManifestPath = join(consumerThree, "package.json");
    const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8")) as {
      version: string;
    };
    await writeFile(
      consumerManifestPath,
      `${JSON.stringify({ ...consumerManifest, version: "0.185.2" })}\n`,
    );

    await run(process.execPath, ["./scripts/postinstall.mjs"], {
      cwd: packed,
      env: { ...process.env, INIT_CWD: consumer, THREENATIVE_SKIP_MCP_SETUP: "1" },
    });

    await expect(
      readFile(join(coreThree, "src/objects/BatchedMesh.js"), "utf8"),
    ).resolves.toContain("threeNativeBatchedVelocityPatch");
    await expect(
      readFile(join(consumerThree, "src/objects/BatchedMesh.js"), "utf8"),
    ).resolves.not.toContain("threeNativeBatchedVelocityPatch");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("should apply the patch to a valid workspace-hoisted Three.js", async () => {
  const sandbox = await makeTempDir("threenative-core-hoisted-three-");
  try {
    const archiveDirectory = join(sandbox, "archive");
    const consumer = join(sandbox, "apps", "game");
    await run("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: coreRoot });
    const archive = (await readdir(archiveDirectory)).find((file) => file.endsWith(".tgz"));
    if (archive === undefined) throw new Error("core package did not produce a tarball");
    await run("tar", ["-xzf", join(archiveDirectory, archive), "-C", archiveDirectory]);

    const packed = join(archiveDirectory, "package");
    const installedThree = join(coreRoot, "node_modules", "three");
    const hoistedThree = join(sandbox, "node_modules", "three");
    await cp(installedThree, hoistedThree, { dereference: true, recursive: true });
    await run(
      "patch",
      [
        "--reverse",
        "--batch",
        "--silent",
        "-p1",
        "-i",
        join(packed, "patches", "three@0.185.1.patch"),
      ],
      { cwd: hoistedThree },
    );

    await run(process.execPath, ["./scripts/postinstall.mjs"], {
      cwd: packed,
      env: { ...process.env, INIT_CWD: consumer, THREENATIVE_SKIP_MCP_SETUP: "1" },
    });

    await expect(
      readFile(join(hoistedThree, "src/objects/BatchedMesh.js"), "utf8"),
    ).resolves.toContain("threeNativeBatchedVelocityPatch");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("should reject Three.js resolved only through a NODE_PATH fallback", async () => {
  const sandbox = await makeTempDir("threenative-core-global-three-");
  try {
    const archiveDirectory = join(sandbox, "archive");
    const consumer = join(sandbox, "apps", "game");
    const fallbackNodeModules = join(sandbox, "fallback", "node_modules");
    await run("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: coreRoot });
    const archive = (await readdir(archiveDirectory)).find((file) => file.endsWith(".tgz"));
    if (archive === undefined) throw new Error("core package did not produce a tarball");
    await run("tar", ["-xzf", join(archiveDirectory, archive), "-C", archiveDirectory]);

    const packed = join(archiveDirectory, "package");
    const installedThree = join(coreRoot, "node_modules", "three");
    const fallbackThree = join(fallbackNodeModules, "three");
    await cp(installedThree, fallbackThree, { dereference: true, recursive: true });
    await run(
      "patch",
      [
        "--reverse",
        "--batch",
        "--silent",
        "-p1",
        "-i",
        join(packed, "patches", "three@0.185.1.patch"),
      ],
      { cwd: fallbackThree },
    );

    await expect(
      run(process.execPath, ["./scripts/postinstall.mjs"], {
        cwd: packed,
        env: {
          ...process.env,
          INIT_CWD: consumer,
          NODE_PATH: fallbackNodeModules,
          THREENATIVE_SKIP_MCP_SETUP: "1",
        },
      }),
    ).rejects.toThrow(/TN_THREE_PATCH_MISSING/u);
    await expect(
      readFile(join(fallbackThree, "src/objects/BatchedMesh.js"), "utf8"),
    ).resolves.not.toContain("threeNativeBatchedVelocityPatch");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
