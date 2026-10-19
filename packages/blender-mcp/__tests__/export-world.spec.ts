import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { type IWorldPackage, validateWorldPackage } from "../../core/src/world-package.js";
import { resolveBlender } from "../src/detect.js";
import { handleToolCall } from "../src/index.js";

/**
 * The recipe that turns a Blender world into a world package, driven the way an agent drives it:
 * through the `blender_export_world` MCP tool, then validated with the runtime's own contract.
 *
 * It proves the two things a green summary cannot: the instance count is the render-density count
 * (not the viewport one), and the package on disk validates. The fixture is generated procedurally
 * from CC0 primitives, so the proof needs nothing but a Blender.
 */

const execFileAsync = promisify(execFile);
const blender = resolveBlender();
if (!blender.available) {
  process.stderr.write(
    `TN_BLENDER_TESTS_SKIPPED: ${blender.detail} Install Blender to run packages/blender-mcp/__tests__/export-world.spec.ts.\n`,
  );
}
const withBlender = blender.available ? describe : describe.skip;

const fixtureScript = path.resolve("packages/blender-mcp/gpl/fixtures/make_world_fixture.py");
const recipeScript = path.resolve("packages/blender-mcp/gpl/recipes/export_world.py");

const COUNT_SNIPPET = `import bpy, json
bpy.ops.wm.open_mainfile(filepath=__BLEND__)
captured = {}
def count(depsgraph):
    total = 0
    for instance in depsgraph.object_instances:
        if instance.is_instance and instance.instance_object is not None:
            total += 1
    return total
class Grab(bpy.types.RenderEngine):
    bl_idname = "TN_COUNT_CAPTURE"
    bl_label = "TN Count Capture"
    def render(self, depsgraph):
        captured["render"] = count(depsgraph)
bpy.utils.register_class(Grab)
scene = bpy.context.scene
camera_data = bpy.data.cameras.new("count-camera")
camera = bpy.data.objects.new("count-camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
previous = scene.render.engine
scene.render.engine = "TN_COUNT_CAPTURE"
bpy.ops.render.render(write_still=False)
scene.render.engine = previous
print("TN_COUNT " + json.dumps({"render": captured["render"], "viewport": count(bpy.context.evaluated_depsgraph_get())}))
`;

async function blenderRun(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(blender.path as string, args, {
    encoding: "utf8",
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  return stdout;
}

function parseCount(stdout: string): { render: number; viewport: number } {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("TN_COUNT "));
  if (line === undefined) throw new Error(`No TN_COUNT line in:\n${stdout}`);
  return JSON.parse(line.slice("TN_COUNT ".length)) as { render: number; viewport: number };
}

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every asset a run references must carry geometry. A scatter source kept in a hidden collection
 * would otherwise export as an empty GLB and load as a runtime failure.
 */
function expectRunGeometry(out: string, manifest: IWorldPackage): void {
  for (const cell of manifest.cells) {
    for (const run of cell.runs) {
      const asset = manifest.assets[run.asset];
      expect(asset, `run references asset '${run.asset}'`).toBeDefined();
      if (asset === undefined) continue;
      const glbs = [asset.glb, ...(asset.lods ?? []).map((lod) => lod.glb)];
      for (const glb of glbs) {
        expect(
          glbMeshCount(path.join(out, glb)),
          `${glb} exports at least one mesh`,
        ).toBeGreaterThan(0);
      }
    }
  }
}

/** Count the meshes in a GLB by reading its JSON chunk; 0 means the export wrote no geometry. */
function glbMeshCount(file: string): number {
  const buffer = readFileSync(file);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (type === 0x4e4f534a) {
      const chunk = buffer
        .subarray(offset, offset + length)
        .toString("utf8")
        .replace(/\0+$/u, "");
      const json = JSON.parse(chunk) as { meshes?: unknown[] };
      return json.meshes?.length ?? 0;
    }
    offset += length;
  }
  return 0;
}

