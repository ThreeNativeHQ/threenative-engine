import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The production bundler is JavaScript and has no declaration file.
// @ts-expect-error -- native engine bundler is an executable module.
import { bundleNativeEngine } from "../scripts/bundle-native-engine.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("starter post import bindings", () => {
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

  it.each(["atomicAdd", "atomicStore", "lightShadowMatrix", "rtt", "wgslFn", "DepthTexture"])(
    "bundles %s through its native implementation",
    async (name) => {
      const directory = await mkdtemp(path.resolve("packages/runtime-native/.starter-post-"));
      directories.push(directory);
      const entry = path.join(directory, "entry.ts");
      const outfile = path.join(directory, "game.js");
      const source = name === "DepthTexture" ? "three/webgpu" : "three/tsl";
      await writeFile(entry, `import { ${name} } from "${source}"; globalThis.bound = ${name};`);
      await bundleNativeEngine({ entry, outfile, boot: false, host: false });
      expect(await readFile(outfile, "utf8")).not.toContain("TN_NATIVE_ENGINE_UNBOUND:");
    },
  );
});
