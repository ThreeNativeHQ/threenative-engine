import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeRAW16 } from "../src/core/io.js";
import type { ITerrainDocument } from "../src/core/types.js";
import { IsolatedKillError, runIsolated } from "../src/mcp/child.js";
import { loadCooker, parseBounds } from "../src/mcp/cook.js";
import {
  TERRAIN_KITS,
  TERRAIN_TOOLS,
  assertOutputFree,
  parseGenerateInput,
  parsePatchInput,
  patchRecipe,
  resolveOutput,
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

  it("accepts all five starter kits", () => {
    expect([...TERRAIN_KITS].sort()).toEqual(["alpine", "coastal", "desert", "forest", "tundra"]);
    for (const kit of TERRAIN_KITS) {
      expect(parseGenerateInput({ kit })).toEqual({ kit });
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

describe("terrain_generate output containment", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "tn-terrain-root-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "tn-terrain-outside-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("returns the real path of a new directory under the root", async () => {
    expect(await resolveOutput(root, "public/worlds/forest")).toBe(
      join(root, "public", "worlds", "forest"),
    );
  });

  it("rejects an output that is itself a symlink leaving the root", async () => {
    await symlink(outside, join(root, "link"));
    await expect(resolveOutput(root, "link")).rejects.toThrow();
  });

  it("rejects an output under an ancestor symlink leaving the root", async () => {
    await symlink(outside, join(root, "public"));
    await expect(resolveOutput(root, "public/worlds/forest")).rejects.toThrow(
      /outside the project/,
    );
  });

  it("rejects an output under a dangling symlink", async () => {
    await symlink(join(outside, "missing"), join(root, "public"));
    await expect(resolveOutput(root, "public/forest")).rejects.toThrow(/dangling symlink/);
  });

  it("allows a symlinked ancestor that stays inside the root", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    expect(await resolveOutput(root, "alias/forest")).toBe(join(root, "real", "forest"));
  });
});

describe("species bounds", () => {
  it("narrows a well-formed box", () => {
    expect(parseBounds({ min: [-1, 0, -1], max: [1, 2, 1] }, "fir")).toEqual({
      min: [-1, 0, -1],
      max: [1, 2, 1],
    });
  });

  it("fails closed on a missing, malformed or inverted box", () => {
    const bad: unknown[] = [
      undefined,
      null,
      {},
      { min: [0, 0, 0] },
      { min: [0, 0], max: [1, 1, 1] },
      { min: [0, 0, 0], max: [1, "1", 1] },
      { min: [0, 0, 0], max: [1, Number.NaN, 1] },
      { min: [2, 0, 0], max: [1, 1, 1] },
    ];
    for (const value of bad) {
      expect(() => parseBounds(value, "fir")).toThrow(/species 'fir' bounds/);
    }
  });
});

describe("cooker resolution", () => {
  it("names the install command when the game project has no @threenative/assets", async () => {
    const project = await mkdtemp(join(tmpdir(), "tn-terrain-noassets-"));
    try {
      await expect(loadCooker(project)).rejects.toThrow(/npm i -D @threenative\/assets/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("isolated generation child", () => {
  it("never spawns when the signal is already aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-terrain-preabort-"));
    const marker = join(dir, "spawned");
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        runIsolated({
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
          timeoutMs: 10_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow(IsolatedKillError);
      await new Promise((done) => setTimeout(done, 300));
      await expect(readFile(marker)).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills the whole process group on timeout, grandchildren included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-terrain-group-"));
    const pidFile = join(dir, "grandchild.pid");
    const script = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      setTimeout(() => {}, 60000);
    `;
    try {
      await expect(
        runIsolated({ command: process.execPath, args: ["-e", script], timeoutMs: 1_000 }),
      ).rejects.toThrow(/timed out/);
      const pid = Number(await readFile(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let wait = 0; wait < 50 && alive(); wait += 1) {
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(alive()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
