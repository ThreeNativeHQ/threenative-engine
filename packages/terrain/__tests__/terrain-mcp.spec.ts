import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import {
  Heightfield,
  heightSamplerFromHeightmap,
  loadWorldHeightmap,
} from "@threenative/core/world";
import { Object3D, Scene } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { decodeRAW16 } from "../src/core/io.js";
import type { ITerrainDocument } from "../src/core/types.js";
import { IsolatedKillError, runIsolated } from "../src/mcp/child.js";
import { cookKit, loadCooker, parseBounds } from "../src/mcp/cook.js";
import { measureGlb } from "../src/mcp/glb-stats.js";
import {
  TERRAIN_KITS,
  TERRAIN_TOOLS,
  assertOutputFree,
  parseGenerateInput,
  parsePatchInput,
  patchRecipe,
  resolveAssetSource,
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
  it.each([
    ["forest", "pine forest woods"],
    ["coastal", "beach coast sea"],
    ["alpine", "mountain alpine snowy peaks"],
    ["desert", "dunes desert sand"],
    ["tundra", "tundra arctic ice"],
  ])("selects %s from its name and synonyms", (kit, words) => {
    for (const request of words.split(" ")) {
      expect(parseGenerateInput({ request: `Generate ${request.toUpperCase()} for me` })).toEqual({
        kit,
      });
    }
  });

  it("keeps kit as an explicit override and breaks ties in starter order", () => {
    expect(parseGenerateInput({ request: "forest beach", kit: "desert" })).toEqual({
      kit: "desert",
    });
    expect(parseGenerateInput({ request: "beach forest" })).toEqual({ kit: "forest" });
  });

  it("rejects unmatched requests with the available recipes", () => {
    expect(() => parseGenerateInput({ request: "castle" })).toThrow(
      /forest, coastal, alpine, desert, tundra/,
    );
    for (const request of [null, 1, "", "   "]) {
      expect(() => parseGenerateInput({ request, kit: "forest" })).toThrow(/request/);
    }
  });

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
  it("derives the asset source from project config and defaults to assets", async () => {
    const project = await makeTempDir("tn-terrain-config-");
    expect(await resolveAssetSource(project)).toBe(join(project, "assets"));
    await writeFile(
      join(project, "threenative.config.ts"),
      'export default { assets: { source: "content" } };',
    );
    expect(await resolveAssetSource(project)).toBe(join(project, "content"));
    await writeFile(
      join(project, "threenative.config.ts"),
      "export default { assets: { source: 1 } };",
    );
    await expect(resolveAssetSource(project)).rejects.toThrow(/assets.source/);
    await writeFile(
      join(project, "threenative.config.ts"),
      'export default { assets: { source: "../escape" } };',
    );
    await expect(resolveAssetSource(project)).rejects.toThrow(/inside the project/);
  });

  let root: string;

  beforeEach(async () => {
    root = await makeTempDir("tn-terrain-mcp-");
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
    root = await realpath(await makeTempDir("tn-terrain-root-"));
    outside = await realpath(await makeTempDir("tn-terrain-outside-"));
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
    const project = await makeTempDir("tn-terrain-noassets-");
    try {
      await expect(loadCooker(project)).rejects.toThrow(/npm i -D @threenative\/assets/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("isolated generation child", () => {
  it("never spawns when the signal is already aborted", async () => {
    const dir = await makeTempDir("tn-terrain-preabort-");
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
    const dir = await makeTempDir("tn-terrain-group-");
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

  it("rejects malformed recipes and command payloads at the input boundary", () => {
    const recipe = {
      version: 1,
      config: { size: 512, resolution: 17, seed: 73 },
      layers: [{ id: "hills", type: "noise", params: { amplitude: 16 } }],
    };
    for (const invalid of [{}, { ...recipe, config: {} }, { ...recipe, layers: [{}] }]) {
      expect(() => parsePatchInput({ recipe: invalid, commands: [] })).toThrow();
    }
    for (const command of [
      { op: "upsert", layer: { id: "bad", type: "noise", params: { amplitude: "high" } } },
      { op: "update", id: "hills", patch: { params: { amplitude: "high" } } },
      { op: "update", id: "hills", patch: { mask: { type: "unknown" } } },
      { op: "update", id: "hills", patch: { params: [] } },
      { op: "move", id: "hills", index: "0" },
      { op: "toggle", id: "hills", enabled: "false" },
    ]) {
      expect(() => parsePatchInput({ recipe, commands: [command] })).toThrow();
    }
  });

  it("preserves valid payloads and validates commands in transaction order", () => {
    const recipe = { version: 1, config: { size: 512, resolution: 17, seed: 73 }, layers: [] };
    const commands = [
      { op: "upsert", layer: { id: "hills", type: "noise", params: { amplitude: 16 } } },
      { op: "update", id: "hills", patch: { params: { amplitude: 20 } } },
      { op: "toggle", id: "hills", enabled: false },
      { op: "move", id: "hills", index: 0 },
      { op: "remove", id: "hills" },
    ];
    expect(parsePatchInput({ recipe, commands })).toEqual({ recipe, commands });
    expect(recipe.layers).toEqual([]);
  });

  it("rejects a command that names a layer the recipe does not have", async () => {
    const recipe = await forestRecipe();
    expect(() => patchRecipe(recipe, [{ op: "remove", id: "no-such-layer" }] as never)).toThrow();
  });
});

// A GLB with only a JSON chunk: the counts live in accessor headers, so no buffer data is needed.
function glbOf(json: unknown): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const bytes = new Uint8Array(20 + padded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(padded, 20);
  return bytes;
}

describe("measureGlb", () => {
  const accessors = [{ count: 3 }, { count: 6 }, { count: 4 }, { count: 10 }];
  const meshes = [
    { primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 }, indices: 1 }] },
    {
      primitives: [
        { attributes: { POSITION: 2 }, mode: 5 },
        { attributes: { POSITION: 0 }, mode: 1 },
      ],
    },
  ];

  it("counts triangles per instance and draws per primitive, instanced or not", () => {
    const stats = measureGlb(
      glbOf({
        asset: { version: "2.0" },
        accessors,
        meshes,
        nodes: [
          { children: [1, 2] },
          { mesh: 0 },
          { mesh: 1, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 3 } } } },
        ],
        scene: 0,
        scenes: [{ nodes: [0] }],
      }),
    );
    // mesh 0 once: 1 + 2 triangles. mesh 1 ten times: a 4-vertex strip is 2 triangles, the line list none.
    expect(stats).toEqual({ draws: 4, instances: 10, triangles: 3 + 2 * 10 });
  });

  it("ignores the alternate scenes a cook writes beside the default one", () => {
    const stats = measureGlb(
      glbOf({
        asset: { version: "2.0" },
        accessors,
        meshes,
        nodes: [{ mesh: 0 }, { mesh: 0 }],
        scene: 1,
        scenes: [{ nodes: [0] }, { nodes: [1] }],
      }),
    );
    expect(stats).toEqual({ draws: 2, instances: 0, triangles: 3 });
  });

  it("fails closed on bytes that are not a GLB and on a dangling accessor", () => {
    expect(() => measureGlb(new Uint8Array(32))).toThrow(/not a GLB/);
    expect(() =>
      measureGlb(
        glbOf({
          asset: { version: "2.0" },
          meshes: [{ primitives: [{ attributes: { POSITION: 7 } }] }],
          nodes: [{ mesh: 0 }],
          scenes: [{ nodes: [0] }],
        }),
      ),
    ).toThrow(/accessor 7 is missing/);
  });
});

interface IHeightfieldCollider {
  readonly columns: number;
  readonly heights: Float32Array;
  readonly rows: number;
  readonly scale: { readonly x: number; readonly y: number; readonly z: number };
}

interface IEmittedBody {
  readonly entity?: string;
  readonly object?: Object3D;
  readonly type?: string;
}

async function runEmittedLoad(
  load: string,
  servedHeightmap: string,
  onResolve: (path: string) => void,
) {
  const scene = new Object3D();
  const dispose = vi.fn();
  const worldDispose = vi.fn();
  const surfaceDispose = vi.fn();
  let body: IEmittedBody | undefined;
  let collider: IHeightfieldCollider | undefined;
  let streamedFollow: { position: Object3D["position"] } | undefined;
  let streamedInvalidate: ((region?: object) => void) | undefined;
  const modules = {
    "@threenative/core/world": {
      Heightfield,
      heightSamplerFromHeightmap,
      loadWorldHeightmap,
      loadTerrainSplat: vi.fn(async () => ({ surface: "terrain", dispose: surfaceDispose })),
      WorldCells: {
        load: vi.fn(
          async (options: {
            follow: { position: Object3D["position"] };
            surface: unknown;
            shadows: { invalidate: (region?: object) => void };
          }) => {
            expect(options.surface).toMatchObject({ surface: "terrain" });
            streamedFollow = options.follow;
            streamedInvalidate = options.shadows.invalidate;
            return Object.assign(new Object3D(), { dispose: worldDispose });
          },
        ),
      },
    },
    "@threenative/physics": {
      CollisionShape3D: {
        heightfield: (
          rows: number,
          columns: number,
          heights: Float32Array,
          scale: IHeightfieldCollider["scale"],
        ) => {
          collider = { rows, columns, heights, scale };
          return collider;
        },
      },
      RigidBody3D: class {
        constructor(options: IEmittedBody) {
          body = options;
        }
        dispose = dispose;
      },
    },
    three: { Object3D },
  };
  const ctx = {
    add: (object: Object3D) => scene.add(object),
    assets: {
      model: async () => ({ scene: new Object3D() }),
      resolve: async (path: string) => {
        onResolve(path);
        return [servedHeightmap];
      },
    },
    physics: {},
    renderer: {},
    scene,
  };
  // Compile the real imports so missing modules, exports and aliases cannot pass by being stripped.
  const { outputText } = ts.transpileModule(load, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const execute = new Function(
    "modules",
    "ctx",
    `const exports = {}; const require = (name) => { if (!(name in modules)) throw new Error("Unexpected runtime import: " + name); return modules[name]; }; return (async () => { ${outputText}; return { loadCells }; })();`,
  );
  const { loadCells } = await execute(modules, ctx);
  const player = new Object3D();
  player.position.set(-2, 19, 7);
  const invalidate = vi.fn();
  streamedInvalidate?.();
  loadCells(player, invalidate);
  const region = { minX: 0, minZ: 0, maxX: 2, maxZ: 3 };
  streamedInvalidate?.(region);
  streamedInvalidate?.();
  expect(invalidate.mock.calls).toEqual([[region], [undefined]]);
  expect(streamedFollow?.position).toBe(player.position);
  player.position.z -= 10;
  expect(streamedFollow?.position.z).toBe(-3);
  expect(scene.children).toHaveLength(2);
  if (body === undefined || collider === undefined)
    throw new Error("The snippet created no terrain collider.");
  expect(dispose).not.toHaveBeenCalled();
  scene.clear();
  expect(dispose).toHaveBeenCalledOnce();
  expect(worldDispose).toHaveBeenCalledOnce();
  expect(surfaceDispose).toHaveBeenCalledOnce();
  const failure = new Error("streamed world failed");
  modules["@threenative/core/world"].WorldCells.load.mockRejectedValueOnce(failure);
  await expect(execute(modules, ctx)).rejects.toBe(failure);
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(worldDispose).toHaveBeenCalledOnce();
  expect(surfaceDispose).toHaveBeenCalledTimes(2);
  expect(scene.children).toHaveLength(0);
  modules["@threenative/core/world"].loadTerrainSplat.mockRejectedValueOnce(failure);
  await expect(execute(modules, ctx)).rejects.toBe(failure);
  expect(dispose).toHaveBeenCalledTimes(3);
  expect(surfaceDispose).toHaveBeenCalledTimes(2);
  expect(scene.children).toHaveLength(0);
  return {
    body,
    collider,
    streaming: modules["@threenative/core/world"].WorldCells.load.mock.calls[0]?.[0],
  };
}

describe("terrain_generate result", () => {
  it.each(["assets", "content"])(
    "returns a manifest-relative forest load snippet under %s",
    async (source) => {
      const project = await realpath(await makeTempDir("tn-terrain-result-"));
      try {
        await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
        await symlink(
          new URL("../../assets/", import.meta.url).pathname,
          join(project, "node_modules", "@threenative", "assets"),
        );
        await writeFile(
          join(project, "threenative.config.ts"),
          `export default { assets: { source: "${source}" } };`,
        );
        const out = join(project, source, "worlds", "forest");
        const result = JSON.parse(await cookKit({ kit: "forest", out, projectRoot: project }));
        expect(result).toMatchObject({
          recipe: "forest",
          out: `${source}/worlds/forest`,
          worldGlb: `${source}/worlds/forest/world.glb`,
          recipeJson: `${source}/worlds/forest/recipe.json`,
          worldPackage: `${source}/worlds/forest/world.json`,
        });
        for (const file of [result.worldGlb, result.recipeJson, result.worldPackage]) {
          expect((await stat(join(project, file))).size, file).toBeGreaterThan(0);
        }
        // The counts are the file's own: measuring the written GLB again gives the same numbers.
        const written = new Uint8Array(await readFile(join(project, result.worldGlb)));
        expect(measureGlb(written)).toEqual({
          draws: result.draws,
          instances: result.instances,
          triangles: result.triangles,
        });
        expect(result.instances).toBeGreaterThan(0);
        expect(result.draws).toBeGreaterThan(0);
        expect(result.triangles).toBeGreaterThan(result.instances);
        expect(result.load).toContain("WorldCells.load({");
        expect(result.load).toContain('url: "worlds/forest/world.json"');
        expect(result.load).toContain("loadTerrainSplat({ assets: ctx.assets");
        expect(result.load).toContain("ctx.add(world);");
        expect(result.load).not.toContain("ctx.assets.model");
        expect(result.load).not.toContain("applyTerrainSurface");
        // No authoring import leaks into the game: only core/world, physics and three are allowed.
        expect(
          result.load.split("\n").filter((line: string) => line.includes("@threenative/terrain")),
        ).toEqual([]);
        // The printed snippet must build the physical ground the visual GLB does not.
        const manifest = JSON.parse(await readFile(join(project, result.worldPackage), "utf8"));
        const heightmapBytes = new Uint8Array(
          await readFile(join(project, source, "worlds", "forest", manifest.terrain.heightmap)),
        );
        const served = `data:application/octet-stream;base64,${Buffer.from(heightmapBytes).toString("base64")}`;
        const resolved: string[] = [];
        const { body, collider, streaming } = await runEmittedLoad(result.load, served, (path) =>
          resolved.push(path),
        );
        expect(resolved).toEqual(Array(3).fill(`worlds/forest/${manifest.terrain.heightmap}`));
        // Exact record budgets are non-restrictive only while this export has no charged proxies.
        expect(
          manifest.cells.every(
            (cell: { proxy?: unknown; chunks?: unknown[] }) =>
              cell.proxy === undefined && (cell.chunks?.length ?? 0) === 0,
          ),
        ).toBe(true);
        const placementCount = manifest.cells.reduce(
          (sum: number, cell: { runs: { count: number }[] }) =>
            sum + cell.runs.reduce((count, run) => count + run.count, 0),
          0,
        );
        expect(streaming).toMatchObject({
          ring: 5,
          terrain: { streamRadius: 6 },
          budgets: {
            residentCells: manifest.cells.length,
            instances: placementCount,
            bytes: placementCount * 32,
          },
          shadows: { cast: true, receive: true },
        });
        expect(collider.rows).toBe(manifest.terrain.rows);
        expect(collider.columns).toBe(manifest.terrain.columns);
        expect(collider.scale).toEqual({
          x: manifest.extent.sizeX,
          y: 1,
          z: manifest.extent.sizeZ,
        });
        expect(body.type).toBe("fixed");
        expect(body.entity).toBe("terrain");
        expect(body.object?.position.x).toBe(manifest.extent.minX + manifest.extent.sizeX / 2);
        expect(body.object?.position.z).toBe(manifest.extent.minZ + manifest.extent.sizeZ / 2);
        const decoded = decodeRAW16(heightmapBytes, {
          height: manifest.terrain.rows,
          max: manifest.terrain.heightMax,
          min: manifest.terrain.heightMin,
          width: manifest.terrain.columns,
        });
        expect(collider.heights).toHaveLength(manifest.terrain.rows * manifest.terrain.columns);
        for (let column = 0; column < manifest.terrain.columns; column += 1)
          for (let row = 0; row < manifest.terrain.rows; row += 1)
            expect(collider.heights[column * manifest.terrain.rows + row]).toBeCloseTo(
              decoded.values[row * manifest.terrain.columns + column] as number,
              4,
            );
        // recipe.json is a document `terrain_patch` accepts as is.
        const recipe = JSON.parse(await readFile(join(project, result.recipeJson), "utf8"));
        expect(patchRecipe(recipe, []).layers).toHaveLength(recipe.layers.length);
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("terrain_generate cold GLB handoff", () => {
  it("generates a pine forest that vanilla GLTFLoader loads within 60 seconds", async () => {
    const project = await realpath(await makeTempDir("tn-terrain-cold-"));
    await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
    await symlink(
      new URL("../../assets/", import.meta.url).pathname,
      join(project, "node_modules", "@threenative", "assets"),
    );
    const start = performance.now();
    const child = spawn(
      process.execPath,
      [new URL("../dist/mcp/server.js", import.meta.url).pathname],
      { cwd: project, stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      const response = new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          if (buffer.includes("\n")) resolve(buffer.split("\n")[0] ?? "");
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`terrain server exited ${code}`)));
      });
      child.stdin.write(
        `${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name: "terrain_generate", arguments: { request: "a pine forest" } } })}\n`,
      );
      const reply = JSON.parse(await response);
      expect(reply.result.isError).toBe(false);
      const result = JSON.parse(reply.result.content[0].text);
      expect(result.worldGlb).toMatch(/world\.glb$/);
      const bytes = await readFile(join(project, result.worldGlb));
      vi.stubGlobal("self", globalThis);
      vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} }));
      const gltf = await new GLTFLoader().parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        "",
      );
      expect(gltf.scene.children.length).toBeGreaterThan(0);
      const ms = performance.now() - start;
      console.log(`TN_TERRAIN_COLD_LOAD: ${ms.toFixed(1)} ms; CPU: ${cpus()[0]?.model}`);
      expect(ms).toBeLessThan(60_000);
    } finally {
      child.kill();
      vi.unstubAllGlobals();
      await rm(project, { recursive: true, force: true });
    }
  }, 65_000);
});
