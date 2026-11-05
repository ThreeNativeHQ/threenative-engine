import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BIOME_WORD_ROWS, biomeWordList } from "../core/biome-words.js";
import { type IBiomeSpec, type IBiomeWaterBody, validateBiome } from "../core/biome.js";
import { TERRAIN_KITS, type TerrainKit } from "../core/kits.js";
import { OPERATION_TYPES } from "../core/operations.js";
import { LANDFORMS, type LandformKind } from "../core/presets.js";
import { Terrain } from "../core/terrain.js";
import type { LayerPatch, PatchCommand } from "../core/terrain.js";
import type { ITerrainDocument, Layer } from "../core/types.js";

export { TERRAIN_KITS, type TerrainKit } from "../core/kits.js";

export interface IGenerateInput {
  kit: TerrainKit;
  /** The biome's own rules, when the request carries a spec instead of a starter's file. */
  spec?: IBiomeSpec;
  /** One of `LANDFORMS`: a shape the five starters do not ship cooks from its preset. */
  landform?: LandformKind;
  sizeMeters?: number;
  seed?: number;
  /** Replaces the water bodies the biome declares: what the world floods. */
  water?: readonly IBiomeWaterBody[];
  out?: string;
}

const PATCH_OPS: readonly string[] = ["upsert", "update", "remove", "move", "toggle"];

