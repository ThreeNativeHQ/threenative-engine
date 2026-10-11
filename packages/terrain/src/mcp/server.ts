#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { IsolatedKillError, runIsolated } from "./child.js";
import {
  TERRAIN_TOOLS,
  parseGenerateInput,
  parsePatchInput,
  patchRecipe,
  resolveAssetSource,
  resolveOutput,
} from "./tools.js";

const SERVER_NAME = "threenative-terrain";
const SERVER_VERSION = "0.1.0";
// The cook must finish inside the 60 s cold budget (PRD-584 AC-2). The child is killed past it.
const COOK_TIMEOUT_MS = 60_000;
const COOK_CHILD = fileURLToPath(new URL("./cook-child.js", import.meta.url));

interface IRpcRequest {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function reply(id: IRpcRequest["id"], result: unknown): string {
  return JSON.stringify({ id, jsonrpc: "2.0", result });
}

function fail(id: IRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ id, jsonrpc: "2.0", error: { code, message } });
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/** Runs one tool. A rejected argument or a failed cook becomes a tool error result, not a crash. */
async function callTool(name: string, args: unknown): Promise<ReturnType<typeof toolResult>> {
  try {
    if (name === "terrain_generate") {
      const input = parseGenerateInput(args);
      const projectRoot = process.cwd();
      const assetSource = await resolveAssetSource(projectRoot);
      const out = await resolveOutput(
        projectRoot,
        input.out ?? relative(projectRoot, join(assetSource, "worlds", input.kit)),
      );
      const child = await runIsolated({
        command: process.execPath,
        // Inherits the parent's loader flags, so the same TypeScript runtime starts the child.
        args: [
          ...process.execArgv,
          COOK_CHILD,
          JSON.stringify({ ...input, out, projectRoot, assetSource }),
        ],
        timeoutMs: COOK_TIMEOUT_MS,
      }).catch(async (error: unknown) => {
        // A killed cook cannot clean up after itself; `resolveOutput` proved `out` was new, so it is ours.
        if (error instanceof IsolatedKillError) await rm(out, { recursive: true, force: true });
        throw error;
      });
      // The cook library also prints progress lines; the child's summary is always its last line.
      return toolResult(child.stdout.trim().split("\n").at(-1) ?? "");
    }
    if (name === "terrain_patch") {
      const { recipe, commands } = parsePatchInput(args);
      return toolResult(JSON.stringify(patchRecipe(recipe, commands)));
    }
    throw new TypeError(`Unknown tool '${name}'.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A child's uncaught error arrives with a stack; the `Error: ...` line is what the agent can act on.
    return toolResult(message.match(/^\w*Error: .*$/m)?.[0] ?? message, true);
  }
}

/** Answers one JSON-RPC line. Notifications (no id) return `undefined`. */
export async function handleLine(line: string): Promise<string | undefined> {
  let request: IRpcRequest;
  try {
    request = JSON.parse(line) as IRpcRequest;
  } catch {
    return fail(null, -32700, "Parse error.");
  }
  const { id, method, params } = request;
  if (method === undefined) return fail(id ?? null, -32600, "Invalid request: no method.");
  if (id === undefined) return undefined;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TERRAIN_TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (typeof name !== "string") return fail(id, -32602, "tools/call needs a tool name.");
    return reply(id, await callTool(name, params?.arguments ?? {}));
  }
  return fail(id, -32601, `Method not found: ${method}.`);
}

/** Serves stdio until stdin closes. Each request is answered as soon as it finishes. */
export function runServer(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    handleLine(line).then((response) => {
      if (response !== undefined) process.stdout.write(`${response}\n`);
    });
  });
}

// Started by the `bin`, or by the core shim, which sets argv[1] to this file before importing it.
const entry = process.argv[1];
if (
  entry !== undefined &&
  realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
) {
  runServer();
}
