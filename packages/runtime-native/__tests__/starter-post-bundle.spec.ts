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
