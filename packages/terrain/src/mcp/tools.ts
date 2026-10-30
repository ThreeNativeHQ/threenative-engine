import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { OPERATION_TYPES } from "../core/operations.js";
import { Terrain } from "../core/terrain.js";
import type { LayerPatch, PatchCommand } from "../core/terrain.js";
import type { ITerrainDocument, Layer } from "../core/types.js";

/** The starter kits, one folder each under the package's `starter/`. */
export const TERRAIN_KITS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;

export type TerrainKit = (typeof TERRAIN_KITS)[number];

export interface IGenerateInput {
  kit: TerrainKit;
  sizeMeters?: number;
  seed?: number;
  out?: string;
}

const PATCH_OPS: readonly string[] = ["upsert", "update", "remove", "move", "toggle"];

export const TERRAIN_TOOLS = [
  {
    name: "terrain_generate",
    description:
      "Choose from a request or explicit kit and cook one editable starter terrain kit (forest, coastal, alpine, desert or tundra) into a world.glb. Returns the kit as recipe, the world.glb, recipe.json and world.json paths, triangles, instances and draws measured from the produced GLB's default scene, and a ctx.assets.model load snippet. triangles counts every instance of the LOD0 default scene in full, before distance LOD and culling, instances sums the EXT_mesh_gpu_instancing instances, and draws counts primitives across instanced and non-instanced meshes, an instanced primitive counting once.",
    inputSchema: {
      type: "object",
      properties: {
        kit: { type: "string", enum: [...TERRAIN_KITS] },
        request: { type: "string", minLength: 1 },
        sizeMeters: { type: "number", exclusiveMinimum: 0 },
        seed: { type: "integer" },
        out: {
          type: "string",
          description:
            "Relative directory under the project's assets.source that must not exist yet; the default is assets.source/worlds/<kit>.",
        },
      },
      anyOf: [{ required: ["request"] }, { required: ["kit"] }],
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

const GENERATE_FIELDS = ["request", "kit", "sizeMeters", "seed", "out"];

export function parseGenerateInput(input: unknown): IGenerateInput {
  const args = closedRecord(input, "terrain_generate", GENERATE_FIELDS);
  const { request, sizeMeters, seed, out } = args;
  if (request !== undefined && (typeof request !== "string" || request.trim() === "")) {
    throw new TypeError("terrain_generate: request must be a non-empty string.");
  }
  const words = typeof request === "string" ? request.toLowerCase().split(/[^a-z]+/u) : [];
  const synonyms = [
    ["forest", "pine", "pines", "woods", "woodland"],
    ["coastal", "beach", "coast", "sea", "ocean"],
    ["alpine", "mountain", "mountains", "snowy", "peaks"],
    ["desert", "dune", "dunes", "sand"],
    ["tundra", "arctic", "ice"],
  ];
  const kit =
    args.kit !== undefined
      ? args.kit
      : TERRAIN_KITS[synonyms.findIndex((names) => names.some((name) => words.includes(name)))];
  if (typeof kit !== "string" || !(TERRAIN_KITS as readonly string[]).includes(kit)) {
    throw new TypeError(`terrain_generate: kit must be one of ${TERRAIN_KITS.join(", ")}.`);
  }
  const parsed: IGenerateInput = { kit: kit as TerrainKit };
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
  if (out !== undefined) parsed.out = relativeDirectory(out);
  return parsed;
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
