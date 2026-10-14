import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  "const loadCells = (follow: TerrainAnchor) => { terrainFollow = follow; };",
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
      "      this.#sky === undefined ||\n      this.#terrainField === undefined ||\n      this.#loadCells === undefined\n",
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

  it("binds streaming and regional shadows after lighting and before material setup", () => {
    const patched = insertWorldLoad(readStarter(), PHYSICAL_LOAD);
    expect(patched).toContain("    this.#loadCells = loadCells;");
    expect(patched).toContain(
      '  #loadCells: ((follow: TerrainAnchor, invalidate?: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"]) => void) | undefined;',
    );
    expect(patched).toContain("      this.#loadCells === undefined");
    const bind = patched.indexOf("    this.#loadCells(player.mesh, (region) =>");
    expect(bind).toBeGreaterThan(patched.indexOf("new Player(ctx"));
    expect(bind).toBeGreaterThan(patched.indexOf("this.#disposeLighting = disposeLighting;"));
    expect(bind).toBeLessThan(patched.indexOf("    const materialEnvironment = {"));
    expect(patched).toContain('import { VirtualShadowNode } from "@threenative/core";');
    expect(patched).toContain("const { key, shadows, dispose: disposeLighting } = setupLighting(");
    expect(patched).toContain("Math.hypot(this.#terrainField.width, this.#terrainField.depth)");
    expect(patched).toContain(
      "[terrainShadowExtent / 16, terrainShadowExtent / 4, terrainShadowExtent].filter((extent) => extent > 14)",
    );
    expect(patched).toContain(
      "region === undefined ? shadows?.invalidateAll() : shadows?.invalidateRegion(region)",
    );
    expect(() => insertWorldLoad(readStarter(), PHYSICAL_LOAD.slice(0, -1))).toThrow(
      "TN_FOREST_LOAD_CELLS",
    );
  });

  it("executes the emitted measured windows and optional regional invalidation", () => {
    const patched = insertWorldLoad(readStarter(), PHYSICAL_LOAD);
    const span = patched.match(/const terrainShadowExtent = (.+);/u)?.[1];
    const windows = patched.match(
      /(\[terrainShadowExtent.+\]\.filter\(\(extent\) => extent > 14\))/u,
    )?.[1];
    const callback = patched.match(
      /this\.#loadCells\(player\.mesh, \(region\) =>\s*([^,]+),/u,
    )?.[1];
    expect(span && windows && callback).toBeTruthy();
    const measure = new Function(
      "field",
      `const terrainShadowExtent = ${span?.replaceAll("this.#terrainField", "field")}; return ${windows};`,
    );
    const diagonal = Math.hypot(512, 512);
    expect(measure({ width: 512, depth: 512 })).toEqual([diagonal / 16, diagonal / 4, diagonal]);
    expect(measure({ width: 3, depth: 4 })).toEqual([]);
    const invalidate = new Function("shadows", "region", `return ${callback};`);
    const shadows = { invalidateAll: vi.fn(), invalidateRegion: vi.fn() };
    const region = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 4 } };
    invalidate(shadows, region);
    invalidate(shadows, undefined);
    invalidate(undefined, region);
    expect(shadows.invalidateRegion).toHaveBeenCalledExactlyOnceWith(region);
    expect(shadows.invalidateAll).toHaveBeenCalledOnce();
    expect(patched).toContain("ctx.scene.add(key.target);");
  });

  it("spawns the player on the measured terrain height at the same finite x", () => {
    const patched = insertWorldLoad(readStarter(), PHYSICAL_LOAD);
    expect(patched).toContain(
      `        x: ${SPAWN_X},\n        y: this.#terrainField.heightAt(${SPAWN_X}, 0) + PLAYER_STAND_Y,\n`,
    );
  });
});
