import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { insertWorldLoad, worldLoadLines } from "../verify-forest-playtest.js";

const STARTER_PLAY = path.resolve(
  "packages/create-threenative/templates/starter/src/scenes/Play.ts",
);
const reply = (text: string, isError = false) =>
  JSON.stringify({ id: 2, jsonrpc: "2.0", result: { content: [{ text, type: "text" }], isError } });

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
    const patched = insertWorldLoad(readFileSync(STARTER_PLAY, "utf8"), ["ctx.scene.add(a);"]);
    expect(patched).toMatch(
      /override async load\(ctx: GameCtx\): Promise<void> \{\n {4}ctx\.scene\.add\(a\);\n/u,
    );
    expect(() => insertWorldLoad("class X {}", ["a;"])).toThrow("TN_FOREST_ANCHOR");
    expect(() => insertWorldLoad("x", [])).toThrow("TN_FOREST_LOAD_EMPTY");
  });
});
