import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bundleNativeEngine, insideDirectory } from "../scripts/bundle-native-engine.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native bundle importer checks", () => {
  // PRD-783 AC-7: a `/` suffix never matched a Windows importer, so the Windows desktop build
  // bundled core's browser compressed-texture module and refused 36 `three` names.
  it("matches a Windows importer under core/src", () => {
    expect(insideDirectory("D:\\a\\core\\src\\look\\x.ts", "D:\\a\\core\\src", path.win32)).toBe(
      true,
    );
    expect(insideDirectory("D:\\a\\core\\src-other\\x.ts", "D:\\a\\core\\src", path.win32)).toBe(
      false,
    );
    expect(insideDirectory("/a/core/src/look/x.ts", "/a/core/src", path.posix)).toBe(true);
  });
});

describe("starter post import bindings", () => {
  it("bundles the current WorldEnvironment import surface", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(
      entry,
      `import { WorldEnvironment } from ${JSON.stringify(path.resolve("packages/core/src/look/world-environment.ts"))}; globalThis.bound = WorldEnvironment;`,
    );
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });

  it("bundles every added import without upstream Three.js or an unbound diagnostic", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(
      entry,
      `
      import { film } from "three/addons/tsl/display/FilmNode.js";
      import { lut3D } from "three/addons/tsl/display/Lut3DNode.js";
      import { traa } from "three/addons/tsl/display/TRAANode.js";
      import { LUTCubeLoader } from "three/addons/loaders/LUTCubeLoader.js";
      import { luminance, logarithmicDepthToViewZ, viewZToOrthographicDepth, viewZToPerspectiveDepth, vertexIndex, struct, renderOutput, reference } from "three/tsl";
      globalThis.bound = { film, lut3D, traa, LUTCubeLoader, luminance, logarithmicDepthToViewZ, viewZToOrthographicDepth, viewZToPerspectiveDepth, vertexIndex, struct, renderOutput, reference };
    `,
    );
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });

  // PRD-784 P5-9: FluidField2D (prd249) imports three/tsl's compute(), which the facade did not export.
  it("bundles three/tsl compute as node.compute", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(entry, `import { compute } from "three/tsl"; globalThis.bound = compute;`);
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });

  // PRD-784 P5-9: the names prd476, animation-composition, prd493 and prd268 import, which the facade
  // did not export: JS ports over bound classes, engine globals and three's constants.
  it("bundles the P5-9 three, three/tsl and CCDIKSolver names", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(
      entry,
      `
      import { AdditiveAnimationBlendMode, AnimationUtils, Box2, DataArrayTexture, EdgesGeometry, InterpolateDiscrete, InterpolateLinear, InterpolateSmooth, NormalAnimationBlendMode, Uint8BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from "three";
      import { viewportCoordinate } from "three/tsl";
      import { CCDIKSolver } from "three/addons/animation/CCDIKSolver.js";
      globalThis.bound = { AdditiveAnimationBlendMode, AnimationUtils, Box2, DataArrayTexture, EdgesGeometry, InterpolateDiscrete, InterpolateLinear, InterpolateSmooth, NormalAnimationBlendMode, Uint8BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute, viewportCoordinate, CCDIKSolver };
    `,
    );
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });

  it("lays the game name and engine ahead of the game, as index.html does on web (PRD-905)", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    const gameName = 'Midway — Pilot\'s "Open" Pacific';
    await writeFile(entry, "export default { start: async () => {} };");
    await bundleNativeEngine({ entry, engine: "threenative", gameName, host: false, outfile });
    const bundle = await readFile(outfile, "utf8");
    // Both are the bundle's first statements, and a quoted name cannot break the script.
    expect(bundle.startsWith(`globalThis.__TN_GAME__ = ${JSON.stringify(gameName)};\n`)).toBe(true);
    expect(bundle).toContain('globalThis.__TN_ENGINE__ = "threenative";');
  });

  it("bundles defineGame without a web-only renderer import", async () => {
    // Every game reaches game.ts and renderer.ts; neither may drag an unbound import onto native.
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(
      entry,
      `import { defineGame } from "@threenative/core"; globalThis.bound = defineGame;`,
    );
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });

  it("bundles textureSize as a refusal for an unexecuted upstream-only branch", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(
      entry,
      `import { textureSize } from "three/tsl"; globalThis.bound = { textureSize };`,
    );
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });

  // `version` is the one value core declares in the barrel itself rather than re-exporting, so a
  // binding list that only read `export { … } from` refused it: every game that stamps the engine
  // version into its HUD could not be packaged for the native engine (TN_NATIVE_ENGINE_UNBOUND).
  // The literal lives in `version.ts` (generated from `package.json`); the barrel re-names it with a
  // local `const`, and `export { CORE_VERSION as version } from` is what broke the native bundler
  // for a second time — it reads a name from the module that the module does not export.
  it("binds a value core declares in its own barrel", async () => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    await writeFile(
      entry,
      `import { version } from "@threenative/core"; globalThis.bound = version;`,
    );
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    const bundle = await readFile(outfile, "utf8");
    expect(bundle).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
    const barrel = await readFile("packages/core/src/index.ts", "utf8");
    expect(barrel).toMatch(/^export const version = CORE_VERSION;$/mu);
    const declared = /^export const CORE_VERSION = "([^"]+)";$/mu.exec(
      await readFile("packages/core/src/version.ts", "utf8"),
    );
    expect(declared?.[1]).toBeDefined();
    expect(bundle).toContain(declared?.[1]);
  });

  it.each([
    "atomicAdd",
    "atomicStore",
    "lightShadowMatrix",
    "rtt",
    "wgslFn",
    "DepthTexture",
    "PassNode",
  ])("bundles %s through its native implementation", async (name) => {
    const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
    directories.push(directory);
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "game.js");
    const source = name === "DepthTexture" || name === "PassNode" ? "three/webgpu" : "three/tsl";
    await writeFile(entry, `import { ${name} } from "${source}"; globalThis.bound = ${name};`);
    await bundleNativeEngine({ entry, outfile, boot: false, host: false });
    expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
  });
});
