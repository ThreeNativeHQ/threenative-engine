import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type IBiomeSpec, validateBiome } from "../biome/biome.js";
import { TERRAIN_KITS, type TerrainKit } from "../biome/kits.js";
import { OPERATION_TYPES } from "../core/operations.js";
import { Terrain } from "../core/terrain.js";
import type { LayerPatch, PatchCommand } from "../core/terrain.js";
import type { ITerrainDocument, Layer } from "../core/types.js";
import { LANDFORMS } from "../ground/presets.js";
import type { IGroundRequest } from "../ground/surveys.js";
import { ARBOR_TREE_IDS } from "../population/arbor-species.js";
import { closedRecord, isRecord, parseGround, relativeDirectory } from "../request/args.js";
import { ECOREGION_ROWS } from "../request/ecoregions.js";

export { TERRAIN_KITS, type TerrainKit } from "../biome/kits.js";
export {
  parseGenerateInput,
  parseGenerateRequest,
  type IChoice,
  type IGenerateDecided,
  type IGenerateInput,
  type IGenerateRequest,
  type IRequestSource,
} from "../request/generate-request.js";

const ARBOR_SPECIES_NOTE = `A species named \`arbor:<preset>[@seed]\` (for example arbor:oak@7) is a procedural Arbor tree the cook bakes and scatters; needs npm i -D @threenative/procedural-vegetation; set the row's far.impostor beyond 190 m, past the tree's last LOD. Presets: ${ARBOR_TREE_IDS.join(", ")}.`;

/** What naming a region decides, stated once for both tool texts. */
const ECOREGION_NOTE = `A region word (${ECOREGION_ROWS.map((row) => row.words[0]).join(", ")}) cooks that region's own world: the row's real survey as the ground, its plant community as the canopy (several species, each baked at more than one seed), and the starter's own surface, understorey and water, reported as \`decided.region\`.`;

const PATCH_OPS: readonly string[] = ["upsert", "update", "remove", "move", "toggle"];

/**
 * The `ground` argument, shared by both cook tools: the same three sources, the same closed shape.
 * A landform preset is grounded on its kind's survey unless this names another source.
 */
const GROUND_SCHEMA = {
  description:
    'Where the ground comes from. "procedural" keeps the landform preset\'s own noise; { heightmap } names a 16-bit grayscale PNG or a square .r16 file (min and max in metres, needed when the file carries no range); { location } cuts a survey at that latitude and longitude. Omitted, a landform preset is grounded on the real survey its kind names, and the result reports it as `ground` with its attribution.',
  anyOf: [
    { type: "string", enum: ["procedural"] },
    {
      type: "object",
      properties: {
        heightmap: {
          type: "string",
          description: "Path to a .png or .r16 height file, relative to the project.",
        },
        min: { type: "number", description: "Lowest elevation in the file, metres." },
        max: { type: "number", description: "Highest elevation in the file, metres." },
      },
      required: ["heightmap"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: { lat: { type: "number" }, lon: { type: "number" } },
          required: ["lat", "lon"],
          additionalProperties: false,
        },
      },
      required: ["location"],
      additionalProperties: false,
    },
  ],
} as const;

