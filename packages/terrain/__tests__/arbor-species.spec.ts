import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vegetationPresets } from "@threenative/procedural-vegetation";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { cookKit } from "../src/cook/cook.js";
import { TERRAIN_TOOLS, newBiomeSpec, parseGenerateRequest } from "../src/mcp/tools.js";
import {
  ARBOR_TREE_IDS,
  growArborRows,
  parseArborSpecies,
} from "../src/population/arbor-species.js";
import { ECOREGION_ROWS } from "../src/request/ecoregions.js";
import { TREE_WORD_ROWS } from "../src/request/request-words.js";

async function project(options: { vegetation: boolean }) {
  const root = await realpath(await makeTempDir("tn-terrain-arbor-"));
  await mkdir(join(root, "node_modules", "@threenative"), { recursive: true });
  await symlink(
    new URL("../../assets/", import.meta.url).pathname,
    join(root, "node_modules", "@threenative", "assets"),
  );
  if (options.vegetation)
    await symlink(
      new URL("../../procedural-vegetation/", import.meta.url).pathname,
      join(root, "node_modules", "@threenative", "procedural-vegetation"),
    );
  await writeFile(
    join(root, "threenative.config.ts"),
    'export default { assets: { source: "assets" } };',
  );
  return {
    out: join(root, "assets", "worlds", "world"),
    remove: () => rm(root, { recursive: true, force: true }),
    root,
  };
}

/** The glTF JSON of a cooked species file: its meshes' attribute names and the _WIND accessor type. */
async function speciesGltf(world: string, species: string) {
  const manifest = JSON.parse(await readFile(join(world, "world.json"), "utf8"));
  const file = join(world, manifest.assets[species].glb);
  const bytes = await readFile(file);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  const primitives = gltf.meshes.flatMap((mesh: { primitives: unknown[] }) => mesh.primitives) as {
    attributes: Record<string, number>;
  }[];
  return { gltf, primitives, wind: gltf.accessors[primitives[0]?.attributes._WIND as number] };
}

async function grove(species: readonly string[]) {
  const base = JSON.parse(
    await readFile(new URL("../starter/forest/biome.data.json", import.meta.url), "utf8"),
  );
  const row = base.foliage[0];
  return newBiomeSpec(base, "grove", {
    foliage: species.map((name) => ({
      ...row,
      density: 400,
      far: { ...row.far, impostor: 400 },
      species: name,
      stands: false,
    })),
    landform: "rollingHills",
    sizeMeters: 256,
    species,
  });
}

