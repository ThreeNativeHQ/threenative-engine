import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
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
import type { LandformKind } from "../src/core/presets.js";
import { BIOME_OWN } from "../src/core/request-words.js";
import type { IGroundRequest } from "../src/core/surveys.js";
import { Terrain } from "../src/core/terrain.js";
import type { ITerrainDocument } from "../src/core/types.js";
import { IsolatedKillError, childExecArgv, runIsolated } from "../src/mcp/child.js";
import { PLAY_AREA_CLEAR_RADIUS, cookKit, loadCooker, parseBounds } from "../src/mcp/cook.js";
import { measureGlb } from "../src/mcp/glb-stats.js";
import {
  TERRAIN_KITS,
  TERRAIN_TOOLS,
  type TerrainKit,
  assertOutputFree,
  newBiomeSpec,
  parseBiomeNewInput,
  parseGenerateInput,
  parseGenerateRequest,
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

/** One starter's biome file, as data: the base an inline spec or a new biome is built from. */
async function starterBiome(kit: TerrainKit): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../starter/${kit}/biome.data.json`, import.meta.url), "utf8"),
  );
}

/** Every file under `root`, skipping installed packages: a tool call's writes are what it proves. */
async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const at = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(root, at)));
    else files.push(at);
  }
  return files;
}

interface IToolReply {
  result?: { isError?: boolean; content?: { text?: string }[] };
}

/** One request to the built server, in a fresh process started from `cwd`; its reply, parsed. */
async function askServer(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<IToolReply> {
  const child = spawn(
    process.execPath,
    [new URL("../dist/mcp/server.js", import.meta.url).pathname],
    { cwd, stdio: ["pipe", "pipe", "inherit"] },
  );
  try {
    const replied = new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        resolve(buffer.split("\n")[0] ?? "");
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`terrain server exited ${code}`)));
    });
    child.stdin.write(
      `${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } })}\n`,
    );
    return JSON.parse(await replied) as IToolReply;
  } finally {
    child.kill();
  }
}

describe("terrain MCP tool contract", () => {
  it("lists the generate, biome and patch tools with closed input schemas", () => {
    expect(TERRAIN_TOOLS.map((tool) => tool.name)).toEqual([
      "terrain_generate",
      "terrain_biome_new",
      "terrain_patch",
    ]);
    for (const tool of TERRAIN_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

// The catalog tier: a bare starter is the shipped, judged world; a repeat is a copy, not a cook.
describe("terrain_generate catalog and cook cache", () => {
  it("serves a repeated request from the project's cook cache at its own path", async () => {
    const project = await realpath(await makeTempDir("tn-terrain-cache-"));
    try {
      await writeFile(
        join(project, "threenative.config.ts"),
        'export default { assets: { source: "assets" } };',
      );
      await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
      await symlink(
        new URL("../../assets/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "assets"),
      );
      await symlink(
        new URL("../../procedural-vegetation/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "procedural-vegetation"),
      );
      const ask = async (args: Record<string, unknown>) => {
        const started = performance.now();
        const reply = await askServer(project, "terrain_generate", args);
        const text = reply.result?.content?.[0]?.text as string;
        expect(reply.result?.isError, text).toBe(false);
        return { ...JSON.parse(text), wall: performance.now() - started };
      };
      const first = await ask({ kit: "forest", out: "assets/worlds/first" });
      const second = await ask({ kit: "forest", out: "assets/worlds/second" });
      expect([first.source, first.cache, first.seed]).toEqual(["catalog:forest", "miss", 73]);
      expect([second.source, second.cache, second.seed]).toEqual(["catalog:forest", "hit", 73]);
      // The copy names its own folder everywhere the cook named the first one.
      expect(second.worldGlb).toBe("assets/worlds/second/world.glb");
      expect(JSON.stringify(second)).not.toContain("worlds/first");
      const glb = (name: string) => readFile(join(project, "assets", "worlds", name, "world.glb"));
      expect(Buffer.compare(await glb("first"), await glb("second"))).toBe(0);
      expect(second.wall).toBeLessThan(first.wall / 2);
      // Any choice of its own is a fresh cook, reported as one, with the seed it asked for.
      const reroll = await ask({ kit: "forest", seed: 74, out: "assets/worlds/reroll" });
      expect([reroll.source, reroll.cache, reroll.seed]).toEqual(["cooked", "miss", 74]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 240_000);
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

  it("cooks any request: a word with no row takes the forest and is reported unused", () => {
    // "Queries anything": a request never fails for its words. The biome is the reported default,
    // and every word that named nothing comes back so the caller can see what was not read.
    const castle = parseGenerateRequest({ request: "castle ruins" });
    expect(castle.input).toEqual({ kit: "forest" });
    expect(castle.decided.biome).toEqual({ value: "forest", source: "default" });
    expect(castle.unused).toEqual(["castle", "ruins"]);
    // A sea or a shape with no biome word picks the starter that suits it, naming the word.
    for (const [request, kit, word] of [
      ["a volcanic island", "coastal", "island"],
      ["a volcanic island with a lake", "coastal", "island"],
      ["rolling hills with a lake", "forest", "rolling"],
      ["a misty fjord", "coastal", "fjord"],
      ["the grand canyon", "desert", "canyon"],
      ["swiss alps", "alpine", "alps"],
      ["a frozen wasteland", "tundra", "frozen"],
    ] as const) {
      expect(parseGenerateRequest({ request }).decided.biome).toEqual({
        value: kit,
        source: { word },
      });
    }
    expect(parseGenerateRequest({ request: "a volcanic island" }).decided.landform.value).toBe(
      "volcanic",
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

  it("rejects an output outside assets.source before a cook could start", async () => {
    await mkdir(join(root, "assets"));
    const source = join(root, "assets");
    expect(await resolveOutput(root, "assets/worlds/forest", source)).toBe(
      join(source, "worlds", "forest"),
    );
    await expect(resolveOutput(root, "public/worlds/forest", source)).rejects.toThrow(
      /must be under assets\.source \('assets'\) so the build lists the world in its manifest/u,
    );
    // The source root itself is not a world directory.
    await expect(resolveOutput(root, "assets", source)).rejects.toThrow(/assets\.source/u);
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

  it("fails closed on a truncated GLB or another container version (audit TERRAIN-23)", () => {
    const glb = glbOf({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
    expect(() => measureGlb(glb.subarray(0, glb.length - 4))).toThrow(/header length/);
    const v1 = glb.slice();
    new DataView(v1.buffer).setUint32(4, 1, true);
    expect(() => measureGlb(v1)).toThrow(/version/);
    expect(measureGlb(glb)).toEqual({ draws: 0, instances: 0, triangles: 0 });
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
  let streamedWorld: Object3D | undefined;
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
            streamedWorld = Object.assign(new Object3D(), { dispose: worldDispose });
            return streamedWorld;
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
    // The game's copy of `starter/arbor/wind.ts`, which the cook writes beside an Arbor world.
    "./render/arborWind.js": { arborWind: () => undefined },
  };
  // The curtain the load holds until the streamed ground is in.
  const holds: string[] = [];
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
    startup: { hold: (label: string) => holds.push(label) },
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
  expect(holds).toEqual(["terrain"]);
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
  if (body === undefined || collider === undefined || streamedWorld === undefined)
    throw new Error("The snippet created no terrain collider.");
  const world = streamedWorld;
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
    world,
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
        await symlink(
          new URL("../../procedural-vegetation/", import.meta.url).pathname,
          join(project, "node_modules", "@threenative", "procedural-vegetation"),
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
        expect(result.load).toContain('ctx.startup.hold("terrain"');
        expect(result.load).toContain("terrainReadinessInView(ctx.camera)");
        expect(result.load).not.toContain("ctx.assets.model");
        expect(result.load).not.toContain("applyTerrainSurface");
        expect(result.grass).toContain("grassFieldFromBiome(grassBiome");
        expect(result.grass).toContain("} as const;");
        expect(result.grass).toContain("new GrassField3D(");
        expect(result.grass).toContain("grass.update(ctx.camera)");
        // The forest kit's trees are Arbor species: they carry `_WIND`, so the cook writes the sway.
        expect(result.trees?.file).toBe("src/render/arborWind.ts");
        expect(result.load).toContain("partMaterial: arborWind");
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
        const { body, collider, streaming, world } = await runEmittedLoad(
          result.load,
          served,
          (path) => resolved.push(path),
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
        // The cooked centre pad meets the game's floor (y = 0) a hair below it, on the collider and
        // the streamed world alike: at the cooked heights the starter arena sat 11 m inside the hill.
        const centre = decoded.values[
          Math.floor(manifest.terrain.rows / 2) * manifest.terrain.columns +
            Math.floor(manifest.terrain.columns / 2)
        ] as number;
        expect(body.object?.position.y).toBeCloseTo(-centre - 0.05, 3);
        expect(world.position.y).toBe(body.object?.position.y);
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
    await symlink(
      new URL("../../procedural-vegetation/", import.meta.url).pathname,
      join(project, "node_modules", "@threenative", "procedural-vegetation"),
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

describe("cook child flags (audit TERRAIN-16)", () => {
  it("drops debugger and profiler flags and keeps loader flags", () => {
    expect(
      childExecArgv([
        "--inspect=0",
        "--import",
        "tsx",
        "--inspect-brk",
        "--cpu-prof",
        "--cpu-prof-dir",
        "out",
        "--heap-prof-name=x",
        "--debug-port=9229",
        "--conditions=dev",
      ]),
    ).toEqual(["--import", "tsx", "--conditions=dev"]);
  });
});

// PRD-793 phase 1: every shipped kit is a server-side cook, not only the forest one. Each row is
// also the cook-time baseline a sixth biome is measured against (AC-3).
describe("every shipped kit cooks", () => {
  it.each(TERRAIN_KITS)(
    "cooks %s and reports the counts of the GLB it wrote",
    async (kit) => {
      const project = await realpath(await makeTempDir("tn-terrain-kits-"));
      try {
        await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
        await symlink(
          new URL("../../assets/", import.meta.url).pathname,
          join(project, "node_modules", "@threenative", "assets"),
        );
        await symlink(
          new URL("../../procedural-vegetation/", import.meta.url).pathname,
          join(project, "node_modules", "@threenative", "procedural-vegetation"),
        );
        await writeFile(
          join(project, "threenative.config.ts"),
          'export default { assets: { source: "assets" } };',
        );
        const out = join(project, "assets", "worlds", kit);
        const started = performance.now();
        const result = JSON.parse(await cookKit({ kit, out, projectRoot: project }));
        const wall = Math.round(performance.now() - started);
        expect(result.recipe).toBe(kit);
        // The counts reported are the file's own, measured again from the bytes on disk.
        const written = new Uint8Array(await readFile(join(project, result.worldGlb)));
        expect(measureGlb(written)).toEqual({
          draws: result.draws,
          instances: result.instances,
          triangles: result.triangles,
        });
        expect(result.triangles).toBeGreaterThan(0);
        expect(result.instances).toBeGreaterThan(0);
        expect(result.draws).toBeGreaterThan(0);
        expect(result.load).toContain("WorldCells.load({");
        console.log(
          `TN_TERRAIN_KIT ${kit}: ${result.triangles} triangles, ${result.instances} instances, ${result.draws} draws, cook ${result.ms} ms (wall ${wall} ms)`,
        );
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

// PRD-793 phase 2: a request may name one of the seven landform presets beside its kit.
describe("terrain_generate landform", () => {
  it("accepts any of the seven presets and passes it to the cook", () => {
    for (const landform of [
      "alpine",
      "temperateMountains",
      "rollingHills",
      "desertMesa",
      "coastalCliffs",
      "tundra",
      "volcanic",
    ] as const) {
      expect(parseGenerateInput({ kit: "forest", landform })).toEqual({ kit: "forest", landform });
    }
  });

  it("rejects a shape it does not have, naming the seven", () => {
    expect(() => parseGenerateInput({ kit: "forest", landform: "moon" })).toThrow(
      /landform must be one of .*rollingHills/,
    );
  });

  it("declares the preset list in its schema", () => {
    const schema = TERRAIN_TOOLS[0].inputSchema as {
      properties: Record<string, { enum?: readonly string[] }>;
    };
    expect(schema.properties.landform?.enum).toHaveLength(7);
  });
});

// PRD-793 phase 2: a request may override the shape, the size and the seed. Each has to reach the
// recipe the cook actually evaluates, not a field beside it.
describe("terrain_generate overrides", () => {
  async function cook(overrides: {
    kit: TerrainKit;
    landform?: LandformKind;
    seed?: number;
    sizeMeters?: number;
    ground?: IGroundRequest;
  }) {
    const project = await realpath(await makeTempDir("tn-terrain-overrides-"));
    await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
    await symlink(
      new URL("../../assets/", import.meta.url).pathname,
      join(project, "node_modules", "@threenative", "assets"),
    );
    await symlink(
      new URL("../../procedural-vegetation/", import.meta.url).pathname,
      join(project, "node_modules", "@threenative", "procedural-vegetation"),
    );
    await writeFile(
      join(project, "threenative.config.ts"),
      'export default { assets: { source: "assets" } };',
    );
    const out = join(project, "assets", "worlds", "world");
    const result = JSON.parse(await cookKit({ ...overrides, out, projectRoot: project }));
    const recipe = JSON.parse(await readFile(join(project, result.recipeJson), "utf8"));
    const manifest = JSON.parse(await readFile(join(project, result.worldPackage), "utf8"));
    return {
      manifest,
      recipe,
      result,
      remove: () => rm(project, { recursive: true, force: true }),
    };
  }

  it("applies sizeMeters and seed to the recipe's own config", async () => {
    const { recipe, manifest, remove } = await cook({ kit: "forest", seed: 7, sizeMeters: 256 });
    try {
      expect(recipe.config).toMatchObject({ seed: 7, size: 256 });
      expect(manifest.extent.sizeX).toBe(256);
      expect(manifest.extent.sizeZ).toBe(256);
    } finally {
      await remove();
    }
  }, 120_000);

  it("cooks a landform preset the five starters do not ship", async () => {
    // PRD-854 phase 2: a preset is grounded on a real survey by default, which would need the
    // network; this case proves the preset's own chain, so it asks for the procedural ground.
    const { recipe, result, remove } = await cook({
      kit: "forest",
      landform: "rollingHills",
      ground: "procedural",
    });
    try {
      // The preset's own chain, not the starter's heightmap crop.
      expect(recipe.layers.some((layer: { type: string }) => layer.type === "heightmap")).toBe(
        false,
      );
      expect(result.triangles).toBeGreaterThan(0);
      expect(result.draws).toBeGreaterThan(0);
    } finally {
      await remove();
    }
  }, 120_000);
});

// PRD-793 phase 2: `biome` is the wide input — a starter's name, one of its alias words, or an
// inline spec — and `water` replaces the water bodies the biome declares.
describe("terrain_generate biome", () => {
  it("selects a kit from a biome's name and from its alias words", () => {
    for (const kit of TERRAIN_KITS) expect(parseGenerateInput({ biome: kit })).toEqual({ kit });
    expect(parseGenerateInput({ biome: "woods" })).toEqual({ kit: "forest" });
    expect(parseGenerateInput({ biome: " Sea " })).toEqual({ kit: "coastal" });
    expect(parseGenerateInput({ biome: "dunes" })).toEqual({ kit: "desert" });
  });

  it("keeps kit as the explicit override over a biome name", () => {
    expect(parseGenerateInput({ biome: "woods", kit: "desert" })).toEqual({ kit: "desert" });
  });

  it("fails an unmatched biome and lists every biome word", () => {
    expect(() => parseGenerateInput({ biome: "castle" })).toThrow(
      /biome 'castle' matches no biome\. Try one of: .*forest \(pine, pines, woods, woodland/,
    );
    for (const biome of [2, [], null]) {
      expect(() => parseGenerateInput({ biome })).toThrow(/biome must be a starter name/);
    }
  });

  it("takes an inline biome spec, cooked with forest's art unless kit names another", async () => {
    const spec = newBiomeSpec(await starterBiome("forest"), "savanna", {
      landform: "rollingHills",
      water: [{ kind: "ocean", level: 2 }],
    });
    expect(parseGenerateInput({ biome: spec })).toEqual({ kit: "forest", spec });
    expect(parseGenerateInput({ biome: spec, kit: "tundra" })).toEqual({ kit: "tundra", spec });
    // The spec is checked at the tool boundary, so a misspelt or missing field names itself.
    expect(() => parseGenerateInput({ biome: { ...spec, moons: 2 } })).toThrow(
      /biome field 'moons' is not a field a biome has/,
    );
    expect(() => parseGenerateInput({ biome: { look: "savanna" } })).toThrow(
      /biome field 'bake' is missing/,
    );
  });

  it("takes water overrides and rejects a malformed list", () => {
    expect(parseGenerateInput({ kit: "forest", water: [{ kind: "lake", radius: 40 }] })).toEqual({
      kit: "forest",
      water: [{ kind: "lake", radius: 40 }],
    });
    for (const water of [2, {}, [{ kind: "lake" }, 2]]) {
      expect(() => parseGenerateInput({ kit: "forest", water })).toThrow(/water must be an array/);
    }
  });
});

// PRD-793 phase 2: the inline spec and the water override reach a real cook, not only the parser.
describe("terrain_generate biome cooks", () => {
  async function cook(request: Omit<Parameters<typeof cookKit>[0], "out" | "projectRoot">) {
    const project = await realpath(await makeTempDir("tn-terrain-biome-cook-"));
    await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
    await symlink(
      new URL("../../assets/", import.meta.url).pathname,
      join(project, "node_modules", "@threenative", "assets"),
    );
    await symlink(
      new URL("../../procedural-vegetation/", import.meta.url).pathname,
      join(project, "node_modules", "@threenative", "procedural-vegetation"),
    );
    await writeFile(
      join(project, "threenative.config.ts"),
      'export default { assets: { source: "assets" } };',
    );
    const out = join(project, "assets", "worlds", "world");
    const result = JSON.parse(await cookKit({ ...request, out, projectRoot: project }));
    const recipe = JSON.parse(await readFile(join(project, result.recipeJson), "utf8"));
    const water = JSON.parse(
      await readFile(join(project, "assets", "worlds", "world", "water.json"), "utf8"),
    );
    return { recipe, result, water, remove: () => rm(project, { recursive: true, force: true }) };
  }

  it("cooks an inline biome spec from its own landform, size and seed", async () => {
    const spec = newBiomeSpec(await starterBiome("forest"), "savanna", {
      landform: "rollingHills",
      seed: 11,
      sizeMeters: 256,
      water: [{ kind: "ocean", level: 3 }],
    });
    const { recipe, result, remove } = await cook({
      kit: "forest",
      spec,
      ground: "procedural",
    });
    try {
      expect(result.biome).toBe("savanna");
      // A preset carries no river or lake layer and a spec's rows are its declaration, so this
      // ground floods nothing and the reply reports no water the world does not have.
      expect(result.water).toEqual([]);
      // The preset's chain, not the starter's authored crop, and the spec's own numbers.
      expect(recipe.layers.some((layer: { type: string }) => layer.type === "heightmap")).toBe(
        false,
      );
      expect(recipe.config).toMatchObject({ seed: 11, size: 256 });
      expect(result.triangles).toBeGreaterThan(0);
      expect(result.draws).toBeGreaterThan(0);
      expect(result.bands.elevationRange[1]).toBeGreaterThan(result.bands.elevationRange[0]);
    } finally {
      await remove();
    }
  }, 120_000);

  it("replaces the water bodies the starter biome declares", async () => {
    const { result, water, remove } = await cook({
      kit: "forest",
      water: [{ kind: "ocean", level: 4 }],
    });
    try {
      // The forest declares a river and a lake; the request's ocean is what this world floods.
      expect(result.water).toEqual([{ kind: "ocean", level: 4 }]);
      expect(result.biome).toBe("forest");
      // The cooked world floods as requested: the forest's own lake (level 13.3) and river are gone.
      expect(water.lakes.map((lake: { level: number }) => lake.level)).toEqual([4]);
      expect(water.rivers).toEqual([]);
    } finally {
      await remove();
    }
  }, 120_000);

  it("re-shapes the water layers the recipe has, in order, from the biome rows", async () => {
    const { water, remove } = await cook({
      kit: "forest",
      water: [
        { kind: "river", width: 3 },
        { kind: "lake", radius: 40 },
      ],
    });
    try {
      expect(water.rivers.map((river: { width: number }) => river.width)).toEqual([3]);
      expect(water.lakes.map((lake: { radius: number }) => lake.radius)).toEqual([40]);
    } finally {
      await remove();
    }
  }, 120_000);

  it("reports the water the cooked world floods, kind and all, as water.json records it", async () => {
    const forest = await cook({ kit: "forest" });
    try {
      // The forest's rows name a river and a lake; the world floods the lake to the recipe's own
      // 13.3 m level, which `water.json` records. The reply reads the same evaluated state.
      expect(forest.result.water).toEqual([
        { kind: "lake", radius: 105, level: 13.3 },
        { kind: "river", width: 5.32 },
      ]);
      expect(forest.water.lakes.map((lake: { level: number }) => lake.level)).toEqual([13.3]);
    } finally {
      await forest.remove();
    }
    const sea = await cook({ kit: "forest", water: [{ kind: "ocean", level: 4 }] });
    try {
      // The reply names an ocean, so the file the game reads names that same body an ocean.
      expect(sea.result.water).toEqual([{ kind: "ocean", level: 4 }]);
      expect(sea.water.lakes).toEqual([expect.objectContaining({ kind: "ocean", level: 4 })]);
    } finally {
      await sea.remove();
    }
  }, 120_000);

  // PRD-854: a river row the recipe has no layer for runs down the ground's own drainage.
  it.each([
    ["the coastal kit's own recipe", { kit: "coastal", water: [{ kind: "river", width: 3 }] }],
    [
      '"create a forest with mountains and a river"',
      {
        ...parseGenerateRequest({ request: "create a forest with mountains and a river" }).input,
        ground: "procedural",
      },
    ],
  ] as const)(
    "routes a river row with no layer down %s",
    async (_, request) => {
      const world = await cook(request as Parameters<typeof cook>[0]);
      try {
        const row = (request.water as readonly { width: number }[])[0] as { width: number };
        expect(world.result.water).toEqual([{ kind: "river", width: row.width }]);
        expect(world.water.rivers).toHaveLength(1);
        const points = world.water.rivers[0].points as [number, number, number][];
        expect(points.length).toBeGreaterThanOrEqual(3);
        // Downstream order: the last point reaches the world's edge, and no point climbs far.
        const half = world.recipe.config.size / 2;
        const last = points.at(-1) as [number, number, number];
        expect(Math.max(Math.abs(last[0]), Math.abs(last[2]))).toBeGreaterThan(half - 8);
        for (let k = 1; k < points.length; k++)
          expect((points[k] as [number, number, number])[1]).toBeLessThanOrEqual(
            (points[k - 1] as [number, number, number])[1] + 0.5,
          );
      } finally {
        await world.remove();
      }
    },
    120_000,
  );

  // "A volcanic island with a lake" and "a small island with a lake": the presets author no lake,
  // so the cook finds where water would stand (the deepest closed basin a lake fits in on land) or
  // digs one, and the sea the request names surrounds the land. The visual check that found both
  // gaps: the lake drew zero flooded cells, and the island stood as a slab in a flooded plane.
  it.each([
    ["a volcanic island with a lake", "procedural"],
    ["a small island with a lake", undefined],
  ] as const)(
    "floods a lake inside the land of %s, and the sea rings it",
    async (request, ground) => {
      const world = await cook({
        ...parseGenerateRequest({ request }).input,
        ...(ground === undefined ? {} : { ground }),
      });
      try {
        const state = Terrain.fromJSON(world.recipe).evaluate();
        const n = state.resolution;
        const ocean = state.waters.find((water) => water.kind === "ocean");
        const lake = state.waters.find((water) => water.kind === "lake");
        expect(ocean?.level).toBe(1.5);
        // The lake floods real cells, none of them the sea's or next to it.
        const wet = (lake?.mask ?? new Uint8Array()).reduce((sum, cell) => sum + cell, 0);
        expect(wet).toBeGreaterThan(20);
        for (let i = 0; i < n * n; i += 1)
          if (lake?.mask[i])
            for (const j of [i - 1, i + 1, i - n, i + n]) expect(ocean?.mask[j] ?? 0).toBe(0);
        // Every border cell is under the sea: land the sea surrounds, not a slab.
        for (let k = 0; k < n; k += 1)
          for (const i of [k, (n - 1) * n + k, k * n, k * n + n - 1])
            expect(state.height[i]).toBeLessThan(1.5);
        expect(world.result.water).toEqual([
          { kind: "ocean", level: 1.5 },
          expect.objectContaining({ kind: "lake" }),
        ]);
      } finally {
        await world.remove();
      }
    },
    240_000,
  );
  // "A desert canyon" kept the desert's flat crop and "a misty fjord" the coast's round island: a
  // landform word only picks a preset, and the kit's own preset keeps the kit's ground. The visual
  // judge read MISMATCH; a feature word now carves its shape into whatever ground stands there.
  it.each([
    ["a desert canyon", "canyon"],
    ["a misty fjord", "fjord"],
  ] as const)(
    "carves the shape %s names into the ground",
    async (request, feature) => {
      const parsed = parseGenerateRequest({ request });
      expect(parsed.decided.features).toEqual({ value: [feature], source: { word: feature } });
      const world = await cook(parsed.input);
      try {
        const state = Terrain.fromJSON(world.recipe).evaluate();
        const { resolution: n, size } = state;
        const cut = world.recipe.layers.find(
          (layer: { id: string }) => layer.id === `${feature}-0`,
        ) as
          | { params: { at: [number, number]; rotation: number; radius: [number, number] } }
          | undefined;
        expect(cut).toBeDefined();
        const { at, rotation, radius } = cut?.params ?? { at: [0, 0], rotation: 0, radius: [0, 0] };
        const turn = (rotation * Math.PI) / 180;
        const cellOf = (x: number, z: number) =>
          Math.round((z / size + 0.5) * (n - 1)) * n + Math.round((x / size + 0.5) * (n - 1));
        // Points along the cut's axis inside the square, and the same points beside the cut.
        const along = [-0.3, -0.15, 0, 0.15, 0.3]
          .map(
            (t) => [at[0] - Math.sin(turn) * t * size, at[1] + Math.cos(turn) * t * size] as const,
          )
          .filter(([x, z]) => Math.max(Math.abs(x), Math.abs(z)) < size * 0.4);
        const beside = (x: number, z: number) =>
          cellOf(x + Math.cos(turn) * radius[0] * 3, z + Math.sin(turn) * radius[0] * 3);
        expect(along.length).toBeGreaterThan(1);
        if (feature === "canyon") {
          const mean = (cells: number[]) =>
            cells.reduce((sum, i) => sum + (state.height[i] as number), 0) / cells.length;
          const floor = mean(along.map(([x, z]) => cellOf(x, z)));
          const rim = mean(along.map(([x, z]) => beside(x, z)));
          expect(rim - floor).toBeGreaterThan(15);
        } else {
          const ocean = state.waters.find((water) => water.kind === "ocean");
          // The inlet's own points flood from the sea, and land stands beside them.
          const inland = along.filter(([x, z]) => (state.height[beside(x, z)] as number) > 1.5);
          expect(inland.length).toBeGreaterThan(0);
          for (const [x, z] of inland) expect(ocean?.mask[cellOf(x, z)]).toBe(1);
        }
      } finally {
        await world.remove();
      }
    },
    240_000,
  );
});

// PRD-854 phase 1: a request's words decide the landform, the water and the size, not only the
// biome. Each word row is its own case, so a row that stops matching fails here rather than
// dropping the word on the floor. The base biome is one whose own declaration differs from the row,
// so the case proves the word replaced it; a word that names the biome's own row is its own case.
describe("terrain_generate request words", () => {
  it.each([
    ["alpine", "alpine", "forest"],
    ["mountain", "alpine", "forest"],
    ["mountains", "alpine", "forest"],
    ["peaks", "alpine", "forest"],
    ["foothills", "temperateMountains", "desert"],
    ["valley", "temperateMountains", "desert"],
    ["hill", "rollingHills", "desert"],
    ["hills", "rollingHills", "desert"],
    ["rolling", "rollingHills", "desert"],
    ["butte", "desertMesa", "forest"],
    ["canyon", "desertMesa", "forest"],
    ["mesa", "desertMesa", "forest"],
    ["cliff", "coastalCliffs", "forest"],
    ["cliffs", "coastalCliffs", "forest"],
    ["coast", "coastalCliffs", "forest"],
    ["island", "coastalCliffs", "forest"],
    ["arctic", "tundra", "forest"],
    ["tundra", "tundra", "forest"],
    ["volcano", "volcanic", "forest"],
    ["volcanic", "volcanic", "forest"],
  ])("reads '%s' as the %s landform", (word, landform, biome) => {
    const { input, decided } = parseGenerateRequest({ request: `a ${biome} world with ${word}` });
    expect(input.landform).toBe(landform);
    expect(decided.landform).toEqual({ value: landform, source: { word } });
  });

  it.each([
    ["creek", { kind: "river", width: 5.32 }, "desert"],
    ["river", { kind: "river", width: 5.32 }, "desert"],
    ["lake", { kind: "lake", radius: 105 }, "desert"],
    ["pond", { kind: "lake", radius: 105 }, "desert"],
    ["island", { kind: "ocean", level: 1.5 }, "forest"],
    ["ocean", { kind: "ocean", level: 1.5 }, "forest"],
    ["sea", { kind: "ocean", level: 1.5 }, "forest"],
  ])("reads '%s' as the water the world floods", (word, row, biome) => {
    const { input, decided } = parseGenerateRequest({ request: `a ${biome} world with a ${word}` });
    expect(input.water).toEqual([row]);
    expect(decided.water).toEqual({ value: [row], source: { word } });
  });

  it.each([
    ["big", 1024],
    ["huge", 1024],
    ["large", 1024],
    ["small", 256],
    ["tiny", 256],
  ])("scales the biome's own size for '%s'", (word, sizeMeters) => {
    const { input, decided } = parseGenerateRequest({ request: `a ${word} forest` });
    expect(input.sizeMeters).toBe(sizeMeters);
    expect(decided.sizeMeters).toEqual({ value: sizeMeters, source: { word } });
  });

  it.each(TERRAIN_KITS)("mirrors %s's own landform, size and water", async (kit) => {
    const spec = JSON.parse(
      await readFile(new URL(`../starter/${kit}/biome.data.json`, import.meta.url), "utf8"),
    ) as { landform: string; sizeMeters: number; water: unknown };
    expect(BIOME_OWN[kit]).toEqual({
      landform: spec.landform,
      sizeMeters: spec.sizeMeters,
      water: spec.water,
    });
  });

  it("leaves the starter's own world alone when a word names what it already is", () => {
    // The alpine starter authors its own ground and floods nothing, so "peaks" adds no preset and
    // no water row: the authored world is what the request asked for. The word still decided it.
    const { input, decided } = parseGenerateRequest({ request: "a snowy world with peaks" });
    expect(input).toEqual({ kit: "alpine" });
    expect(decided.landform).toEqual({ value: "alpine", source: { word: "peaks" } });
    // The forest authors its own recipe, and that recipe already floods a river and a lake, so the
    // word names the water instead of replacing it. A landform word that replaced the ground would
    // leave those layers behind, and then the row is the request's own (the cook fails closed).
    const forest = parseGenerateRequest({ request: "a forest with a river" });
    expect(forest.input).toEqual({ kit: "forest" });
    expect(forest.decided.water).toEqual({
      value: [
        { kind: "river", width: 5.32 },
        { kind: "lake", radius: 105 },
      ],
      source: { word: "river" },
    });
  });

  it("keeps every explicit argument over the request's words", () => {
    const water = [{ kind: "ocean", level: 4 }];
    const { input, decided, unused } = parseGenerateRequest({
      request: "a huge alpine forest with mountains, hills and a river",
      kit: "desert",
      landform: "rollingHills",
      sizeMeters: 300,
      water,
    });
    expect(input).toEqual({ kit: "desert", landform: "rollingHills", sizeMeters: 300, water });
    expect(decided).toEqual({
      biome: { value: "desert", source: "argument" },
      landform: { value: "rollingHills", source: "argument" },
      water: { value: water, source: "argument" },
      sizeMeters: { value: 300, source: "argument" },
      features: { value: [], source: "default" },
      // PRD-854 phase 2: the argument's landform is grounded on its kind's real survey.
      ground: { value: "survey", source: "default" },
      // PRD-866: rolling hills carry no massif rows, so the ring is not cooked.
      backdrop: { value: "none", source: "default" },
      tree: { value: null, source: "default" },
    });
    // A word that named a row is spent even when an argument overruled it, so it is not unused.
    expect(unused).toEqual([]);
  });

  it("reports each choice with its word and the words nothing answered", () => {
    const { input, decided, unused } = parseGenerateRequest({
      request: "create a huge forest with mountains, a river and floating castles",
    });
    // The record and the cook's input agree: every choice a word made is on the input the cook
    // reads. The ground is the alpine preset here, so the river row is the request's own: a preset
    // carries no river or lake layer, and the cook fails closed rather than flood nothing silently.
    expect(input).toEqual({
      kit: "forest",
      landform: "alpine",
      water: [{ kind: "river", width: 5.32 }],
      sizeMeters: 1024,
    });
    expect(decided).toEqual({
      biome: { value: "forest", source: { word: "forest" } },
      landform: { value: "alpine", source: { word: "mountains" } },
      water: { value: [{ kind: "river", width: 5.32 }], source: { word: "river" } },
      sizeMeters: { value: 1024, source: { word: "huge" } },
      features: { value: [], source: "default" },
      ground: { value: "survey", source: "default" },
      // PRD-866: a mountain preset on its survey cooks the far ring with a real massif.
      backdrop: { value: "massif", source: "default" },
      tree: { value: null, source: "default" },
    });
    // "create", "with", "and", "a" are scaffolding; only the words that named nothing are listed.
    expect(unused).toEqual(["floating", "castles"]);
  });

  it("reports a choice it did not make as the default the biome file keeps", () => {
    const { decided, unused } = parseGenerateRequest({ kit: "forest" });
    expect(decided).toEqual({
      biome: { value: "forest", source: "argument" },
      landform: { value: null, source: "default" },
      water: { value: null, source: "default" },
      sizeMeters: { value: null, source: "default" },
      features: { value: [], source: "default" },
      // No landform preset, so the ground is the crop the starter authored, not a fetched survey.
      ground: { value: "starter", source: "default" },
      backdrop: { value: "none", source: "default" },
      tree: { value: null, source: "default" },
    });
    expect(unused).toEqual([]);
  });

  it("takes an inline spec's own landform, size and water over a request word", async () => {
    const spec = newBiomeSpec(await starterBiome("forest"), "savanna", {
      landform: "rollingHills",
      sizeMeters: 256,
    });
    const { input, decided } = parseGenerateRequest({
      biome: spec,
      request: "a huge forest with mountains and a lake",
    });
    // The spec is the biome's whole declaration: the words are spent, and nothing replaces its rows.
    expect(input).toEqual({ kit: "forest", spec });
    expect(decided.landform).toEqual({ value: "rollingHills", source: "argument" });
    expect(decided.sizeMeters).toEqual({ value: 256, source: "argument" });
    expect(decided.water).toEqual({ value: spec.water, source: "argument" });
  });

  it("cooks the words' landform and size into the world", async () => {
    const project = await realpath(await makeTempDir("tn-terrain-words-cook-"));
    try {
      await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
      await symlink(
        new URL("../../assets/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "assets"),
      );
      await symlink(
        new URL("../../procedural-vegetation/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "procedural-vegetation"),
      );
      await writeFile(
        join(project, "threenative.config.ts"),
        'export default { assets: { source: "assets" } };',
      );
      const { input } = parseGenerateRequest({
        request: "create a huge forest with rolling hills",
      });
      const out = join(project, "assets", "worlds", "world");
      // PRD-854 phase 2: the words' landform would ground itself on a real survey, which needs the
      // network; this case is about the words reaching the recipe, so it cooks procedural ground.
      const result = JSON.parse(
        await cookKit({ ...input, ground: "procedural", out, projectRoot: project }),
      );
      const recipe = JSON.parse(await readFile(join(project, result.recipeJson), "utf8"));
      const manifest = JSON.parse(await readFile(join(project, result.worldPackage), "utf8"));
      // The words reached the recipe the cook evaluates, not a field beside it.
      expect(recipe.config.size).toBe(1024);
      expect(manifest.extent.sizeX).toBe(1024);
      expect(recipe.layers.some((layer: { type: string }) => layer.type === "heightmap")).toBe(
        false,
      );
      expect(result.triangles).toBeGreaterThan(0);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);
});

// PRD-793 AC-1: every landform cooks under every shipped biome. The kit supplies the surface, the
// assets and the biome file; the preset supplies the ground, so the pair needs no new starter.
const LANDFORMS_IN_MATRIX = [
  "alpine",
  "temperateMountains",
  "rollingHills",
  "desertMesa",
  "coastalCliffs",
  "tundra",
  "volcanic",
] as const;
const BIOME_MATRIX = TERRAIN_KITS.flatMap((kit) =>
  LANDFORMS_IN_MATRIX.map((landform) => ({ kit, landform })),
);

/**
 * The stand a landform cook under this kit must place: the biome's own tree row, drawn with the art
 * the kit ships for that tree (`tree: true` in its `assets.json`). Undefined when the row plants
 * nothing or the kit ships no tree, so the pair is the preset's ground alone.
 */
async function declaredStand(kit: TerrainKit): Promise<string | undefined> {
  const row = ((await starterBiome(kit)).foliage as { species: string; density: number }[])[0];
  if (row === undefined || row.density === 0) return undefined;
  const table = JSON.parse(
    await readFile(new URL(`../starter/${kit}/assets.json`, import.meta.url), "utf8"),
  ) as Record<string, { tree?: boolean }>;
  if (row.species in table) return row.species;
  return Object.keys(table).find((id) => table[id]?.tree === true);
}

describe("every landform under every biome", () => {
  it.each(BIOME_MATRIX)(
    "cooks $landform under $kit",
    async ({ kit, landform }) => {
      const project = await realpath(await makeTempDir("tn-terrain-matrix-"));
      try {
        await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
        await symlink(
          new URL("../../assets/", import.meta.url).pathname,
          join(project, "node_modules", "@threenative", "assets"),
        );
        await symlink(
          new URL("../../procedural-vegetation/", import.meta.url).pathname,
          join(project, "node_modules", "@threenative", "procedural-vegetation"),
        );
        await writeFile(
          join(project, "threenative.config.ts"),
          'export default { assets: { source: "assets" } };',
        );
        const out = join(project, "assets", "worlds", `${kit}-${landform}`);
        // PRD-854 phase 2: this matrix proves the preset's own chain under each kit, so it asks
        // for the procedural ground rather than the survey a preset is grounded on by default.
        const result = JSON.parse(
          await cookKit({ kit, landform, ground: "procedural", out, projectRoot: project }),
        );
        const manifest = JSON.parse(await readFile(join(project, result.worldPackage), "utf8"));
        expect(result.biome).toBe(kit);
        expect(result.triangles).toBeGreaterThan(0);
        expect(result.draws).toBeGreaterThan(0);
        expect(manifest.extent.sizeX).toBe(manifest.extent.sizeZ);
        // A landform preset authors the ground and no scatter rules, so the cook scatters the biome
        // file's own tree on it, in the art the kit ships for that tree (`tree: true`: the CC0 `fir`
        // stands in for the preview's licensed `spruce`). A pair that declares a stand and draws
        // none is a lost stand, not this AC; a kit that ships no tree draws the preset's ground.
        const stand = await declaredStand(kit);
        if (stand === undefined) {
          expect(result.instances).toBe(0);
          expect(manifest.cells).toEqual([]);
        } else {
          expect(result.instances).toBeGreaterThan(0);
          const placed = (manifest.cells as { runs: { asset: string }[] }[]).flatMap((cell) =>
            cell.runs.map((run) => run.asset),
          );
          expect(new Set(placed)).toEqual(new Set([stand]));
          // The player spawns at the world's centre, so no trunk stands on it; the template's arena
          // is deleted, so the forest grows up to it (eight float32 per record, x and z at 0 and 2).
          const bytes = await readFile(
            join(project, dirname(result.worldPackage), manifest.placements),
          );
          const records = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          let nearest = Number.POSITIVE_INFINITY;
          for (let i = 0; i < records.length; i += 8)
            nearest = Math.min(nearest, Math.hypot(records[i] as number, records[i + 2] as number));
          expect(nearest).toBeGreaterThanOrEqual(PLAY_AREA_CLEAR_RADIUS);
          expect(nearest).toBeLessThan(23);
        }
        // The preset's own chain: a starter heightmap crop is what `landform` replaces.
        const recipe = JSON.parse(await readFile(join(project, result.recipeJson), "utf8"));
        expect(recipe.layers.some((entry: { type: string }) => entry.type === "heightmap")).toBe(
          false,
        );
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

// PRD-793 phase 3: a sixth biome is one call — a data folder and a cook, no code edit.
describe("terrain_biome_new", () => {
  it("builds the new spec from the base file and its overrides, validated under the new name", async () => {
    const spec = newBiomeSpec(await starterBiome("forest"), "savanna", {
      landform: "rollingHills",
      seed: 11,
    });
    expect(spec.look).toBe("savanna");
    expect(spec.aliases).toEqual(["savanna"]);
    expect(spec.landform).toBe("rollingHills");
    expect(spec.seed).toBe(11);
    // Everything the overrides did not name is the base's own row, not a default.
    expect(spec.foliage).toEqual((await starterBiome("forest")).foliage);
  });

  it("fails closed on an override the schema does not have, and on a shipped biome's name", async () => {
    const forest = await starterBiome("forest");
    expect(() => newBiomeSpec(forest, "savanna", { moons: 2 })).toThrow(
      /biome field 'moons' is not a field a biome has/,
    );
    expect(() => parseBiomeNewInput({ from: "forest", name: "forest" })).toThrow(
      /'forest' is a shipped biome/,
    );
    for (const name of ["../escape", "Savanna", "sav anna", "1savanna", ""]) {
      expect(() => parseBiomeNewInput({ from: "forest", name })).toThrow(/name must be/);
    }
    expect(() => parseBiomeNewInput({ from: "moon", name: "savanna" })).toThrow(/from must be/);
    expect(() => parseBiomeNewInput({ from: "forest", name: "savanna", overrides: 2 })).toThrow(
      /overrides must be an object/,
    );
  });

  it("removes the biome folder when the cook fails, so the same name can be retried", async () => {
    const project = await realpath(await makeTempDir("tn-terrain-biome-retry-"));
    try {
      await writeFile(
        join(project, "threenative.config.ts"),
        'export default { assets: { source: "assets" } };',
      );
      // No `@threenative/assets` in the project: the cook behind the biome file cannot start.
      const failed = await askServer(project, "terrain_biome_new", {
        from: "forest",
        name: "savanna",
        overrides: { landform: "rollingHills", seed: 11 },
        // PRD-854 phase 2: the retry below cooks the landform, and a real survey needs the network.
        ground: "procedural",
      });
      expect(failed.result?.isError).toBe(true);
      expect(failed.result?.content?.[0]?.text).not.toMatch(/already exists/);
      expect(await stat(join(project, "assets", "biomes", "savanna")).catch(() => null)).toBeNull();
      // The caller fixes the project and calls again with the same name.
      await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
      await symlink(
        new URL("../../assets/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "assets"),
      );
      await symlink(
        new URL("../../procedural-vegetation/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "procedural-vegetation"),
      );
      const retry = await askServer(project, "terrain_biome_new", {
        from: "forest",
        name: "savanna",
        overrides: { landform: "rollingHills", seed: 11 },
        ground: "procedural",
      });
      expect(retry.result?.isError, retry.result?.content?.[0]?.text).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);

  it("makes and cooks a savanna in a game project, touching only its own folders", async () => {
    const project = await realpath(await makeTempDir("tn-terrain-biome-"));
    try {
      await mkdir(join(project, "node_modules", "@threenative"), { recursive: true });
      await symlink(
        new URL("../../assets/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "assets"),
      );
      await symlink(
        new URL("../../procedural-vegetation/", import.meta.url).pathname,
        join(project, "node_modules", "@threenative", "procedural-vegetation"),
      );
      await writeFile(
        join(project, "threenative.config.ts"),
        'export default { assets: { source: "assets" } };',
      );
      const before = await filesUnder(project);
      const forest = await starterBiome("forest");
      // A savanna is data: rolling hills, the forest's grass as the cover, and the same tree made
      // sparse. Nothing here names a biome in code; the file the call writes is the whole biome.
      // The tree is the pack's `fir`: the biome files name the preview's licensed `spruce`, and the
      // kits ship the CC0 fir in its place (starter/coastal/README.md).
      const overrides = {
        landform: "rollingHills",
        seed: 11,
        foliage: [
          {
            ...(forest.foliage as Record<string, unknown>[])[0],
            species: "fir",
            density: 160,
            spacing: [12, 26],
            far: null,
          },
        ],
        grass: [(forest.grass as Record<string, unknown>[])[0]],
        species: [...(forest.species as string[]), "fir"],
        water: [],
      };
      const started = performance.now();
      const response = await askServer(project, "terrain_biome_new", {
        from: "forest",
        name: "savanna",
        overrides,
        // PRD-854 phase 2: the biome's landform is grounded on a real survey by default; this case
        // measures the cook of the preset's own chain, so it asks for procedural ground.
        ground: "procedural",
      });
      const wall = Math.round(performance.now() - started);
      const text = response.result?.content?.[0]?.text;
      expect(response.result?.isError, text).toBe(false);
      const result = JSON.parse(text as string);
      expect(result.biome).toBe("savanna");
      expect(result.biomeJson).toBe("assets/biomes/savanna/biome.data.json");
      expect(result.out).toBe("assets/biomes/savanna/world");
      expect(result.triangles).toBeGreaterThan(0);
      expect(result.bands.elevationRange[1]).toBeGreaterThan(result.bands.elevationRange[0]);
      // PRD-793 phase 3: the biome's own foliage reaches the preset's ground, so this world holds
      // trees and every one of them is a species the starter pack ships art for.
      expect(result.instances).toBeGreaterThan(0);
      const baked = JSON.parse(await readFile(join(project, result.worldPackage), "utf8"));
      const runs = (baked.cells as { runs: { asset: string; count: number }[] }[]).flatMap(
        (cell) => cell.runs,
      );
      const placed = runs.flatMap((run) => Array<string>(run.count).fill(run.asset));
      const pack = Object.keys(
        JSON.parse(
          await readFile(new URL("../starter/forest/assets.json", import.meta.url), "utf8"),
        ) as Record<string, unknown>,
      );
      expect(placed.length).toBe(result.instances);
      expect(new Set(placed)).toEqual(new Set(["fir"]));
      for (const asset of placed) expect(pack).toContain(asset);
      const written = JSON.parse(await readFile(join(project, result.biomeJson), "utf8"));
      expect(written).toMatchObject({
        look: "savanna",
        landform: "rollingHills",
        seed: 11,
        aliases: ["savanna"],
        water: [],
      });
      // The sparse stand and the cover are the base's own rows, thinned and kept; the species are
      // the starter pack's (`fir`, `grass`), so no new art is needed.
      expect(written.foliage[0]).toMatchObject({ species: "fir", density: 160, far: null });
      expect(written.grass[0]).toMatchObject({ species: "grass", density: 1 });
      expect(written.species).toEqual(expect.arrayContaining(["fir", "grass"]));
      // AC-2: every file the call wrote sits under the biome's own folder; no source file changed.
      const after = await filesUnder(project);
      const added = after.filter((file) => !before.includes(file));
      expect(added.length).toBeGreaterThan(0);
      expect(added.filter((file) => !file.startsWith("assets/biomes/savanna/"))).toEqual([]);
      expect(before.filter((file) => !after.includes(file))).toEqual([]);
      // AC-3: the cook stays no slower than the slowest shipped kit. The forest baseline is
      // re-cooked here, back to back with the savanna, so the comparison measures the machine this
      // run is on instead of a number from another session (phase 1: forest 3 839 ms). Both arms are
      // a tool call, so both numbers are a first cook inside a fresh process; an in-process
      // `cookKit` would run already-warmed code from the cooks earlier in this file, not comparable.
      const forestStarted = performance.now();
      // The forest's own river word changes no recipe, so the baseline stays the forest; the reply
      // still names the choice and the word nothing answered to (PRD-854).
      const baseline = await askServer(project, "terrain_generate", {
        kit: "forest",
        request: "a forest with a river and a zeppelin",
        out: "assets/worlds/forest-baseline",
      });
      const forestWall = Math.round(performance.now() - forestStarted);
      const baselineText = baseline.result?.content?.[0]?.text;
      expect(baseline.result?.isError, baselineText).toBe(false);
      const forestCook = JSON.parse(baselineText as string);
      expect(forestCook.decided.water.source).toEqual({ word: "river" });
      expect(forestCook.unused).toEqual(["zeppelin"]);
      console.log(
        `TN_TERRAIN_BIOME_NEW savanna: cook ${result.ms} ms, tool call ${wall} ms; forest baseline cook ${forestCook.ms} ms (tool call ${forestWall} ms)`,
      );
      // One cook per arm on a shared CI runner varies by several percent either way (CI 2026-11-10:
      // savanna 6 026 ms against forest 5 654 ms; locally 3 719 against 4 118), so a strict `<=`
      // failed on noise. A quarter of margin still fails a savanna that is really slower.
      expect(result.ms).toBeLessThanOrEqual(forestCook.ms * 1.25);
      // A second call with the same name refuses instead of overwriting the biome.
      const again = await askServer(project, "terrain_biome_new", {
        from: "forest",
        name: "savanna",
      });
      expect(again.result?.isError).toBe(true);
      expect(again.result?.content?.[0]?.text).toMatch(/already exists/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);
});
