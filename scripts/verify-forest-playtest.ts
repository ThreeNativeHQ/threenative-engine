import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, templateRoot } from "../packages/create-threenative/src/index.js";
import { packageLocalFramework } from "./visual-gate.js";

/**
 * PRD-584 AC-4/AC-5: the stock starter, a forest produced by the real `terrain_generate` tool, the
 * ordinary load the tool prints, a 300-tick walk, and the playtest's own p95 frame-time bound.
 *
 * Usage: tsx scripts/verify-forest-playtest.ts [--target web|desktop]
 * Run on a real GPU under `sh scripts/xvfb.sh`; see packages/playtest/AGENTS.md for the recipe.
 */

const LOAD_ANCHOR = "  override async load(ctx: GameCtx): Promise<void> {\n";
const SCENARIO_ROOT = path.resolve(templateRoot(), "..", "template-playtests", "starter-forest");

/** The tool's reply is JSON in the first text block; `load` is the snippet an agent pastes. */
export function worldLoadLines(reply: string): readonly string[] {
  const result = (JSON.parse(reply) as { result?: IToolResult }).result;
  const text = result?.content?.[0]?.text;
  if (text === undefined)
    throw new Error("TN_FOREST_TOOL_REPLY: terrain_generate returned no text.");
  if (result?.isError === true) throw new Error(`TN_FOREST_TOOL_FAILED: ${text}`);
  const load = (JSON.parse(text) as { load?: unknown }).load;
  if (typeof load !== "string")
    throw new Error("TN_FOREST_TOOL_REPLY: the result carries no load snippet.");
  return load.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
}

interface IToolResult {
  readonly content?: readonly { readonly text?: string }[];
  readonly isError?: boolean;
}

/** Adds the printed load to the start of the starter's `Play.load`; a moved anchor fails closed. */
export function insertWorldLoad(source: string, lines: readonly string[]): string {
  if (lines.length === 0) throw new Error("TN_FOREST_LOAD_EMPTY: the tool printed no load lines.");
  if (source.split(LOAD_ANCHOR).length !== 2)
    throw new Error("TN_FOREST_ANCHOR: Play.load not found exactly once in the starter.");
  return source.replace(
    LOAD_ANCHOR,
    `${LOAD_ANCHOR}${lines.map((line) => `    ${line}\n`).join("")}`,
  );
}

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}.`)),
    );
  });
}

/** One `tools/call` over the same stdio shim an agent's `.mcp.json` launches. */
function callTerrainGenerate(project: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["node_modules/@threenative/core/mcp/terrain.mjs"], {
      cwd: project,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += String(chunk);
      for (const line of buffer.split("\n")) {
        if (line.includes('"id":2')) {
          child.kill();
          resolve(line);
        }
      }
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("TN_FOREST_TOOL_EXIT: the terrain server exited before replying.")),
    );
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "terrain_generate", arguments: { kit: "forest" } },
    });
  });
}

async function main(): Promise<void> {
  const target = process.argv.includes("--target")
    ? process.argv[process.argv.indexOf("--target") + 1]
    : "web";
  if (target !== "web" && target !== "desktop") throw new Error("--target must be web or desktop.");
  const root = await mkdtemp(path.join(os.tmpdir(), "threenative-forest-playtest-"));
  try {
    const packageSources = await packageLocalFramework(root);
    const project = path.join(root, "forest");
    await createProject({ install: true, packageSources, target: project, template: "starter" });
    const lines = worldLoadLines(await callTerrainGenerate(project));
    const play = path.join(project, "src/scenes/Play.ts");
    await writeFile(play, insertWorldLoad(await readFile(play, "utf8"), lines));
    const files = await readdir(SCENARIO_ROOT);
    if (!files.includes("forest.playtest.json")) throw new Error("TN_FOREST_SCENARIO_MISSING");
    if (target === "web") {
      await cp(
        path.join(SCENARIO_ROOT, "forest.playtest.json"),
        path.join(project, "playtests/forest.playtest.json"),
      );
      await run("pnpm", ["build:web"], project);
      await run(
        "pnpm",
        [
          "exec",
          "threenative-playtest",
          "--scenario",
          "playtests/forest.playtest.json",
          "--browser-recipe",
          "webgpu",
          "--headed",
          "--no-screenshots",
          "--server-timeout",
          "120000",
          "--server-command",
          "pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort",
        ],
        project,
      );
    } else {
      await cp(
        path.join(SCENARIO_ROOT, "forest.native.playtest.json"),
        path.join(project, "native-playtests/forest.playtest.json"),
      );
      await run("pnpm", ["build:desktop"], project);
      await run(
        "pnpm",
        [
          "exec",
          "threenative-playtest",
          "--scenario",
          "native-playtests/forest.playtest.json",
          "--target",
          "desktop",
          "--executable",
          "dist-native/forest",
        ],
        project,
      );
    }
  } finally {
    if (process.env.TN_FOREST_KEEP === "1") console.info(`TN_FOREST_KEEP root: ${root}`);
    else await rm(root, { force: true, recursive: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
