import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BLENDER_SOURCE_EXTENSIONS,
  convertModel,
  inspectModel,
  runBlenderScript,
} from "./bridge.js";
import { type IBlenderStatus, installCommandFor, resolveBlender } from "./detect.js";
import { RECIPES, findRecipe, recipePath, recipeSource, runRecipe } from "./recipes.js";

/**
 * `threenative-blender-mcp` — a stdio MCP server that drives an installed Blender headlessly.
 *
 * It contains no Blender and installs none. Every tool routes a machine without Blender through
 * one structured result naming the platform's install command, because a host that shows a dead
 * server reads to a user as "the framework cannot do this", which is the opposite of true.
 *
 * The JSON-RPC framing is hand-written, matching `packages/engine-mcp`. Correction to PRD-346's
 * key-decision line: that package does not use `@modelcontextprotocol/sdk` either, and following
 * it exactly leaves this package with no runtime dependencies at all — which is what lets
 * `@threenative/assets` import the conversion bridge without inheriting an MCP transport.
 */

const SERVER_NAME = "threenative-blender-mcp";
const SERVER_VERSION = "0.1.7";

const AUTHORING_INSTRUCTIONS =
  "Call blender_status before anything else: it answers whether this machine can convert models at all, and when it cannot it names the install command rather than failing. Blender is never installed for the user — ask first, then let them run the command. An .fbx, .blend, .obj or .dae placed in a game's assets directory is converted by the build itself; these tools are for inspecting a source before committing it and for operations the build does not perform. For anything no named tool covers, read a shipped recipe with blender_recipes and adapt it, then run it with blender_run_python.";

interface IBlenderTool {
  readonly annotations: {
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
    readonly readOnlyHint: boolean;
  };
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly name: string;
}

export const TOOL_DEFINITIONS: readonly IBlenderTool[] = [
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "blender_status",
    description:
      "Report whether this machine has a supported Blender, where it is and what version. Never fails: when Blender is absent it returns available:false with the install command for each platform.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "blender_inspect",
    description: `Report what a model file contains without writing anything: mesh, triangle, vertex and bone counts, material names, animation clip names and image names. Accepts ${BLENDER_SOURCE_EXTENSIONS.join(", ")}, .gltf and .glb.`,
    inputSchema: {
      additionalProperties: false,
      properties: {
        source: { description: "Path to the model file to inspect.", type: "string" },
      },
      required: ["source"],
      type: "object",
    },
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
    name: "blender_convert",
    description:
      "Convert a model file to a GLB a ThreeNative game can load, preserving skeletons, animation clips, materials and textures. A conversion that produces no meshes fails rather than writing an empty GLB. Note that a game's build converts these files itself: use this to check a source before committing it, or to write a GLB somewhere else.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        out: { description: "Path of the .glb to write.", type: "string" },
        source: { description: "Path to the model file to convert.", type: "string" },
      },
      required: ["source", "out"],
      type: "object",
    },
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
    name: "blender_recipes",
    description:
      "List the shipped bpy recipes, read one's full source text, or run one. Read before you write: a working recipe adapted into your game beats bpy written cold. Omit 'name' to list; pass 'name' alone to read; pass 'name' with 'arguments' to run.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        arguments: {
          description: "Recipe arguments. Present means run it; absent means return its source.",
          type: "object",
        },
        name: { description: "Recipe name. Omit to list every recipe.", type: "string" },
      },
      type: "object",
    },
  },
  {
    annotations: { destructiveHint: true, openWorldHint: false, readOnlyHint: false },
    name: "blender_export_world",
    description:
      "Export a Blender-authored world as a ThreeNative world package v1: world.json, a raw uint16 heightmap, one GLB plus a decimated LOD1 per referenced scatter asset, per-cell chunk GLBs and placements.bin. Reads render-density instances so viewport share tricks never leak in; marks the terrain with tn_world_terrain, scatter sources with tn_asset_id and chunk collections with tn_world_chunk.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        cell: { description: "Cell edge length in metres.", type: "number" },
        out: { description: "Directory to write the package into.", type: "string" },
        source: { description: "Path to the .blend world to read.", type: "string" },
        spacing: {
          description: "Heightmap sample spacing in metres. Default 2.",
          type: "number",
        },
      },
      required: ["source", "out", "cell"],
      type: "object",
    },
  },
  {
    annotations: { destructiveHint: true, openWorldHint: false, readOnlyHint: false },
    name: "blender_run_python",
    description:
      "Run a bpy script of your own inside Blender, with a timeout, returning its result line, stderr and exit code. This is NOT a sandbox and does not claim to be: the script runs with your own privileges, exactly as it would if you invoked Blender through Bash yourself. What it adds is a resolved Blender, the same fail-closed handling every other tool here uses, and discoverability — not privilege. Read blender_recipes first; the shipped recipes are the worked examples.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        arguments: {
          description: "The JSON request handed to the script after '--'.",
          type: "object",
        },
        script: { description: "Path to the .py file to run inside Blender.", type: "string" },
        timeoutMs: { description: "Kill the run after this many milliseconds.", type: "number" },
      },
      required: ["script"],
      type: "object",
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ id, jsonrpc: "2.0", error: { code, message } });
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ id, jsonrpc: "2.0", result });
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function toolText(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ text: JSON.stringify(value, null, 2), type: "text" }] };
}

