import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, templateRoot } from "../packages/create-threenative/src/index.js";
import { packageLocalFramework } from "./visual-gate.js";

/**
 * PRD-584 AC-4/AC-5: the stock starter, a forest produced by the real `terrain_generate` tool, the
 * ordinary load the tool prints, a live-clock walk, and the playtest's own p95 frame-time bound.
 *
 * Usage: tsx scripts/verify-forest-playtest.ts [--target web|desktop]
 * Run on a real GPU under `sh scripts/xvfb.sh`; see packages/playtest/AGENTS.md for the recipe.
 */

const LOAD_ANCHOR = "  override async load(ctx: GameCtx): Promise<void> {\n";
const CLASS_ANCHOR = "export class Play extends Scene<GameState, IPhysicsContext> {\n";
const SPAWN_X = "Number.isFinite(state.playerX) ? state.playerX : Play.initialState.playerX";
const SPAWN_ANCHOR = `        x: ${SPAWN_X},\n        y: PLAYER_STAND_Y,\n`;
const LIGHTING_ANCHOR = `    const { key, dispose: disposeLighting } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
`;
const MATERIAL_ANCHOR = "    const materialEnvironment = {\n";
const READY_ANCHOR = "      this.#sky === undefined\n";
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

function anchorOnce(source: string, anchor: string, name: string): void {
  if (source.split(anchor).length !== 2)
    throw new Error(`TN_FOREST_ANCHOR: ${name} not found exactly once in the starter.`);
}

/** Load the printed world and place the proof game's player on its measured terrain surface. */
export function insertWorldLoad(source: string, lines: readonly string[]): string {
  if (lines.length === 0) throw new Error("TN_FOREST_LOAD_EMPTY: the tool printed no load lines.");
  anchorOnce(source, LOAD_ANCHOR, "Play.load");
  anchorOnce(source, CLASS_ANCHOR, "the Play class");
  anchorOnce(source, SPAWN_ANCHOR, "the Player spawn");
  anchorOnce(source, READY_ANCHOR, "the Play readiness check");
  anchorOnce(source, LIGHTING_ANCHOR, "the shadow lighting call");
  anchorOnce(source, MATERIAL_ANCHOR, "the streamed shadow binding");
  const imports = lines.filter((line) => line.startsWith("import "));
  const body = lines.filter((line) => !line.startsWith("import "));
  if (!body.some((line) => line.startsWith("const terrainField = ")))
    throw new Error("TN_FOREST_TERRAIN_FIELD: the load snippet does not declare terrainField.");
  if (!body.some((line) => line.startsWith("const loadCells = ")))
    throw new Error("TN_FOREST_LOAD_CELLS: the load snippet does not declare loadCells.");
  const retain = "    this.#terrainField = terrainField;\n    this.#loadCells = loadCells;\n";
  const loaded = source
    .replace(LOAD_ANCHOR, `${LOAD_ANCHOR}${body.map((line) => `    ${line}\n`).join("")}${retain}`)
    .replace(
      CLASS_ANCHOR,
      `${CLASS_ANCHOR}  #terrainField: TerrainHeightfield | undefined;\n  #loadCells: ((follow: TerrainAnchor, invalidate?: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"]) => void) | undefined;\n`,
    )
    .replace(
      LIGHTING_ANCHOR,
      `    const terrainShadowExtent = Math.hypot(this.#terrainField.width, this.#terrainField.depth);
    const { key, shadows, dispose: disposeLighting } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
      [terrainShadowExtent / 16, terrainShadowExtent / 4, terrainShadowExtent].filter((extent) => extent > 14),
      VirtualShadowNode,
    );
`,
    )
    .replace(
      MATERIAL_ANCHOR,
      `    ctx.scene.add(key.target);
    this.#loadCells(player.mesh, (region) =>
      region === undefined ? shadows?.invalidateAll() : shadows?.invalidateRegion(region),
    );
${MATERIAL_ANCHOR}`,
    )
    .replace(
      READY_ANCHOR,
      "      this.#sky === undefined ||\n      this.#terrainField === undefined ||\n      this.#loadCells === undefined\n",
    )
    .replace(
      SPAWN_ANCHOR,
      `        x: ${SPAWN_X},\n        y: this.#terrainField.heightAt(${SPAWN_X}, 0) + PLAYER_STAND_Y,\n`,
    );
  return `${imports.map((line) => `${line}\n`).join("")}import { VirtualShadowNode } from "@threenative/core";\n${loaded}`;
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
          "--live-clock",
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
          "--live-clock",
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