/** The fixture is deterministic, so a failure here is the fixture, not a flaky scatter. */
async function makeFixtureBlend(root: string): Promise<string> {
  const blend = path.join(root, "world.blend");
  await blenderRun(root, [
    "--background",
    "--factory-startup",
    "--python",
    fixtureScript,
    "--",
    "--out",
    blend,
  ]);
  expect(existsSync(blend)).toBe(true);
  return blend;
}

/**
 * Reopen the fixture, change one convention and save a second .blend. The recipe's conventions are
 * the things under test, so the fixture stays the one the package spec proves; this edits a copy.
 */
async function mutatedBlend(root: string, blend: string, snippet: string): Promise<string> {
  const script = path.join(root, "mutate.py");
  const mutated = path.join(root, "mutated.blend");
  await writeFile(
    script,
    snippet.replace("__BLEND__", JSON.stringify(blend)).replace("__OUT__", JSON.stringify(mutated)),
  );
  await blenderRun(root, ["--background", "--factory-startup", "--python", script]);
  expect(existsSync(mutated)).toBe(true);
  return mutated;
}

interface IExportResult {
  readonly ok: boolean;
  readonly detail?: string;
  readonly summary?: {
    readonly assetsWritten: number;
    readonly instancesByAsset: Record<string, number>;
  };
}

/** The tool handler, not the raw script: this is the surface an agent calls. */
async function exportWorld(out: string, source: string): Promise<IExportResult> {
  const response = await handleToolCall({
    arguments: { cell: 64, out, source },
    name: "blender_export_world",
  });
  return JSON.parse(response.content[0].text) as IExportResult;
}