export const TERRAIN_TOOLS = [
  {
    name: "terrain_generate",
    description:
      "Choose from a request, an explicit kit or a biome and cook one editable starter terrain kit (forest, coastal, alpine, desert or tundra) into a world.glb; `biome` names a starter or one of its alias words, or carries an inline IBiomeSpec whose own landform, size and seed build the ground; `landform` swaps the ground for one of the seven shape presets (alpine, temperateMountains, rollingHills, desertMesa, coastalCliffs, tundra, volcanic) and keeps the kit's surface and assets; `water` replaces the water bodies the biome declares and changes the cooked world: an ocean row floods to its level, a river or lake row re-shapes the recipe's own river or lake in order (width or radius), a recipe layer with no row is removed, and a river or lake row with no layer to take it fails. Returns the kit as recipe, the biome it bakes, that biome's declared water and its band rows resolved against the cooked heights (`bands`), the world.glb, recipe.json and world.json paths, triangles, instances and draws measured from the produced GLB's default scene, and a ctx.assets.model load snippet. triangles counts every instance of the LOD0 default scene in full, before distance LOD and culling, instances sums the EXT_mesh_gpu_instancing instances, and draws counts primitives across instanced and non-instanced meshes, an instanced primitive counting once.",
    inputSchema: {
      type: "object",
      properties: {
        kit: { type: "string", enum: [...TERRAIN_KITS] },
        biome: {
          description:
            "A starter biome's name or alias word (forest, woods, beach, ...), or an inline IBiomeSpec object; a spec cooks with `kit`'s surface and assets, forest's when kit is absent.",
          anyOf: [{ type: "string", minLength: 1 }, { type: "object" }],
        },
        landform: { type: "string", enum: Object.keys(LANDFORMS) },
        request: { type: "string", minLength: 1 },
        sizeMeters: { type: "number", exclusiveMinimum: 0 },
        seed: { type: "integer" },
        water: {
          type: "array",
          items: { type: "object" },
          description:
            "IBiomeWaterBody rows that replace the biome's declared water: river (width), lake (radius), ocean (level).",
        },
        out: {
          type: "string",
          description:
            "Relative directory under the project's assets.source that must not exist yet; the default is assets.source/worlds/<kit>.",
        },
      },
      anyOf: [{ required: ["request"] }, { required: ["kit"] }, { required: ["biome"] }],
      additionalProperties: false,
    },
  },
  {
    name: "terrain_biome_new",
    description:
      "Make a new biome from a shipped one and cook it: copies the base biome's biome.data.json into <assets.source>/biomes/<name>/, applies the overrides, validates the file with validateBiome, then cooks it with the base kit's surface and assets and the biome's own landform preset. One call writes only under <assets.source>/biomes/<name>/, its cooked world included. Returns the same cook result as terrain_generate plus the biome file path and the biome's resolved `bands`. No code changes anywhere: the biome is data.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", enum: [...TERRAIN_KITS] },
        name: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,31}$",
          description: "The new biome's folder and look name; lowercase, no spaces.",
        },
        overrides: {
          type: "object",
          description:
            "IBiomeSpec fields to change on the base file (landform, foliage, grass, layers, water, spawn, species, aliases, bake). An unknown field fails.",
        },
        out: {
          type: "string",
          description:
            "Relative directory under the project's assets.source that must not exist yet; the default is assets.source/biomes/<name>/world.",
        },
      },
      required: ["from", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "terrain_patch",
    description:
      "Apply editor commands (upsert, update, remove, move, toggle) to a terrain recipe and return the edited recipe.",
    inputSchema: {
      type: "object",
      properties: {
        recipe: { type: "object" },
        commands: { type: "array", items: { type: "object" } },
      },
      required: ["recipe", "commands"],
      additionalProperties: false,
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects any field the tool does not declare, so a typo never falls back to a default. */
function closedRecord(
  input: unknown,
  tool: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError(`${tool}: arguments must be an object.`);
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new TypeError(`${tool}: unknown field '${key}'.`);
  }
  return input;
}

function relativeDirectory(out: unknown): string {
  if (
    typeof out !== "string" ||
    out.trim() === "" ||
    isAbsolute(out) ||
    out.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError("terrain_generate: out must be a relative directory inside the project.");
  }
  return out;
}

const GENERATE_FIELDS = [
  "request",
  "kit",
  "biome",
  "landform",
  "sizeMeters",
  "seed",
  "water",
  "out",
];
const BIOME_NEW_FIELDS = ["from", "name", "overrides", "out"];

/** A new biome's folder name, and the look it will resolve under the game it is baked for. */
export interface IBiomeNewInput {
  from: TerrainKit;
  name: string;
  overrides?: Record<string, unknown>;
  out?: string;
}

const LANDFORM_KINDS = Object.keys(LANDFORMS) as readonly LandformKind[];

/**
 * The `biome` argument: a starter's name or one of its alias words resolves the kit, and an inline
 * `IBiomeSpec` carries the biome's own rules. Anything else fails naming what this field accepts.
 */
function parseBiomeArgument(biome: unknown): { kit?: TerrainKit; spec?: IBiomeSpec } {
  if (biome === undefined) return {};
  if (typeof biome === "string") {
    const word = biome.trim().toLowerCase();
    const kit = BIOME_WORD_ROWS.find(([, names]) => names.includes(word))?.[0];
    if (kit === undefined) {
      throw new TypeError(
        `terrain_generate: biome '${biome}' matches no biome. Try one of: ${biomeWordList()}.`,
      );
    }
    return { kit };
  }
  if (isRecord(biome)) {
    const look = biome.look;
    return { spec: validateBiome(biome, typeof look === "string" ? look : "biome") };
  }
  throw new TypeError(
    "terrain_generate: biome must be a starter name, an alias word or a biome spec object.",
  );
}

/** `water` replaces the biome's declared bodies; the rows themselves are checked at the bake. */
function parseWater(water: unknown): readonly IBiomeWaterBody[] | undefined {
  if (water === undefined) return undefined;
  if (!Array.isArray(water) || water.some((body) => !isRecord(body))) {
    throw new TypeError("terrain_generate: water must be an array of water body objects.");
  }
  return water as readonly IBiomeWaterBody[];
}

export function parseGenerateInput(input: unknown): IGenerateInput {
  const args = closedRecord(input, "terrain_generate", GENERATE_FIELDS);
  const { request, sizeMeters, seed, out } = args;
  if (request !== undefined && (typeof request !== "string" || request.trim() === "")) {
    throw new TypeError("terrain_generate: request must be a non-empty string.");
  }
  const words = typeof request === "string" ? request.toLowerCase().split(/[^a-z]+/u) : [];
  const { kit: biomeKit, spec } = parseBiomeArgument(args.biome);
  const kit =
    args.kit ??
    biomeKit ??
    // A spec carries no appearance, so it cooks with the forest starter's surface and assets.
    (spec === undefined
      ? TERRAIN_KITS[
          BIOME_WORD_ROWS.findIndex(([, names]) => names.some((name) => words.includes(name)))
        ]
      : "forest");
  if (typeof kit !== "string" || !(TERRAIN_KITS as readonly string[]).includes(kit)) {
    // A request that matched nothing names what it could have matched, so the caller can retry
    // without guessing: every biome and the words it answers to, never a silent default.
    throw new TypeError(
      request === undefined
        ? `terrain_generate: kit must be one of ${TERRAIN_KITS.join(", ")}.`
        : `terrain_generate: request '${request}' matches no biome. Try one of: ${biomeWordList()}.`,
    );
  }
  const parsed: IGenerateInput = { kit: kit as TerrainKit };
  if (spec !== undefined) parsed.spec = spec;
  if (args.landform !== undefined) {
    if (!LANDFORM_KINDS.includes(args.landform as LandformKind))
      throw new TypeError(
        `terrain_generate: landform must be one of ${LANDFORM_KINDS.join(", ")}.`,
      );
    parsed.landform = args.landform as LandformKind;
  }
  if (sizeMeters !== undefined) {
    if (typeof sizeMeters !== "number" || !Number.isFinite(sizeMeters) || sizeMeters <= 0) {
      throw new TypeError("terrain_generate: sizeMeters must be a positive finite number.");
    }
    parsed.sizeMeters = sizeMeters;
  }
  if (seed !== undefined) {
    if (typeof seed !== "number" || !Number.isSafeInteger(seed)) {
      throw new TypeError("terrain_generate: seed must be a safe integer.");
    }
    parsed.seed = seed;
  }
  const water = parseWater(args.water);
  if (water !== undefined) parsed.water = water;
  if (out !== undefined) parsed.out = relativeDirectory(out);
  return parsed;
}

/**
 * A `terrain_biome_new` request: a shipped base, a folder-safe new name, an optional set of spec
 * overrides and an optional output directory.
 */
export function parseBiomeNewInput(input: unknown): IBiomeNewInput {
  const args = closedRecord(input, "terrain_biome_new", BIOME_NEW_FIELDS);
  const from = args.from;
  if (typeof from !== "string" || !(TERRAIN_KITS as readonly string[]).includes(from))
    throw new TypeError(`terrain_biome_new: from must be one of ${TERRAIN_KITS.join(", ")}.`);
  const name = args.name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(name))
    throw new TypeError(
      "terrain_biome_new: name must be lowercase letters, digits and dashes, starting with a letter.",
    );
  // A shipped kit's folder belongs to the package; a new biome must not shadow or overwrite one.
  if ((TERRAIN_KITS as readonly string[]).includes(name))
    throw new TypeError(`terrain_biome_new: '${name}' is a shipped biome; choose a new name.`);
  const overrides = args.overrides;
  if (overrides !== undefined && !isRecord(overrides))
    throw new TypeError("terrain_biome_new: overrides must be an object.");
  const parsed: IBiomeNewInput = { from: from as TerrainKit, name };
  if (overrides !== undefined) parsed.overrides = { ...overrides };
  if (args.out !== undefined) parsed.out = relativeDirectory(args.out);
  return parsed;
}

