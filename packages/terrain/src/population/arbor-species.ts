import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IBiomeSpec } from "../biome/biome.js";

/** The slice of `@threenative/procedural-vegetation` the cook calls; loaded from the game project. */
interface IVegetation {
  bakeVegetation(options: {
    lods: readonly number[];
    out: string;
    preset: string;
    seed: number;
  }): Promise<
    { bounds: { max: [number, number, number]; min: [number, number, number] }; path: string }[]
  >;
  vegetationPresets(): { id: string; kind: string }[];
}

/** The cook's asset-table row; `near` and `mid` may be absolute, which `resolve` keeps as they are. */
export interface IArborAsset {
  bounds: { max: [number, number, number]; min: [number, number, number] };
  maxDistance: number;
  mid: string;
  midDistance: number;
  near: string;
  tree?: boolean;
}

/** Every tree preset `@threenative/procedural-vegetation` bakes, for the tool schemas; a spec checks it. */
export const ARBOR_TREE_IDS: readonly string[] = [
  "oak",
  "beech",
  "birch",
  "spruce",
  "scotspine",
  "blackspruce",
  "aspen",
  "douglasfir",
  "redcedar",
  "bigleafmaple",
  "cypress",
  "olive",
  "stonepine",
  "acacia",
  "baobab",
  "coconut",
  "banana",
  "kapok",
  "sakura",
  "jmaple",
  "ginkgo",
  "bamboo",
  "saguaro",
  "joshua",
  "fanpalm",
  "araucaria",
  "ipe",
  "jacaranda",
];

const PACKAGE = "@threenative/procedural-vegetation";
const SPECIES = /^arbor:([a-z0-9]+)(?:@(\d{1,9}))?$/u;
// The streamed LOD1 (about 7k triangles) is what an instanced stand draws; LOD2 is the far level.
const LODS = [1, 2] as const;

/** `arbor:oak@7` is `{ preset: "oak", seed: 7 }`; a name with no prefix is not an Arbor species. */
export function parseArborSpecies(species: string): { preset: string; seed: number } | undefined {
  if (!species.startsWith("arbor:")) return undefined;
  const match = SPECIES.exec(species);
  if (match === null)
    throw new Error(
      `cook: species '${species}' must read arbor:<preset> or arbor:<preset>@<seed>, for example arbor:oak@7.`,
    );
  return { preset: match[1] as string, seed: match[2] === undefined ? 1 : Number(match[2]) };
}

/** A species id becomes a file name in the cooked world, so it has no ':' or '@'. */
const idOf = (preset: string, seed: number) => `arbor-${preset}-${seed}`;