withBlender("blender_export_world against a real Blender", () => {
  it("writes a validating package whose count is the render-density count", async () => {
    const root = await makeTempDir("tn-export-world-");
    const blend = path.join(root, "world.blend");
    const out = path.join(root, "package");

    // The fixture is deterministic, so a failure here is the fixture, not a flaky scatter.
    await blenderRun(root, [
      "--background",
      "--factory-startup",
      "--python",
      fixtureScript,
      "--",
      "--out",
      blend,
    ]);
    expect(existsSync(blend)).toBe(true);

    const countScript = path.join(root, "count.py");
    await writeFile(countScript, COUNT_SNIPPET.replace("__BLEND__", JSON.stringify(blend)));
    const counts = parseCount(
      await blenderRun(root, ["--background", "--factory-startup", "--python", countScript]),
    );

    // The tool handler, not the raw script: this is the surface an agent calls.
    const response = await handleToolCall({
      arguments: { cell: 64, out, source: blend },
      name: "blender_export_world",
    });
    const result = JSON.parse(response.content[0].text) as {
      ok: boolean;
      detail?: string;
      summary?: {
        assetsWritten: number;
        cells: number;
        instances: number;
        instancesByAsset: Record<string, number>;
        viewportInstances: number;
      };
    };
    expect(result.ok, result.detail ?? response.content[0].text).toBe(true);
    if (!result.ok || result.summary === undefined) return;
    const summary = result.summary;

    // Render density, not viewport: the fixture's Is Viewport switch makes them an order apart.
    expect(summary.instances).toBe(counts.render);
    expect(counts.render).not.toBe(counts.viewport);
    expect(summary.viewportInstances).toBe(counts.viewport);

    // Every asset written once, and its LOD beside it, with nothing extra in assets/. The ids are
    // the tn_asset_id values, so a fallback to the emitter's name would fail here.
    const assets = new Set(Object.keys(summary.instancesByAsset));
    expect([...assets].sort()).toEqual(["ground_cover", "pine", "rock"]);
    expect(summary.assetsWritten).toBe(assets.size);
    const expectedGlbs = [...assets]
      .flatMap((asset) => [`${asset}.glb`, `${asset}_lod1.glb`])
      .sort();
    expect(jsonFiles(path.join(out, "assets"))).toEqual(expectedGlbs);

    // The chunk collection straddles a cell boundary, so its objects land in two cells.
    const manifest = JSON.parse(
      readFileSync(path.join(out, "world.json"), "utf8"),
    ) as IWorldPackage;
    const chunkCells = manifest.cells.filter((cell) =>
      (cell.chunks ?? []).some((chunk) => chunk.startsWith("chunks/yard_")),
    );
    expect(chunkCells.length).toBeGreaterThanOrEqual(2);
    for (const cell of chunkCells) {
      for (const chunk of cell.chunks ?? []) expect(existsSync(path.join(out, chunk))).toBe(true);
    }

    // Every asset a run references must carry geometry.
    expectRunGeometry(out, manifest);

    // The contract the runtime enforces, against the bytes actually on disk.
    const validation = validateWorldPackage(manifest, {
      heightmapByteLength: readFileSync(path.join(out, "terrain/heightmap.u16")).byteLength,
      placementsByteLength: readFileSync(path.join(out, "placements.bin")).byteLength,
    });
    expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
    expect(validation.ok).toBe(true);
  }, 300_000);

  it("refuses an asset id that would write outside the output directory", async () => {
    const root = await makeTempDir("tn-export-world-traversal-");
    const out = path.join(root, "package");
    const source = await mutatedBlend(
      root,
      await makeFixtureBlend(root),
      `import bpy
bpy.ops.wm.open_mainfile(filepath=__BLEND__)
bpy.data.objects["pine"]["tn_asset_id"] = "../../escaped"
bpy.ops.wm.save_as_mainfile(filepath=__OUT__)
`,
    );

    const result = await exportWorld(out, source);

    // The name becomes a file path, so it has to be refused rather than normalised: an agent that
    // typed a slash must be told, not silently handed a package written over its own files.
    expect(result.ok, result.detail ?? "export refused").toBe(false);
    expect(result.detail ?? "").toMatch(/escaped.*outside the output directory/iu);
    expect(existsSync(path.join(root, "escaped.glb"))).toBe(false);
    expect(existsSync(path.join(root, "escaped_lod1.glb"))).toBe(false);
  }, 300_000);

  // The ancestor rule is about visibility, and Blender carries it on two objects: the Collection
  // datablock (Disable in Viewports/Renders) and the per-view-layer LayerCollection (the eye and
  // the checkbox). A chunk under either kind of hidden parent must skip.
  it.each([
    {
      label: "a hidden Collection datablock parent",
      mutate: `parent.hide_viewport = True
parent.hide_render = True`,
    },
    {
      label: "a hidden LayerCollection parent",
      mutate: `bpy.context.view_layer.layer_collection.children["hidden_parent"].hide_viewport = True`,
    },
    {
      label: "an excluded LayerCollection parent",
      mutate: `bpy.context.view_layer.layer_collection.children["hidden_parent"].exclude = True`,
    },
  ])(
    "skips a chunk collection nested under $label",
    async ({ mutate }) => {
      const root = await makeTempDir("tn-export-world-hidden-");
      const out = path.join(root, "package");
      const source = await mutatedBlend(
        root,
        await makeFixtureBlend(root),
        `import bpy
bpy.ops.wm.open_mainfile(filepath=__BLEND__)
yard = bpy.data.collections["yard"]
parent = bpy.data.collections.new("hidden_parent")
bpy.context.scene.collection.children.link(parent)
bpy.context.scene.collection.children.unlink(yard)
parent.children.link(yard)
bpy.context.view_layer.update()
${mutate}
bpy.ops.wm.save_as_mainfile(filepath=__OUT__)
`,
      );

      const result = await exportWorld(out, source);
      expect(result.ok, result.detail ?? "export succeeded").toBe(true);
      if (!result.ok) return;

      // The skip rule is about what a player can see, and nothing under a hidden or excluded parent is.
      expect(jsonFiles(path.join(out, "chunks"))).toEqual([]);
      const manifest = JSON.parse(
        readFileSync(path.join(out, "world.json"), "utf8"),
      ) as IWorldPackage;
      for (const cell of manifest.cells) expect(cell.chunks ?? []).toEqual([]);
      // The scatter is untouched: only the hidden subtree went away.
      expect(Object.keys(result.summary?.instancesByAsset ?? {}).sort()).toEqual([
        "ground_cover",
        "pine",
        "rock",
      ]);
    },
    300_000,
  );

  it("refuses a marked chunk collection whose name escapes the output directory", async () => {
    const root = await makeTempDir("tn-export-world-chunk-traversal-");
    const out = path.join(root, "package");
    const source = await mutatedBlend(
      root,
      await makeFixtureBlend(root),
      `import bpy
bpy.ops.wm.open_mainfile(filepath=__BLEND__)
bpy.data.collections["yard"].name = "../../escaped"
bpy.ops.wm.save_as_mainfile(filepath=__OUT__)
`,
    );

    const result = await exportWorld(out, source);

    // A collection name becomes a chunk file name, so `../` in it has to be refused, not silently
    // made relative to the package root.
    expect(result.ok, result.detail ?? "export refused").toBe(false);
    expect(result.detail ?? "").toMatch(/escaped.*outside the output directory/iu);
    expect(readdirSync(root).filter((entry) => entry.startsWith("escaped"))).toEqual([]);
  }, 300_000);

  it("refuses an output subdirectory symlinked outside the package", async () => {
    const root = await makeTempDir("tn-export-world-symlink-");
    const out = path.join(root, "package");
    const outside = path.join(root, "outside");
    mkdirSync(out, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // Absolute-path containment alone follows this link and writes through it; the output check
    // has to resolve symlinks to see that the write lands outside the package.
    symlinkSync(outside, path.join(out, "chunks"), "dir");

    const result = await exportWorld(out, await makeFixtureBlend(root));

    expect(result.ok, result.detail ?? "export refused").toBe(false);
    expect(result.detail ?? "").toMatch(/outside the output directory/iu);
    expect(readdirSync(outside)).toEqual([]);
  }, 300_000);
});

withBlender("export_terrain_layers against a real Blender", () => {
  /**
   * The layer table a game hands the recipe, with the DCC's own map files beside it. The recipe
   * copies map bytes verbatim, so only the mask has to be an image Blender can read.
   */
  async function terrainTable(root: string): Promise<string> {
    const dcc = path.join(root, "dcc");
    mkdirSync(dcc, { recursive: true });
    await writeFile(
      path.join(dcc, "moss-mask.png"),
      rgbaPng({
        blue: () => 255,
        green: () => 255,
        height: 8,
        red: (x, y) => (x * 32 + y * 16) % 256,
        width: 8,
      }),
    );
    for (const name of [
      "moss_diff.jpg",
      "moss_nrm.jpg",
      "moss_orm.jpg",
      "rock_diff.jpg",
      "rock_h.jpg",
    ])
      await writeFile(path.join(dcc, name), `TN_DCC_TEXTURE ${name}`);
    const table = path.join(dcc, "layers.json");
    await writeFile(
      table,
      JSON.stringify({
        base: {
          id: "moss",
          metalness: 0,
          normal: true,
          orm: true,
          roughness: 0.9,
          tile: 3,
          tint: [0.36, 0.47, 0.27],
        },
        breakup: { push: 0.2, scale: 0.3 },
        layers: [
          {
            channel: "r",
            hi: 0.8,
            height: true,
            id: "rock",
            lo: 0.2,
            mask: "moss-mask",
            metalness: 0.1,
            roughness: 0.7,
            tile: 6,
            tint: [1, 1, 1],
          },
        ],
        macro: { max: 1.1, min: 0.9, scale: 0.05 },
        masks: { "moss-mask": { image: "moss-mask.png" } },
        splatSize: 8,
        textures: {
          diff: "{id}_diff.jpg",
          h: "{id}_h.jpg",
          nrm: "{id}_nrm.jpg",
          orm: "{id}_orm.jpg",
        },
      }),
    );
    return table;
  }

  it("writes the ORM map of a layer whose material has a roughness input, beside its other maps", async () => {
    const root = await makeTempDir("tn-export-terrain-layers-");
    const blend = await makeFixtureBlend(root);
    const out = path.join(root, "package");
    await blenderRun(root, [
      "-b",
      blend,
      "--python",
      recipeScript,
      "--",
      "--out",
      out,
      "--cell",
      "64",
      "--terrain-layers",
      await terrainTable(root),
    ]);
    const tex = path.join(out, "terrain/tex");
    expect(jsonFiles(tex)).toEqual([
      "moss_diff.jpg",
      "moss_nrm.jpg",
      "moss_orm.jpg",
      "rock_diff.jpg",
      "rock_h.jpg",
    ]);
    expect(readFileSync(path.join(tex, "rock_h.jpg"), "utf8")).toBe("TN_DCC_TEXTURE rock_h.jpg");
    expect(readFileSync(path.join(tex, "moss_orm.jpg"), "utf8")).toBe(
      "TN_DCC_TEXTURE moss_orm.jpg",
    );
    // The shipped table carries each layer's light response: the ORM flag, or its two numbers.
    const shipped = JSON.parse(readFileSync(path.join(out, "terrain/layers.json"), "utf8")) as {
      base: { orm?: boolean };
      layers: { roughness: number }[];
    };
    expect(shipped.base.orm).toBe(true);
    expect(shipped.layers[0]?.roughness).toBe(0.7);
    expect(
      JSON.parse(readFileSync(path.join(out, "world.json"), "utf8")).terrain.layers.table,
    ).toBe("terrain/layers.json");
  }, 300_000);

  it("refuses a table whose ORM layer names no orm source texture", async () => {
    const root = await makeTempDir("tn-export-terrain-layers-noorm-");
    const blend = await makeFixtureBlend(root);
    const out = path.join(root, "package");
    const table = await terrainTable(root);
    const authored = JSON.parse(readFileSync(table, "utf8")) as {
      textures: Record<string, string>;
    };
    authored.textures = { diff: "{id}_diff.jpg", h: "{id}_h.jpg", nrm: "{id}_nrm.jpg" };
    await writeFile(table, JSON.stringify(authored));
    await expect(
      blenderRun(root, [
        "-b",
        blend,
        "--python",
        recipeScript,
        "--",
        "--out",
        out,
        "--cell",
        "64",
        "--terrain-layers",
        table,
      ]),
    ).rejects.toThrow();
    expect(existsSync(path.join(out, "terrain/tex/moss_orm.jpg"))).toBe(false);
  }, 300_000);

  it("refuses a table whose height layer names no h source texture", async () => {
    const root = await makeTempDir("tn-export-terrain-layers-noheight-");
    const blend = await makeFixtureBlend(root);
    const out = path.join(root, "package");
    const table = await terrainTable(root);
    const authored = JSON.parse(readFileSync(table, "utf8")) as {
      textures: Record<string, string>;
    };
    authored.textures = { diff: "{id}_diff.jpg", nrm: "{id}_nrm.jpg", orm: "{id}_orm.jpg" };
    await writeFile(table, JSON.stringify(authored));
    await expect(
      blenderRun(root, [
        "-b",
        blend,
        "--python",
        recipeScript,
        "--",
        "--out",
        out,
        "--cell",
        "64",
        "--terrain-layers",
        table,
      ]),
    ).rejects.toThrow();
    expect(existsSync(path.join(out, "terrain/tex/rock_h.jpg"))).toBe(false);
  }, 300_000);
});