describe("Arbor species in a terrain cook", () => {
  it("grows a kit row's form patch into its own bake, and keeps the patch out of the asset row", async () => {
    const fixture = await project({ vegetation: true });
    try {
      const table: Record<string, object> = {
        fir: { arbor: "spruce@7", form: { leaves: [{ count: 40 }] }, tree: true },
        plain: { arbor: "spruce@7" },
      };
      await growArborRows(table, fixture.root, join(fixture.root, "scratch"));
      const fir = table.fir as { near: string; tree?: boolean };
      expect(fir.near).toMatch(/spruce-7-f[0-9a-f]{8}-lod\d\.glb$/u);
      expect((table.plain as { near: string }).near).toMatch(/spruce-7-lod\d\.glb$/u);
      expect(fir).not.toHaveProperty("form");
      expect(fir.tree).toBe(true);
    } finally {
      await fixture.remove();
    }
  });

  it("parses arbor:<preset>[@seed] and fails closed on a malformed name", () => {
    expect(parseArborSpecies("arbor:oak@7")).toEqual({ preset: "oak", seed: 7 });
    expect(parseArborSpecies("arbor:spruce")).toEqual({ preset: "spruce", seed: 1 });
    expect(parseArborSpecies("fir")).toBeUndefined();
    expect(() => parseArborSpecies("arbor:Oak@x")).toThrow(/arbor:<preset>@<seed>/u);
  });

  it("cooks arbor:oak@7 and arbor:spruce rows into placed, instanced Arbor GLBs", async () => {
    const { out, remove, root } = await project({ vegetation: true });
    try {
      const result = JSON.parse(
        await cookKit({
          ground: "procedural",
          kit: "forest",
          out,
          projectRoot: root,
          spec: await grove(["arbor:oak@7", "arbor:spruce"]),
        }),
      );
      expect(Object.keys(result.placementCounts)).toEqual(
        expect.arrayContaining(["arbor-oak-7", "arbor-spruce-1"]),
      );
      expect(result.placementCounts["arbor-oak-7"]).toBeGreaterThan(0);
      expect(result.placementCounts["arbor-spruce-1"]).toBeGreaterThan(0);
      for (const species of ["arbor-oak-7", "arbor-spruce-1"]) {
        const { primitives, wind } = await speciesGltf(out, species);
        // The Arbor GLB itself reaches the world: its wind weights and leaf cards survive the cook.
        expect(primitives.length).toBeGreaterThan(1);
        expect(wind.type).toBe("VEC4");
        for (const primitive of primitives)
          expect(Object.keys(primitive.attributes)).toEqual(
            expect.arrayContaining(["COLOR_0", "TEXCOORD_0", "_WIND"]),
          );
      }
    } finally {
      await remove();
    }
  }, 240_000);

  it("fails closed, naming the install, when the bake package is missing", async () => {
    const { out, remove, root } = await project({ vegetation: false });
    try {
      await expect(
        cookKit({
          ground: "procedural",
          kit: "forest",
          out,
          projectRoot: root,
          spec: await grove(["arbor:oak@7"]),
        }),
      ).rejects.toThrow(/npm i -D @threenative\/procedural-vegetation/u);
      await expect(readdir(out)).rejects.toThrow();
    } finally {
      await remove();
    }
  }, 120_000);

  it("a request that names a tree cooks that tree in place of the kit's own", async () => {
    const request = parseGenerateRequest({ request: "a birch forest, small" });
    expect(request.input.treeSpecies).toBe("arbor:birch");
    expect(request.decided.tree).toEqual({ source: { word: "birch" }, value: "arbor:birch" });
    expect(request.unused).not.toContain("birch");
    // A word a biome answers to keeps its meaning: the kit's own conifer, the catalog starter.
    const spruce = parseGenerateRequest({ request: "a spruce forest" });
    expect(spruce.input.treeSpecies).toBeUndefined();
    expect(spruce.decided.tree.value).toBeNull();
    const { out, remove, root } = await project({ vegetation: true });
    try {
      const result = JSON.parse(
        await cookKit({
          ground: "procedural",
          kit: "forest",
          landform: "rollingHills",
          out,
          projectRoot: root,
          sizeMeters: 256,
          treeSpecies: "arbor:birch",
        }),
      );
      // The kit's tree id now draws the Arbor birch: same placements, new art with its _WIND.
      expect(result.placementCounts.fir).toBeGreaterThan(0);
      expect((await speciesGltf(out, "fir")).wind.type).toBe("VEC4");
      expect(Object.keys(result.placementCounts)).not.toContain("arbor-birch-1");
      // The load sways them: the reply hands the game its wind file and wires it as partMaterial.
      expect(result.load).toContain('import { arborWind } from "./render/arborWind.js";');
      expect(result.load).toContain("  partMaterial: arborWind,");
      expect(result.trees.file).toBe("src/render/arborWind.ts");
      expect(result.trees.source).toContain('attribute<"vec4">("_wind", "vec4")');
      expect(result.trees.source).toContain("export function arborWind(");
    } finally {
      await remove();
    }
  }, 240_000);

  it("plants each region a mix of presets, from the kit's own canopy", async () => {
    const trees = vegetationPresets()
      .filter((preset) => preset.kind === "tree")
      .map((preset) => preset.id);
    for (const row of ECOREGION_ROWS) {
      const foliage = row.overrides.foliage ?? [];
      // More than one species, each at more than one seed: a community, not one cloned tree.
      const presets = new Map<string, number>();
      for (const canopy of foliage) {
        const species = parseArborSpecies(canopy.species);
        expect(species, `${row.id}: ${canopy.species}`).toBeDefined();
        expect(trees, `${row.id}: ${canopy.species}`).toContain(species?.preset);
        const preset = species?.preset as string;
        presets.set(preset, (presets.get(preset) ?? 0) + 1);
      }
      expect(presets.size, row.id).toBeGreaterThanOrEqual(3);
      for (const [preset, seeds] of presets)
        expect(seeds, `${row.id}: ${preset}`).toBeGreaterThan(1);
      // The rows it replaces are the kit's own art, and the merged biome is a valid one.
      const assets = JSON.parse(
        await readFile(new URL(`../starter/${row.kit}/assets.json`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;
      for (const id of row.canopy) expect(Object.keys(assets), `${row.id}: ${id}`).toContain(id);
      const base = JSON.parse(
        await readFile(new URL(`../starter/${row.kit}/biome.data.json`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;
      expect(() =>
        newBiomeSpec(base, row.id, row.overrides as Record<string, unknown>),
      ).not.toThrow();
    }
  });

  it("keeps the request words, the schema text and the package's presets in step", () => {
    const trees = vegetationPresets()
      .filter((preset) => preset.kind === "tree")
      .map((preset) => preset.id);
    expect([...ARBOR_TREE_IDS]).toEqual(trees);
    for (const [id] of TREE_WORD_ROWS) expect(trees).toContain(id);
    for (const name of ["terrain_generate", "terrain_biome_new"]) {
      const text = JSON.stringify(TERRAIN_TOOLS.find((tool) => tool.name === name));
      for (const id of trees) expect(text).toContain(id);
      expect(text).toContain("npm i -D @threenative/procedural-vegetation");
    }
  });
});