export const TERRAIN_TOOLS = [
  {
    name: "terrain_generate",
    description: `Choose from a request, an explicit kit or a biome and cook one editable starter terrain kit (forest, coastal, alpine, desert or tundra) into a world.glb; \`biome\` names a starter or one of its alias words, or carries an inline IBiomeSpec whose own landform, size and seed build the ground; \`landform\` swaps the ground for one of the seven shape presets (alpine, temperateMountains, rollingHills, desertMesa, coastalCliffs, tundra, volcanic) and keeps the kit's surface and assets; \`water\` replaces the water bodies the biome declares and changes the cooked world: an ocean row floods to its level, a river or lake row re-shapes the recipe's own river or lake in order (width or radius), a recipe layer with no row is removed, and a river or lake row with no layer to take it fails. A \`request\`'s words also decide the landform (mountains, hills, mesa, cliffs, volcano), the water (river, lake, island, ocean), the features carved into any ground (canyon, gorge, ravine: a steep cut across it; fjord, inlet: a sea inlet into the land) and the size (huge, small: the biome's own size scaled); an explicit \`landform\`, \`water\` or \`sizeMeters\` wins over a word. ${ECOREGION_NOTE} It keeps the starter's understorey, stones, road and water and replaces its canopy. A landform preset's ground is a real survey of the place its kind names, fetched from the Mapterhorn terrain tiles at the finest zoom its grid needs and the site has (the reply names the zoom and its metres per pixel), resampled onto the recipe's grid, cooked with the attribution its source requires, and reported as \`ground\`; the preset's erosion and grain still run on top of it. \`ground\` replaces that choice: \"procedural\" cooks the preset's own noise, { heightmap } reads a 16-bit grayscale PNG or a square .r16 grid, { location } cuts a survey at a latitude and longitude. An alpine or temperateMountains world on a survey also writes ring.json, its survey continued to ten times the world's size with one real whole mountain from that range past the square, reported as \`backdrop\`; \`backdrop: \"none\"\` cooks none. The result's \`decided\` names each choice with the word behind it or \`argument\`, and \`unused\` lists the request words that named nothing. A request that names only a starter (no shape, water, feature, size, seed or ground of its own) is that starter as shipped, judged and measured, reported as \`source: \"catalog:<kit>\"\`; anything else is \`\"cooked\"\`. The reply's \`seed\` is the seed the world was cooked with: pass another \`seed\` for a variation of the same request. A request repeated in the same project is copied from its cook cache (\`node_modules/.cache/threenative-terrain\`) and reported as \`cache: \"hit\"\`. Returns the kit as recipe, the biome it bakes, the water bodies the cooked world floods, measured from the evaluated state as \`water.json\` records them, its band rows resolved against the cooked heights (\`bands\`), the world.glb, recipe.json and world.json paths, triangles, instances and draws measured from the produced GLB's default scene, a ctx.assets.model load snippet, and \`grass\`: the lines that grow the biome's grass rows as a streamed, swaying GrassField3D on the cooked ground through grassFieldFromBiome (null when the biome has no grass row; the blade and material come from the game's src/render/grass.ts). triangles counts every instance of the LOD0 default scene in full, before distance LOD and culling, instances sums the EXT_mesh_gpu_instancing instances, and draws counts primitives across instanced and non-instanced meshes, an instanced primitive counting once.`,
    inputSchema: {
      type: "object",
      properties: {
        kit: { type: "string", enum: [...TERRAIN_KITS] },
        biome: {
          description: `A starter biome's name or alias word (forest, woods, beach, ...), or an inline IBiomeSpec object; a spec cooks with \`kit\`'s surface and assets, forest's when kit is absent. ${ARBOR_SPECIES_NOTE}`,
          anyOf: [{ type: "string", minLength: 1 }, { type: "object" }],
        },
        landform: { type: "string", enum: Object.keys(LANDFORMS) },
        request: {
          type: "string",
          minLength: 1,
          description: `What the world should be, in any words: a biome, a landform (mountains, hills, canyon, volcano, fjord, ...), water (river, lake, sea, ...) and a size (huge, small); an explicit argument wins over a word. A request with no biome word takes the biome its sea or shape suits, else the forest; \`decided\` names the word behind each choice and \`unused\` the words that named nothing. A tree word (oak, birch, aspen, cedar, maple, cypress, olive, acacia, baobab, palm, bamboo, cactus, ...) cooks that Arbor species in place of the kit's tree and is reported as \`decided.tree\`; a spec's own species rows win, and in a region request the word moves that species to the first canopy row and the community stays. ${ECOREGION_NOTE} \`kit\`, \`biome\` and \`ground\` still win over it. A real place's name is not geocoded: pass its latitude and longitude as \`ground: { location }\` to cook that place's survey.`,
        },
        sizeMeters: { type: "number", exclusiveMinimum: 0 },
        seed: { type: "integer" },
        water: {
          type: "array",
          items: { type: "object" },
          description:
            "IBiomeWaterBody rows that replace the biome's declared water: river (width), lake (radius), ocean (level).",
        },
        ground: GROUND_SCHEMA,
        backdrop: {
          type: "string",
          enum: ["none"],
          description:
            '"none" cooks no far ring. Omitted, an alpine or temperateMountains world on a survey gets ring.json: its survey continued to ten times the world\'s size, with one real whole mountain (a seeded pick, pose and height) standing past the playable square.',
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
      "Make a new biome from a shipped one and cook it: copies the base biome's biome.data.json into <assets.source>/biomes/<name>/, applies the overrides, validates the file with validateBiome, then cooks it with the base kit's surface and assets and the biome's own landform preset. One call writes only under <assets.source>/biomes/<name>/, its cooked world included. Its ground comes from the biome's landform, the real survey that kind names unless `ground` names another source. Returns the same cook result as terrain_generate plus the biome file path and the biome's resolved `bands`. No code changes anywhere: the biome is data.",
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
          description: `IBiomeSpec fields to change on the base file (landform, foliage, grass, layers, water, spawn, species, aliases, bake). An unknown field fails. ${ARBOR_SPECIES_NOTE}`,
        },
        ground: GROUND_SCHEMA,
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

const BIOME_NEW_FIELDS = ["from", "name", "overrides", "ground", "out"];

/** A new biome's folder name, and the look it will resolve under the game it is baked for. */
export interface IBiomeNewInput {
  from: TerrainKit;
  name: string;
  overrides?: Record<string, unknown>;
  /** The ground the cooked world starts from, as on `terrain_generate`. */
  ground?: IGroundRequest;
  out?: string;
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
  const ground = parseGround(args.ground, "terrain_biome_new");
  if (ground !== undefined) parsed.ground = ground;
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