/** What `blender_status` answers, and the shape every other tool's missing-Blender path reuses. */
export function blenderStatusResult(
  status: IBlenderStatus = resolveBlender(),
): Record<string, unknown> {
  return {
    available: status.available,
    ...(status.cause === undefined ? {} : { cause: status.cause }),
    detail: status.detail,
    install: status.install,
    installCommand: installCommandFor(),
    minimumVersion: status.minimumVersion,
    ...(status.path === undefined ? {} : { path: status.path }),
    ...(status.version === undefined ? {} : { version: status.version }),
  };
}

function requiredString(
  argumentsValue: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const value = argumentsValue[key];
  // The raw value goes to the check, never through String(): a numeric or null argument must come
  // back as a tool error the agent can read, not a conversion of the file "undefined".
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${tool} requires a non-empty string '${key}' argument.`);
  }
  return value;
}

/** List, read or run. Reading returns the recipe's own text: an agent adapts what it can see. */
async function handleRecipes(argumentsValue: Record<string, unknown>): Promise<unknown> {
  if (argumentsValue.name === undefined) {
    return {
      recipes: RECIPES.map((recipe) => ({
        description: recipe.description,
        name: recipe.name,
        parameters: recipe.parameters,
        script: recipePath(recipe),
      })),
    };
  }
  const recipe = findRecipe(argumentsValue.name);
  if (argumentsValue.arguments === undefined) {
    return {
      description: recipe.description,
      name: recipe.name,
      parameters: recipe.parameters,
      script: recipePath(recipe),
      source: recipeSource(recipe),
    };
  }
  if (!isRecord(argumentsValue.arguments)) {
    throw new Error("blender_recipes 'arguments' must be an object.");
  }
  return runRecipe(recipe.name, argumentsValue.arguments);
}

export async function handleToolCall(
  params: Record<string, unknown>,
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const name = params.name;
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  if (name === "blender_status") return toolText(blenderStatusResult());
  if (name === "blender_inspect") {
    const source = requiredString(argumentsValue, "source", "blender_inspect");
    return toolText(await inspectModel(source));
  }
  if (name === "blender_convert") {
    const source = requiredString(argumentsValue, "source", "blender_convert");
    const out = requiredString(argumentsValue, "out", "blender_convert");
    return toolText(await convertModel(source, out));
  }
  if (name === "blender_recipes") return toolText(await handleRecipes(argumentsValue));
  if (name === "blender_export_world") {
    const source = requiredString(argumentsValue, "source", "blender_export_world");
    const out = requiredString(argumentsValue, "out", "blender_export_world");
    const cell = argumentsValue.cell;
    if (typeof cell !== "number" || !Number.isFinite(cell) || cell <= 0) {
      throw new Error("blender_export_world 'cell' must be a number greater than zero.");
    }
    const spacing = argumentsValue.spacing;
    if (
      spacing !== undefined &&
      (typeof spacing !== "number" || !Number.isFinite(spacing) || spacing <= 0)
    ) {
      throw new Error("blender_export_world 'spacing' must be a number greater than zero.");
    }
    return toolText(
      await runRecipe("export_world", {
        cell,
        out,
        source,
        ...(spacing === undefined ? {} : { spacing }),
      }),
    );
  }
  if (name === "blender_run_python") {
    const script = requiredString(argumentsValue, "script", "blender_run_python");
    const request = argumentsValue.arguments === undefined ? {} : argumentsValue.arguments;
    if (!isRecord(request)) throw new Error("blender_run_python 'arguments' must be an object.");
    const timeoutMs = argumentsValue.timeoutMs;
    // Node rejects a fractional, negative, or non-finite timeout, and reads zero as no timeout.
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new Error(
        "blender_run_python 'timeoutMs' must be a positive whole number of milliseconds.",
      );
    }
    return toolText(
      await runBlenderScript(script, request, timeoutMs === undefined ? {} : { timeoutMs }),
    );
  }
  throw new Error(`Unknown blender MCP tool '${String(name)}'.`);
}

/**
 * One raw stdin line to the JSON-RPC response to write, or `undefined` when the line is consumed
 * silently. Extracted so the stdio contract is testable without a live `process.stdin`.
 */
export async function handleLine(line: string): Promise<string | undefined> {
  if (line.trim().length === 0) return undefined;
  let request: unknown;
  try {
    request = JSON.parse(line) as unknown;
  } catch (error) {
    return jsonRpcError(null, -32700, `Invalid JSON: ${String(error)}`);
  }
  if (!isRecord(request) || request.id === undefined || typeof request.method !== "string")
    return undefined;
  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        capabilities: { tools: { listChanged: false } },
        instructions: AUTHORING_INSTRUCTIONS,
        protocolVersion: "2025-06-18",
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: TOOL_DEFINITIONS });
    }
    if (request.method === "tools/call") {
      if (!isRecord(request.params)) throw new Error("tools/call requires an object params value.");
      return jsonRpcResult(request.id, await handleToolCall(request.params));
    }
    return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return jsonRpcError(request.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Starts the server. Detection is deliberately not run here: a fourth server that probed the
 * filesystem at startup would slow every host launch for a project that never converts a model.
 */
export function runServer(): void {
  const input = createInterface({ input: process.stdin });
  // Serialised: a conversion takes seconds, and two Blender processes racing on one stdio channel
  // would interleave their replies. The client's requests are answered in the order they arrived.
  let queue: Promise<void> = Promise.resolve();
  input.on("line", (line) => {
    queue = queue.then(async () => {
      const response = await handleLine(line);
      if (response !== undefined) writeLine(response);
    });
  });
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  realpathSync(path.resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  runServer();
}