/**
 * A new biome's file: the base spec with the request's overrides applied, its `look` and first
 * `aliases` word defaulting to the new name. Validated, so an override the schema does not have
 * fails here and names the field rather than reaching a bake.
 */
export function newBiomeSpec(
  base: unknown,
  name: string,
  overrides: Record<string, unknown> = {},
): IBiomeSpec {
  return validateBiome(
    {
      ...(base as Record<string, unknown>),
      ...overrides,
      aliases: (overrides.aliases as string[] | undefined) ?? [name],
      look: (overrides.look as string | undefined) ?? name,
    },
    name,
  );
}

/**
 * Resolves `out` under `root` and fails closed unless the real path stays inside the real root.
 * The deepest existing ancestor is resolved through `realpath`, so a symlinked `out` or a symlinked
 * ancestor that leaves the root is rejected, as is a dangling link. Returns the verified real path.
 * With `assetSource`, the same guard requires `out` under it: the cook writes a manifest the build
 * reads, and a directory outside `assets.source` never reaches that manifest.
 */
export async function resolveOutput(
  root: string,
  out: string,
  assetSource?: string,
): Promise<string> {
  const realRoot = await realpath(root);
  let existing = resolve(realRoot, out);
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // ENOENT on a path that lstat finds is a dangling symlink, which a mkdir would follow.
      if (
        await lstat(existing).then(
          () => true,
          () => false,
        )
      ) {
        throw new Error(`terrain_generate: out '${out}' passes through a dangling symlink.`);
      }
      tail.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const real = join(existing, ...tail);
  const inside = relative(realRoot, real);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`terrain_generate: out '${out}' resolves outside the project.`);
  }
  if (assetSource !== undefined) {
    const under = relative(assetSource, real);
    if (under === "" || under === ".." || under.startsWith(`..${sep}`) || isAbsolute(under))
      throw new Error(
        `terrain_generate: out '${out}' must be under assets.source ('${relative(realRoot, assetSource)}') so the build lists the world in its manifest.`,
      );
  }
  await assertOutputFree(real);
  return real;
}

/** Fails closed when the output directory already exists, so a cook never replaces files. */
export async function assertOutputFree(dir: string): Promise<void> {
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entries !== undefined) {
    throw new Error(`terrain_generate: out '${dir}' already exists; choose a new directory.`);
  }
}

function isTerrainDocument(input: unknown): input is ITerrainDocument {
  Terrain.fromJSON(JSON.stringify(input));
  return true;
}

function isLayer(input: unknown): input is Layer {
  isTerrainDocument({ version: 1, config: new Terrain().config, layers: [input] });
  return true;
}

