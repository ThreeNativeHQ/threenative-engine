import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeRAW16 } from "../src/core/io.js";
import type { ITerrainDocument } from "../src/core/types.js";
import { runIsolated } from "../src/mcp/child.js";
import {
  TERRAIN_TOOLS,
  assertOutputFree,
  parseGenerateInput,
  parsePatchInput,
  patchRecipe,
} from "../src/mcp/tools.js";

// The starter forest document as the forest bake evaluates it: `recipe.json` wraps it in `recipe`,
// and its raw16 heightmap is decoded into `values` first (bake.mjs, same 0.1 m lattice).
async function forestRecipe(): Promise<ITerrainDocument> {
  const dir = new URL("../starter/forest/", import.meta.url);
  const { recipe } = JSON.parse(await readFile(new URL("recipe.json", dir), "utf8"));
  for (const layer of recipe.layers) {
    const data = layer.params?.data;
    if (data?.raw16 === undefined) continue;
    const raw = await readFile(new URL(data.raw16, dir));
    data.values = Array.from(
      decodeRAW16(raw, data).values,
      (value: number) => Math.round(value * 10) / 10,
    );
  }
  return recipe;
}

describe("terrain MCP tool contract", () => {
  it("lists exactly terrain_generate and terrain_patch with closed input schemas", () => {
    expect(TERRAIN_TOOLS.map((tool) => tool.name)).toEqual(["terrain_generate", "terrain_patch"]);
    for (const tool of TERRAIN_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("terrain_generate input", () => {
  it("accepts the forest kit and leaves size, seed and out to the recipe", () => {
    expect(parseGenerateInput({ kit: "forest" })).toEqual({ kit: "forest" });
  });

  it("fails closed on kits that are not ready yet", () => {
    for (const kit of ["coastal", "alpine", "desert", "tundra"]) {
      expect(() => parseGenerateInput({ kit })).toThrow(/not supported yet/);
    }
  });

  it("rejects malformed fields before any evaluation starts", () => {
    const bad: unknown[] = [
      undefined,
      {},
      { kit: "castle" },
      { kit: "forest", sizeMeters: 0 },
      { kit: "forest", sizeMeters: "512" },
      { kit: "forest", seed: 1.5 },
      { kit: "forest", out: "" },
      { kit: "forest", out: "../escape" },
      { kit: "forest", out: "/tmp/absolute" },
      { kit: "forest", unknownField: true },
    ];
    for (const input of bad) {
      expect(() => parseGenerateInput(input)).toThrow();
    }
  });
});

describe("terrain_generate output guard", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tn-terrain-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("allows a new output directory", async () => {
    await expect(assertOutputFree(join(root, "forest"))).resolves.toBeUndefined();
  });

  it("refuses an existing output directory and leaves its files untouched", async () => {
    const out = join(root, "forest");
    await mkdir(out);
    await writeFile(join(out, "keep.txt"), "mine");
    await expect(assertOutputFree(out)).rejects.toThrow(/already exists/);
    expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("mine");
  });
});

describe("isolated generation child", () => {
  it("resolves with the child stdout on a clean exit", async () => {
    const result = await runIsolated({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("ok");
  });

  it("rejects a non-zero exit with the child stderr", async () => {
    await expect(
      runIsolated({
        command: process.execPath,
        args: ["-e", "process.stderr.write('bad input'); process.exit(3)"],
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited with code 3: bad input/);
  });

  it("kills a child that outlives its timeout", async () => {
    const started = Date.now();
    await expect(
      runIsolated({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out after 300 ms and was killed/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills a child when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = runIsolated({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/was cancelled and was killed/);
  });
});

describe("terrain_patch recipe edits", () => {
  it("applies the editor command vocabulary to the actual forest recipe", async () => {
    const recipe = await forestRecipe();
    const ids = recipe.layers.map((layer) => layer.id);
    const first = ids[0] as string;
    const last = ids.at(-1) as string;
    const edited = patchRecipe(recipe, [
      { op: "toggle", id: first, enabled: false },
      { op: "move", id: last, index: 0 },
      { op: "remove", id: ids[1] as string },
    ]);
    const layers = edited.layers;
    expect(layers.map((layer) => layer.id)).toEqual([last, first, ...ids.slice(2, -1)]);
    expect(layers.find((layer) => layer.id === first)?.enabled).toBe(false);
  });

  it("rejects an unknown operation before it reaches the recipe", async () => {
    const recipe = await forestRecipe();
    expect(() => parsePatchInput({ recipe, commands: [{ op: "paint-all" }] })).toThrow(
      /op must be one of/,
    );
  });

  it("rejects a command that names a layer the recipe does not have", async () => {
    const recipe = await forestRecipe();
    expect(() => patchRecipe(recipe, [{ op: "remove", id: "no-such-layer" }] as never)).toThrow();
  });
});
