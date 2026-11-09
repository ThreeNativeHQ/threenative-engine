import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bundleNativeEngine } from "../scripts/bundle-native-engine.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