function isLayerPatch(
  patch: Record<string, unknown>,
): patch is Record<string, unknown> & LayerPatch {
  if (patch.mask !== undefined && patch.mask !== null) {
    isLayer({ id: "validation", type: "noise", params: {}, mask: patch.mask });
  }
  return (
    (patch.type === undefined || OPERATION_TYPES.some((type) => type === patch.type)) &&
    (patch.name === undefined || typeof patch.name === "string") &&
    (patch.enabled === undefined || typeof patch.enabled === "boolean") &&
    (patch.opacity === undefined ||
      (typeof patch.opacity === "number" && Number.isFinite(patch.opacity))) &&
    (patch.params === undefined || isRecord(patch.params))
  );
}

function parseCommand(command: unknown, index: number): PatchCommand {
  if (!isRecord(command) || !PATCH_OPS.includes(command.op as string)) {
    throw new TypeError(
      `terrain_patch: command ${index} op must be one of ${PATCH_OPS.join(", ")}.`,
    );
  }
  if (command.op === "upsert") {
    if (!isRecord(command.layer)) {
      throw new TypeError(`terrain_patch: command ${index} needs a layer object.`);
    }
    if (!isLayer(command.layer)) {
      throw new TypeError(`terrain_patch: command ${index} needs a valid layer.`);
    }
    return { ...command, op: "upsert", layer: command.layer };
  }
  if (typeof command.id !== "string") {
    throw new TypeError(`terrain_patch: command ${index} needs a layer id.`);
  }
  const id = command.id;
  switch (command.op) {
    case "update": {
      if (!isRecord(command.patch) || !isLayerPatch(command.patch)) {
        throw new TypeError(`terrain_patch: command ${index} needs a valid patch object.`);
      }
      return { ...command, op: "update", id, patch: command.patch };
    }
    case "move":
      if (typeof command.index !== "number" || !Number.isInteger(command.index)) {
        throw new TypeError(`terrain_patch: command ${index} needs an integer index.`);
      }
      return { ...command, op: "move", id, index: command.index };
    case "toggle":
      if (command.enabled !== undefined && typeof command.enabled !== "boolean") {
        throw new TypeError(`terrain_patch: command ${index} enabled must be a boolean.`);
      }
      return { ...command, op: "toggle", id };
    case "remove":
      return { ...command, op: "remove", id };
    default:
      throw new TypeError(`terrain_patch: command ${index} has an unknown op.`);
  }
}

export function parsePatchInput(input: unknown): {
  recipe: ITerrainDocument;
  commands: PatchCommand[];
} {
  const args = closedRecord(input, "terrain_patch", ["recipe", "commands"]);
  if (!isRecord(args.recipe)) {
    throw new TypeError("terrain_patch: recipe must be a terrain document object.");
  }
  if (!Array.isArray(args.commands)) {
    throw new TypeError("terrain_patch: commands must be an array.");
  }
  if (!isTerrainDocument(args.recipe)) {
    throw new TypeError("terrain_patch: recipe must be a valid terrain document.");
  }
  const commands = args.commands.map(parseCommand);
  patchRecipe(args.recipe, commands);
  return { recipe: args.recipe, commands };
}

/** Applies commands in one editor transaction and returns the edited recipe document. */
export function patchRecipe(
  recipe: ITerrainDocument,
  commands: readonly PatchCommand[],
): ITerrainDocument {
  return Terrain.fromJSON(recipe).applyPatch(commands).toJSON() as ITerrainDocument;
}

/** Read the same TypeScript config the game builds, using its installed Vite loader. */
export async function resolveAssetSource(projectRoot: string): Promise<string> {
  const configFile = join(projectRoot, "threenative.config.ts");
  const exists = await lstat(configFile).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  let source: unknown = "assets";
  if (exists) {
    const { loadConfigFromFile } = await import("vite");
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      configFile,
      projectRoot,
    );
    const assets: unknown = (loaded?.config as Record<string, unknown> | undefined)?.assets;
    if (assets !== undefined) {
      if (!isRecord(assets)) throw new TypeError("terrain_generate: assets must be an object.");
      source = assets.source === undefined ? "assets" : assets.source;
    }
  }
  if (typeof source !== "string" || source.trim() === "") {
    throw new TypeError("terrain_generate: assets.source must be a non-empty path.");
  }
  const configuredRoot = resolve(projectRoot, source);
  const sourceRoot = await realpath(configuredRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return configuredRoot;
    throw error;
  });
  const inside = relative(projectRoot, sourceRoot);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new TypeError("terrain_generate: assets.source must be inside the project.");
  }
  return sourceRoot;
}
