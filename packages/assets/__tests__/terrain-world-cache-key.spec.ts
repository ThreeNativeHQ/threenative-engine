import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildFixtureDocument,
  buildFixtureGlb,
} from "../../../test-support/generate-fixture-model.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";

type Entries = Record<string, { output: string }>;

/**
 * Compiles `root` with one `PIPELINE_VERSION`, which is a module constant: the only way to ask
 * what a pipeline fix does to a cache key is to re-import the module graph with another value.
 */
async function compileAt(root: string, pipelineVersion: number): Promise<Entries> {
  vi.resetModules();
  vi.doMock("../src/compile-rows.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/compile-rows.js")>()),
    PIPELINE_VERSION: pipelineVersion,
  }));
  const { compileAssets } = await import("../src/index.js");
  await compileAssets({
    config: { audio: "none", models: "none", textures: "none" },
    cwd: root,
  });
  const manifest = JSON.parse(
    await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
  );
  return manifest.entries as Entries;
}

describe("compileAssets", () => {
  it("renames a cooked terrain world when PIPELINE_VERSION moves, like every other asset", async () => {
    const root = await makeTempDir("threenative-terrain-world-cache-key-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    const doc = buildFixtureDocument();
    doc.getRoot().getAsset().extras = { tnTerrainWorld: 1 };
    await writeFile(
      path.join(root, "assets/world.glb"),
      Buffer.from(await new NodeIO().writeBinary(doc)),
    );
    await writeFile(path.join(root, "assets/prop.glb"), await buildFixtureGlb());

    const before = await compileAt(root, 10);
    const after = await compileAt(root, 11);

    // The control arm: an ordinary asset already hashes the pipeline version, which proves the
    // second compile really ran against the bumped constant.
    expect(after["prop.glb"]?.output).not.toBe(before["prop.glb"]?.output);
    // A cooked world skips the ordinary chain, so a pipeline fix never reached its cache key:
    // the stale GLB stayed on disk under the same name and was reused.
    expect(after["world.glb"]?.output).not.toBe(before["world.glb"]?.output);
  });
});