function installedEntry(projectRoot: string): string | undefined {
  let directory = resolve(projectRoot);
  while (true) {
    const manifestFile = join(directory, "node_modules", PACKAGE, "package.json");
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        exports?: { "."?: { import?: string } | string };
        main?: string;
      };
      const root = manifest.exports?.["."];
      const file = (typeof root === "string" ? root : root?.import) ?? manifest.main;
      return file === undefined ? undefined : resolve(dirname(manifestFile), file);
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function loadVegetation(projectRoot: string, wanted: string): Promise<IVegetation> {
  const entry = installedEntry(projectRoot);
  if (entry === undefined || !existsSync(entry))
    throw new Error(`cook: species '${wanted}' needs the Arbor bake: npm i -D ${PACKAGE}`);
  return (await import(pathToFileURL(entry).href)) as IVegetation;
}

/**
 * Bakes one `arbor:<preset>[@seed]` species into `scratch` as a near and a mid level, with the
 * asset row a cook or a kit bake reads. `@threenative/procedural-vegetation` comes from `projectRoot`.
 */
export async function growArborAsset(
  projectRoot: string,
  scratch: string,
  species: string,
  seedOffset = 0,
): Promise<IArborAsset> {
  const parsed = parseArborSpecies(species);
  if (parsed === undefined) throw new Error(`cook: species '${species}' must start with arbor:.`);
  const seed = parsed.seed + seedOffset;
  const id = idOf(parsed.preset, seed);
  const vegetation = await loadVegetation(projectRoot, species);
  if (!vegetation.vegetationPresets().some((p) => p.id === parsed.preset))
    throw new Error(
      `cook: species '${species}' names no Arbor preset. Call vegetationPresets() from ${PACKAGE} for the ids.`,
    );
  const files = await vegetation.bakeVegetation({
    lods: LODS,
    out: join(scratch, id),
    preset: parsed.preset,
    seed,
  });
  const [near, mid] = files as [(typeof files)[number], (typeof files)[number]];
  return { bounds: near.bounds, maxDistance: 600, mid: mid.path, midDistance: 45, near: near.path };
}

/**
 * Grows each kit asset row written `{ "arbor": "douglasfir@3" }` in place: the baked near and mid
 * levels and bounds join the row, and the row's own fields win. Returns whether any row grew.
 */
export async function growArborRows(
  table: Record<string, object>,
  projectRoot: string,
  scratch: string,
): Promise<boolean> {
  let grew = false;
  for (const [id, spec] of Object.entries(table)) {
    const { arbor, ...row } = spec as { arbor?: string };
    if (arbor === undefined) continue;
    table[id] = { ...(await growArborAsset(projectRoot, scratch, `arbor:${arbor}`)), ...row };
    grew = true;
  }
  return grew;
}

/**
 * Grows the Arbor species a cook names. An explicit `arbor:<preset>[@seed]` row of the biome, and
 * `treeSpecies` (a request that names a tree) in place of the kit's own tree art, each bake once per
 * distinct preset and seed into `scratch`, and join `assetTable` under a bare id. The returned biome
 * names those ids, so the ordinary scatter draws them. A kit's tree variants take consecutive seeds,
 * so a stand of one species is not one cloned tree.
 */
export async function growArborSpecies(options: {
  assetTable: Record<string, object>;
  biome: IBiomeSpec;
  projectRoot: string;
  scratch: string;
  treeSpecies?: string;
}): Promise<IBiomeSpec> {
  const { assetTable, biome, projectRoot, scratch, treeSpecies } = options;
  const named = new Set(
    [...biome.species, ...biome.foliage.map((row) => row.species)].filter((id) =>
      id.startsWith("arbor:"),
    ),
  );
  if (named.size === 0 && treeSpecies === undefined) return biome;
  const baked = new Map<string, IArborAsset>();
  const grow = async (species: string, seedOffset = 0): Promise<[string, IArborAsset]> => {
    const parsed = parseArborSpecies(species) as { preset: string; seed: number };
    const id = idOf(parsed.preset, parsed.seed + seedOffset);
    const asset =
      baked.get(id) ?? (await growArborAsset(projectRoot, scratch, species, seedOffset));
    baked.set(id, asset);
    return [id, asset];
  };
  if (treeSpecies !== undefined) {
    // The kit's tree art is a family of variants in one folder (fir, fir-c): all of them change, one
    // seed each. A kit with no tree gets the Arbor tree as the one the biome's tree row draws.
    const art = assetTable as Record<string, { near: string; tree?: boolean }>;
    const families = new Set(
      Object.values(art)
        .filter((spec) => spec.tree === true)
        .map((spec) => dirname(spec.near)),
    );
    const kitTrees = Object.keys(art).filter((id) => families.has(dirname(art[id]?.near ?? "")));
    if (kitTrees.length === 0) {
      const [id, asset] = await grow(treeSpecies);
      assetTable[id] = { ...asset, tree: true };
    }
    for (const [at, id] of kitTrees.entries()) {
      const [, asset] = await grow(treeSpecies, at);
      assetTable[id] = { ...asset, tree: art[id]?.tree === true };
    }
  }
  const ids = new Map<string, string>();
  for (const species of named) {
    const [id, asset] = await grow(species);
    assetTable[id] = asset;
    ids.set(species, id);
  }
  const rename = (species: string) => ids.get(species) ?? species;
  return {
    ...biome,
    foliage: biome.foliage.map((row) => ({ ...row, species: rename(row.species) })),
    species: [...new Set(biome.species.map(rename))],
  };
}
