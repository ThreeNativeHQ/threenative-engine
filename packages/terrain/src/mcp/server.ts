#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { IsolatedKillError, childExecArgv, runIsolated } from "./child.js";
import {
  TERRAIN_TOOLS,
  newBiomeSpec,
  parseBiomeNewInput,
  parseGenerateRequest,
  parsePatchInput,
  patchRecipe,
  resolveAssetSource,
  resolveOutput,
} from "./tools.js";

const SERVER_NAME = "threenative-terrain";
const SERVER_VERSION = "0.1.2";
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

/** Cooks one request in its own process group and returns the child's summary line. */
async function cookInChild(request: Record<string, unknown>, out: string): Promise<string> {
  const child = await runIsolated({
    command: process.execPath,
    // Inherits the parent's loader flags, so the same TypeScript runtime starts the child.
    args: [...childExecArgv(process.execArgv), COOK_CHILD, JSON.stringify(request)],
    timeoutMs: COOK_TIMEOUT_MS,
  }).catch(async (error: unknown) => {
    // A killed cook cannot clean up after itself; `resolveOutput` proved `out` was new, so it is ours.
    if (error instanceof IsolatedKillError) await rm(out, { recursive: true, force: true });
    throw error;
  });
  // The cook library also prints progress lines; the child's summary is always its last line.
  return child.stdout.trim().split("\n").at(-1) ?? "";
}

/** Stand-ins for the two output paths a cached reply names, swapped for the next call's own. */
const CACHED_OUT = "@@TN_TERRAIN_OUT@@";
const CACHED_URL = "@@TN_TERRAIN_URL@@";

/**
 * Cooks a request, or copies the world an identical request already cooked in this project. The key
 * is everything the cook reads but where it writes: the request, the server version, the cook
 * child's build and the starter's files, so a rebuilt package or an edited starter cooks again.
 * The cache lives in `node_modules/.cache/threenative-terrain`, which installs already ignore.
 * ponytail: no eviction; a project that cooks hundreds of distinct worlds can delete the folder.
 */
async function cookCached(
  request: Record<string, unknown> & { kit: string; projectRoot: string; assetSource: string },
  out: string,
): Promise<{ text: string; cache: "hit" | "miss" }> {
  const { out: _out, projectRoot, ...inputs } = request;
  const starter = new URL(`../../starter/${request.kit}/`, import.meta.url);
  const starterFiles = await readdir(starter).catch(() => [] as string[]);
  // A cooked reply carries the Arbor wind source and GLBs the installed bake package wrote.
  const arbor = new URL("../../starter/arbor/", import.meta.url);
  const arborFiles = await readdir(arbor).catch(() => [] as string[]);
  const bakePackage = (() => {
    try {
      return [
        createRequire(join(projectRoot, "package.json")).resolve(
          "@threenative/procedural-vegetation/package.json",
        ),
      ];
    } catch {
      return [];
    }
  })();
  const stamps = await Promise.all(
    [
      COOK_CHILD,
      ...starterFiles.map((f) => fileURLToPath(new URL(f, starter))),
      ...arborFiles.map((f) => fileURLToPath(new URL(f, arbor))),
      ...bakePackage,
    ].map(async (file) => `${file}:${(await stat(file)).mtimeMs}`),
  );
  const key = createHash("sha256")
    .update(JSON.stringify({ inputs, version: SERVER_VERSION, stamps }))
    .digest("hex")
    .slice(0, 32);
  const dir = join(projectRoot, "node_modules", ".cache", "threenative-terrain", key);
  const shown = relative(realpathSync(projectRoot), out).split(sep).join("/");
  const url = relative(request.assetSource, out).split(sep).join("/");
  const stored = await readFile(join(dir, "reply.json"), "utf8").catch(() => undefined);
  if (stored !== undefined) {
    await cp(join(dir, "world"), out, { recursive: true });
    return {
      text: stored.replaceAll(CACHED_OUT, shown).replaceAll(CACHED_URL, url),
      cache: "hit",
    };
  }
  const text = await cookInChild(request, out);
  // A cache that cannot be written costs the next call a cook, never this call its world.
  const staging = `${dir}.${String(process.pid)}`;
  try {
    await cp(out, join(staging, "world"), { recursive: true });
    await writeFile(
      join(staging, "reply.json"),
      text.replaceAll(shown, CACHED_OUT).replaceAll(url, CACHED_URL),
    );
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    console.error(`terrain: cook cache not written: ${(error as Error).message}`);
  }
  return { text, cache: "miss" };
}

/** Runs one tool. A rejected argument or a failed cook becomes a tool error result, not a crash. */
async function callTool(name: string, args: unknown): Promise<ReturnType<typeof toolResult>> {
  try {
    if (name === "terrain_generate") {
      const { input, decided, unused } = parseGenerateRequest(args);
      const projectRoot = process.cwd();
      const assetSource = await resolveAssetSource(projectRoot);
      const out = await resolveOutput(
        projectRoot,
        input.out ?? relative(projectRoot, join(assetSource, "worlds", input.kit)),
        assetSource,
      );
      const { text, cache } = await cookCached({ ...input, out, projectRoot, assetSource }, out);
      // A request that names only a starter is that starter as shipped, judged and measured: the
      // catalog. Any shape, water, feature, size, seed or ground of its own makes it a fresh cook.
      const { kit, out: _out, ...own } = input;
      const source = Object.keys(own).length === 0 ? `catalog:${kit}` : "cooked";
      // The reply names every choice with the word behind it, and the words nothing answered to, so
      // an agent retries with a word instead of guessing what the request dropped.
      return toolResult(
        JSON.stringify({ ...(JSON.parse(text) as object), source, cache, decided, unused }),
      );
    }
    if (name === "terrain_biome_new") {
      const input = parseBiomeNewInput(args);
      const projectRoot = process.cwd();
      const assetSource = await resolveAssetSource(projectRoot);
      // The base is the package's own file: a new biome starts from a validated spec, not a guess.
      const base = JSON.parse(
        await readFile(
          new URL(`../../starter/${input.from}/biome.data.json`, import.meta.url),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const spec = newBiomeSpec(base, input.name, input.overrides);
      // Both directories are claimed before anything is written, so a refused `out` leaves no
      // half-made biome behind. The default world sits inside the biome's own folder: one call then
      // writes only under `<assets.source>/biomes/<name>/`.
      const biomeDir = await resolveOutput(
        projectRoot,
        relative(projectRoot, join(assetSource, "biomes", input.name)),
        assetSource,
      );
      const out = await resolveOutput(
        projectRoot,
        input.out ?? relative(projectRoot, join(assetSource, "biomes", input.name, "world")),
        assetSource,
      );
      // The biome file is written first and read back in the result. A failed cook removes the folder
      // this call claimed, so the same name can be retried; an `out` outside it is already removed.
      await mkdir(biomeDir, { recursive: true });
      const biomeJson = join(biomeDir, "biome.data.json");
      await writeFile(biomeJson, `${JSON.stringify(spec, null, 2)}\n`);
      let text: string;
      try {
        text = await cookInChild(
          {
            assetSource,
            biome: input.name,
            kit: input.from,
            out,
            projectRoot,
            spec,
            ground: input.ground,
          },
          out,
        );
      } catch (error) {
        await rm(biomeDir, { recursive: true, force: true });
        throw error;
      }
      const shown = relative(projectRoot, biomeJson).split(sep).join("/");
      return toolResult(JSON.stringify({ ...(JSON.parse(text) as object), biomeJson: shown }));
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
