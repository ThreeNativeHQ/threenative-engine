import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { insertWorldLoad, worldLoadLines } from "../verify-forest-playtest.js";

const STARTER_PLAY = path.resolve(
  "packages/create-threenative/templates/starter/src/scenes/Play.ts",
);
const reply = (text: string, isError = false) =>
  JSON.stringify({ id: 2, jsonrpc: "2.0", result: { content: [{ text, type: "text" }], isError } });
const readStarter = () => readFileSync(STARTER_PLAY, "utf8");
const SPAWN_X = "Number.isFinite(state.playerX) ? state.playerX : Play.initialState.playerX";
// The forest snippet's shape: its import, its world, and the terrain field `Play` must keep.
const PHYSICAL_LOAD = [
  'import { Heightfield as TerrainHeightfield } from "@threenative/core/world";',
  'const world = await ctx.assets.model("worlds/forest/world.glb");',
  "const terrainField = TerrainHeightfield.fromSampler({ columns: 257 });",
  "ctx.scene.add(world.scene);",
];

describe("forest playtest setup", () => {
  it("keeps the code lines of the tool's load snippet and drops its comment", () => {
    const load = [
      'const world = await ctx.assets.model("worlds/forest/world.glb");',
      "ctx.scene.add(world.scene);",
      "// recipe: x",
    ].join("\n");
    expect(worldLoadLines(reply(JSON.stringify({ load })))).toEqual([
      'const world = await ctx.assets.model("worlds/forest/world.glb");',
      "ctx.scene.add(world.scene);",
    ]);
  });

  it("fails closed on a tool error or a reply without a snippet", () => {
    expect(() => worldLoadLines(reply("boom", true))).toThrow("TN_FOREST_TOOL_FAILED");
    expect(() => worldLoadLines(reply("{}"))).toThrow("TN_FOREST_TOOL_REPLY");
  });

  it("adds the lines at the start of the real starter's Play.load, and only there", () => {
    const patched = insertWorldLoad(readStarter(), PHYSICAL_LOAD);
    expect(patched).toMatch(
      /override async load\(ctx: GameCtx\): Promise<void> \{\n {4}const world = await ctx\.assets\.model\(/u,
    );
    expect(patched.split("const world = await")).toHaveLength(2);
    expect(patched.startsWith(`${PHYSICAL_LOAD[0]}\n`)).toBe(true);
    expect(() => insertWorldLoad("class X {}", PHYSICAL_LOAD)).toThrow("TN_FOREST_ANCHOR");
    expect(() => insertWorldLoad("x", [])).toThrow("TN_FOREST_LOAD_EMPTY");
  });

  it("keeps the terrain field on Play, set during load, before enter reads it", () => {
    const patched = insertWorldLoad(readStarter(), PHYSICAL_LOAD);
    const declaredAt = patched.indexOf("const terrainField = ");
    const retainedAt = patched.indexOf("    this.#terrainField = terrainField;\n");
    expect(patched).toContain("  #terrainField: TerrainHeightfield | undefined;\n");
    expect(patched).toContain(
      "      this.#sky === undefined ||\n      this.#terrainField === undefined\n",
    );
    expect(declaredAt).toBeGreaterThan(patched.indexOf("override async load("));
    expect(retainedAt).toBeGreaterThan(declaredAt);
    expect(retainedAt).toBeLessThan(patched.indexOf("override enter("));
  });

  it("fails closed on a missing or duplicate anchor, or a snippet without terrainField", () => {
    const source = readStarter();
    const cls = "export class Play extends Scene<GameState, IPhysicsContext> {\n";
    const spawn = `        x: ${SPAWN_X},\n        y: PLAYER_STAND_Y,\n`;
    for (const broken of [
      source.replace(cls, ""),
      source.replace(cls, cls + cls),
      source.replace(spawn, ""),
      source.replace(spawn, spawn + spawn),
    ]) {
      expect(() => insertWorldLoad(broken, PHYSICAL_LOAD)).toThrow("TN_FOREST_ANCHOR");
    }
    expect(() => insertWorldLoad(source, ["ctx.scene.add(a);"])).toThrow("TN_FOREST_TERRAIN_FIELD");
  });

  it("spawns the player on the measured terrain height at the same finite x", () => {
    const patched = insertWorldLoad(readStarter(), PHYSICAL_LOAD);
    expect(patched).toContain(
      `        x: ${SPAWN_X},\n        y: this.#terrainField.heightAt(${SPAWN_X}, 0) + PLAYER_STAND_Y,\n`,
    );
  });
});
