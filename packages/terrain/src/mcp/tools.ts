import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Terrain } from "../core/terrain.js";
import type { PatchCommand } from "../core/terrain.js";
import type { ITerrainDocument } from "../core/types.js";

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
      "Cook one editable starter terrain kit (forest, coastal, alpine, desert or tundra) into a world.glb.",
    inputSchema: {
      type: "object",
      properties: {
        kit: { type: "string", enum: [...TERRAIN_KITS] },
        sizeMeters: { type: "number", exclusiveMinimum: 0 },
        seed: { type: "integer" },
        out: { type: "string", description: "Relative directory that must not exist yet." },
      },
      required: ["kit"],
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

const GENERATE_FIELDS = ["kit", "sizeMeters", "seed", "out"];

export function parseGenerateInput(input: unknown): IGenerateInput {
  const args = closedRecord(input, "terrain_generate", GENERATE_FIELDS);
  const { kit, sizeMeters, seed, out } = args;
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
 */
export async function resolveOutput(root: string, out: string): Promise<string> {
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

function parseCommand(command: unknown, index: number): PatchCommand {
  if (!isRecord(command) || !PATCH_OPS.includes(command.op as string)) {
    throw new TypeError(
      `terrain_patch: command ${index} op must be one of ${PATCH_OPS.join(", ")}.`,
    );
  }
  if (command.op !== "upsert" && typeof command.id !== "string") {
    throw new TypeError(`terrain_patch: command ${index} needs a layer id.`);
  }
  if (command.op === "upsert" && !isRecord(command.layer)) {
    throw new TypeError(`terrain_patch: command ${index} needs a layer object.`);
  }
  if (command.op === "update" && !isRecord(command.patch)) {
    throw new TypeError(`terrain_patch: command ${index} needs a patch object.`);
  }
  if (command.op === "move" && !Number.isInteger(command.index)) {
    throw new TypeError(`terrain_patch: command ${index} needs an integer index.`);
  }
  if (
    command.op === "toggle" &&
    command.enabled !== undefined &&
    typeof command.enabled !== "boolean"
  ) {
    throw new TypeError(`terrain_patch: command ${index} enabled must be a boolean.`);
  }
  return command as unknown as PatchCommand;
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
  return {
    recipe: args.recipe as unknown as ITerrainDocument,
    commands: args.commands.map(parseCommand),
  };
}

/** Applies commands in one editor transaction and returns the edited recipe document. */
export function patchRecipe(
  recipe: ITerrainDocument,
  commands: readonly PatchCommand[],
): ITerrainDocument {
  return Terrain.fromJSON(recipe).applyPatch(commands).toJSON() as ITerrainDocument;
}
