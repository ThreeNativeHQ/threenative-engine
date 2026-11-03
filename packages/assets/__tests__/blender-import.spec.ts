import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { resolveBlender } from "@threenative/blender-bridge/bridge";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { classify, compileAssets } from "../src/compile.js";
import { createGltfReader, readGltfDocument } from "../src/gltf-io.js";
import { blenderImportPass, needsBlenderImport } from "../src/passes/blender-import.js";

/**
 * The proof that a downloaded `.fbx` becomes a GLB a game loads.
 *
 * Every count is re-read through `gltf-io` — the reader the runtime uses — never through the JSON
 * summary `gpl/convert.py` printed. A summary asserting about itself would pass while the exporter
 * wrote nothing.
 */

const fixtures = path.resolve("packages/assets/__tests__/fixtures/blender");

// A conversion gate needs a real Blender. Where there is none — CI, by design, since this
// framework never installs a 350 MB dependency for a user — the gate says so on stderr and skips.
// A skipped gate reported as a pass is the failure PRD-346's verification section exists to
// prevent, so the name is printed and the assertions that do NOT need Blender still run.
const blender = resolveBlender();
if (!blender.available) {
  process.stderr.write(
    `TN_BLENDER_TESTS_SKIPPED: ${blender.detail} Install Blender to run the conversion gates in packages/assets/__tests__/blender-import.spec.ts.\n`,
  );
}
const withBlender = blender.available ? describe : describe.skip;
const itWithBlender = blender.available ? it : it.skip;
const CHARACTER = "character.fbx";
const PROP = "flag_A_blue.fbx";

interface IGlbFacts {
  readonly animations: readonly string[];
  readonly images: number;
  readonly joints: number;
  readonly materials: readonly string[];
  readonly meshes: number;
  readonly triangles: number;
}

async function readGlbFacts(buffer: Buffer, file?: string): Promise<IGlbFacts> {
  const io = await createGltfReader(buffer);
  const document = file === undefined ? await readGltfDocument(io, buffer) : await io.read(file);
  const root = document.getRoot();
  const triangles = root
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, primitive) => total + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
  return {
    animations: root.listAnimations().map((animation) => animation.getName()),
    images: root.listTextures().length,
    joints: root.listSkins().reduce((total, skin) => total + skin.listJoints().length, 0),
    materials: root.listMaterials().map((material) => material.getName()),
    meshes: root.listMeshes().length,
    triangles,
  };
}

/** A compile over one fixture, with the source staged into a directory of its own. It uses the real
 * environment: the missing-Blender paths are covered by the pass tests above, which take an
 * environment directly rather than mutating this process's. */
async function compileFixture(
  fixture: string,
): Promise<{ manifest: Record<string, unknown>; outputRoot: string; root: string }> {
  const root = await makeTempDir("tn-blender-compile-");
  const source = path.join(root, "assets");
  await mkdir(source, { recursive: true });
  await copyFile(path.join(fixtures, fixture), path.join(source, fixture));
  const outputRoot = path.join(root, "public");
  await compileAssets({ output: outputRoot, source });
  const manifest = JSON.parse(
    await readFile(path.join(outputRoot, "assets.manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  return { manifest, outputRoot, root };
}

describe("blender source classification", () => {
  it("should classify every importable source as a model, not as other", () => {
    for (const extension of ["fbx", "blend", "obj", "dae"]) {
      expect(classify(`hero.${extension}`), extension).toBe("model");
      expect(needsBlenderImport(`hero.${extension}`), extension).toBe(true);
    }
    // A GLB is a model the runtime already loads; the importer must not touch it.
    expect(classify("hero.glb")).toBe("model");
    expect(needsBlenderImport("hero.glb")).toBe(false);
  });
});

describe("blenderImportPass", () => {
  itWithBlender(
    "should convert a rigged fbx to a loadable glb",
    async () => {
      const input = await readFile(path.join(fixtures, CHARACTER));
      const result = await blenderImportPass().apply(input, CHARACTER);
      expect(Buffer.isBuffer(result)).toBe(false);
      if (Buffer.isBuffer(result)) return;
      expect(result.outputExtension).toBe(".glb");
      expect(result.entry).toMatchObject({ importedFrom: "fbx" });

      const facts = await readGlbFacts(result.buffer);
      expect(facts.meshes).toBe(2);
      expect(facts.materials.length).toBeGreaterThanOrEqual(2);
      expect(facts.materials).toEqual(expect.arrayContaining(["Cloth", "Skin"]));
      expect(facts.animations.length).toBeGreaterThanOrEqual(2);
      expect(facts.joints).toBeGreaterThan(0);
      expect(facts.images).toBeGreaterThan(0);
      // The fixture's own triangle count, measured by Blender at authoring time. Within 1%: the
      // exporter may retriangulate, and a count that drifted further is geometry loss.
      expect(facts.triangles).toBeGreaterThan(620 * 0.99);
      expect(facts.triangles).toBeLessThan(620 * 1.01);
    },
    180_000,
  );

  itWithBlender(
    "should convert an untouched third-party fbx",
    async () => {
      const input = await readFile(path.join(fixtures, PROP));
      const result = await blenderImportPass().apply(input, PROP);
      if (Buffer.isBuffer(result))
        throw new Error("the prop fixture was passed through unconverted");
      const facts = await readGlbFacts(result.buffer);
      expect(facts.meshes).toBe(1);
      expect(facts.materials).toEqual(["platformer"]);
      expect(facts.triangles).toBeGreaterThan(502 * 0.99);
      expect(facts.triangles).toBeLessThan(502 * 1.01);
    },
    180_000,
  );

  it("should leave a glb alone", async () => {
    const input = Buffer.from("not really a glb");
    await expect(blenderImportPass().apply(input, "already.glb")).resolves.toBe(input);
  });

  it("should fail the compile when Blender is absent", async () => {
    const input = await readFile(path.join(fixtures, CHARACTER));
    const pass = blenderImportPass({
      environment: { PATH: "", THREENATIVE_BLENDER_PATH: "/nonexistent/blender" },
    });
    await expect(pass.apply(input, CHARACTER)).rejects.toThrow(
      /TN_ASSETS_BLENDER_IMPORT_FAILED.*blender-unreadable/su,
    );
  }, 60_000);

  it("should name the install command when no Blender exists at all", async () => {
    const input = await readFile(path.join(fixtures, CHARACTER));
    const pass = blenderImportPass({ environment: { HOME: "/nonexistent-home", PATH: "" } });
    await expect(pass.apply(input, CHARACTER)).rejects.toThrow(/Install Blender and rebuild/u);
  }, 60_000);

  itWithBlender(
    "should fail when conversion produces no meshes",
    async () => {
      const root = await makeTempDir("tn-blender-empty-");
      try {
        // A syntactically valid but empty OBJ: Blender imports it happily and produces no mesh.
        const empty = path.join(root, "empty.obj");
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile(empty, "# nothing in here\n"),
        );
        const input = await readFile(empty);
        await expect(blenderImportPass().apply(input, "empty.obj")).rejects.toThrow(
          /TN_ASSETS_BLENDER_IMPORT_FAILED.*no-meshes/su,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    120_000,
  );
});

withBlender("compileAssets with a blender source", () => {
  it("should compile a downloaded fbx into a hashed glb the manifest names", async () => {
    const { manifest, outputRoot, root } = await compileFixture(CHARACTER);
    try {
      const entries = manifest.entries as Record<string, Record<string, unknown>>;
      const entry = entries[CHARACTER];
      expect(entry, `manifest has no entry for ${CHARACTER}`).toBeDefined();
      expect(entry?.kind).toBe("model");
      expect(entry?.importedFrom).toBe("fbx");
      // The chain lists the importer only because this tree holds something it owns. A project
      // with no importable source must not even construct it: an unconditional no-op pass made
      // `passSpecs` non-empty for an `assets: "none"` project, which spun up a worker pool for a
      // chain that can do nothing and left `threenative build` hanging after its work was done.
      expect(entry?.passes).toContain("blender-import");
      const output = entry?.output as string;
      expect(output.endsWith(".glb"), output).toBe(true);

      const produced = await readFile(path.join(outputRoot, output));
      const facts = await readGlbFacts(produced, path.join(outputRoot, output));
      expect(facts.animations.length).toBeGreaterThanOrEqual(2);
      expect(facts.joints).toBeGreaterThan(0);
      expect(facts.materials.length).toBeGreaterThanOrEqual(2);
      const cached = await compileAssets({ cwd: root, health: true });
      expect(cached.skipped).toBe(1);
      expect(cached.report?.entries[0]?.model?.materials).toBeGreaterThanOrEqual(2);
      await expect(
        compileAssets({ cwd: root, config: { targets: { maxTriangles: 1 } } }),
      ).rejects.toThrow("TN_ASSETS_HEALTH_FAILED");

      // The incumbent is gone: no `.fbx` survives into the output tree.
      const copied = await readdir(outputRoot, { recursive: true });
      expect(copied.filter((file) => String(file).endsWith(".fbx"))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 240_000);
});
