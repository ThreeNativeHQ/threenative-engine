import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstancedMesh, MeshBasicMaterial } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IAssetLoader, createAssetLoader } from "../src/assets.js";
import { type IWorldAsset, type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * A streamed package that names one model under several asset ids, which is what an exporter
 * produces when the same mesh is instanced under 274 object names and the cook maps all of them to
 * one output. The loader is the real one, driven through a manifest that does exactly that mapping,
 * so the resolution the aliasing reads is the resolution the model load would have used.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const committed = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

/** The one cooked url both `pine.glb` and `pine_copy.glb` are compiled to. */
const COOKED = {
  pine: "cooked/pine.glb",
  pineCopy: "cooked/pine.glb",
  pineLod1: "cooked/pine_lod1.glb",
  pineCopyLod1: "cooked/pine_lod1.glb",
  rock: "cooked/rock.glb",
  rockLod1: "cooked/rock_lod1.glb",
} as const;

/** The named asset, failing closed: a package without it is a broken fixture, not a missing entry. */
function committedAsset(name: string): IWorldAsset {
  const asset = committed.assets[name];
  if (asset === undefined || asset.bounds === undefined)
    throw new Error(`The committed package lost ${name}.`);
  return asset;
}

const pine = committedAsset("pine");
const rock = committedAsset("rock");

/**
 * Three definitions, two of them the same model: `pine_copy` is the same pine under a second
 * object name, placed from the record range `ground_cover` used, so the duplicate's placements sit
 * somewhere of their own rather than on top of the original's.
 */
function aliased(copyLodDistance = 60): IWorldPackage {
  return {
    ...committed,
    assets: {
      pine,
      pine_copy: {
        ...pine,
        glb: "assets/pine_copy.glb",
        lods: [{ distance: copyLodDistance, glb: "assets/pine_copy_lod1.glb" }],
      },
      rock,
    },
    cells: committed.cells.map((cell) => ({
      ...cell,
      chunks: [],
      runs: [
        // The record range `ground_cover` used, under the duplicate's name, so the duplicate's
        // placements are somewhere of their own rather than on top of the original's.
        ...cell.runs
          .filter((run) => run.asset === "ground_cover")
          .map((run) => ({ ...run, asset: "pine_copy" })),
        ...cell.runs.filter((run) => run.asset === "pine"),
        ...cell.runs.filter((run) => run.asset === "rock"),
      ],
    })),
  };
}

/** The manifest a cook that mapped every duplicate to one url writes, plus the bytes behind it. */
function stubCookedFetch(
  pkg: IWorldPackage,
  extra: Record<string, string> = {},
): {
  requested: string[];
} {
  const source: Record<string, string> = {
    "cooked/world.json": "world.json",
    "cooked/placements.bin": "placements.bin",
    "cooked/heightmap.u16": "terrain/heightmap.u16",
    [COOKED.pine]: "assets/pine.glb",
    [COOKED.pineLod1]: "assets/pine_lod1.glb",
    [COOKED.rock]: "assets/rock.glb",
    [COOKED.rockLod1]: "assets/rock_lod1.glb",
    ...extra,
  };
  const served = new Map<string, Buffer>();
  for (const [url, file] of Object.entries(source))
    served.set(
      url,
      file === "world.json"
        ? Buffer.from(JSON.stringify(pkg))
        : readFileSync(path.join(fixture, ...(file.split("/") as string[]))),
    );
  const entries: Record<string, { bytes: number; output: string }> = {};
  for (const output of new Set(Object.values(source)))
    entries[output] = { bytes: served.get(output)?.byteLength ?? 0, output };
  for (const [url, output] of Object.entries({
    "world/assets/pine.glb": COOKED.pine,
    "world/assets/pine_copy.glb": COOKED.pineCopy,
    "world/assets/pine_lod1.glb": COOKED.pineLod1,
    "world/assets/pine_copy_lod1.glb": COOKED.pineCopyLod1,
    "world/assets/rock.glb": COOKED.rock,
    "world/assets/rock_lod1.glb": COOKED.rockLod1,
  }))
    entries[url] = { bytes: 0, output };
  entries["world/world.json"] = { bytes: 0, output: "cooked/world.json" };
  entries["world/placements.bin"] = { bytes: 0, output: "cooked/placements.bin" };
  entries[`world/${committed.terrain.heightmap}`] = { bytes: 0, output: "cooked/heightmap.u16" };

  const manifest = Buffer.from(JSON.stringify({ entries, version: 1 }));
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<unknown> => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("assets.manifest.json")) return ok(manifest);
      const bytes = served.get(url);
      return bytes === undefined ? { ok: false, status: 404 } : ok(bytes);
    }),
  );
  return { requested };
}

function ok(buffer: Buffer): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    json: async () => JSON.parse(buffer.toString("utf8")),
  };
}

/** The real loader with its model loads counted, every other member passed straight through. */
function countingLoader(): { assets: IAssetLoader; models: string[] } {
  const inner = createAssetLoader({ basePath: "" });
  const models: string[] = [];
  const assets: IAssetLoader = {
    get compressedTextures() {
      return inner.compressedTextures;
    },
    get progress() {
      return inner.progress;
    },
    get resolved() {
      return inner.resolved;
    },
    audio: (path) => inner.audio(path),
    clear: () => inner.clear(),
    dispose: () => inner.dispose(),
    model: (path) => {
      models.push(path);
      return inner.model(path);
    },
    release: (kind, path) => inner.release(kind, path),
    resolve: (path) => inner.resolve(path),
    texture: (path, options) => inner.texture(path, options),
  };
  return { assets, models };
}

const surface = new MeshBasicMaterial();
const budgets = {
  bytes: 1_000_000_000,
  instances: 1_000_000,
  residentCells: committed.cells.length,
};

function loadWorld(options: Parameters<typeof WorldCells.load>[0]): Promise<WorldCells> {
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    prefetchSeconds: 0,
    ...options,
  });
}

async function flushed(world: WorldCells): Promise<void> {
  for (let pass = 0; pass < 400; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    world.update();
    const stats = world.stats();
    if (stats.admission.backlog === 0 && stats.loadsInFlight === 0 && stats.loadsQueued === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      world.update();
      return;
    }
  }
}

function markers(): string[] {
  return (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("TN_WORLD_ASSET_ALIAS"));
}

function liveMeshes(world: WorldCells): InstancedMesh[] {
  return world.children.filter(
    (child): child is InstancedMesh => child instanceof InstancedMesh && child.count > 0,
  );
}

/** Placements of both pine names in every resident cell — what the canonical's keys must hold. */
function placedIn(pkg: IWorldPackage, world: WorldCells, ids: readonly string[]): number {
  return world.stats().residentKeys.reduce((total, key) => {
    const [x, z] = key.split(":").map(Number);
    const cell = pkg.cells.find((candidate) => candidate.x === x && candidate.z === z);
    return (
      total +
      (cell?.runs ?? [])
        .filter((run) => ids.includes(run.asset))
        .reduce((count, run) => count + run.count, 0)
    );
  }, 0);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells asset aliasing", () => {
  it("batches two names for one cooked model as one asset, one load and one set of keys", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pkg = aliased();
    stubCookedFetch(pkg);
    const { assets, models } = countingLoader();
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadWorld({
      assets,
      budgets,
      follow,
      ring: 1,
      surface,
      url: "world/world.json",
    });
    follow.position.x = -32;
    follow.position.z = -32;
    world.update();
    await flushed(world);

    // The one line the load is worth reading: three named, two real.
    expect(markers()).toEqual(["TN_WORLD_ASSET_ALIAS assets=3 canonical=2"]);
    // The canonical is the lexicographically smallest id of the group, and the duplicate is gone
    // from the state the world refcounts — so it is loaded, keyed and released as one asset.
    expect(Object.keys(world.assetRefCounts()).sort()).toEqual(["pine", "rock"]);
    // One load per level, and the duplicate's own paths are never asked for: its model was the
    // canonical's, so there was nothing to fetch twice.
    expect(models).toEqual([
      "world/assets/pine.glb",
      "world/assets/pine_lod1.glb",
      "world/assets/rock.glb",
      "world/assets/rock_lod1.glb",
    ]);

    // Both names' placements draw from the canonical's keys, and only those.
    const pineRecords = liveMeshes(world)
      .filter((mesh) => mesh.name.startsWith("pine:"))
      .reduce((count, mesh) => count + mesh.count, 0);
    expect(pineRecords).toBe(placedIn(pkg, world, ["pine", "pine_copy"]));
    expect(pineRecords).toBeGreaterThan(0);
    expect(
      liveMeshes(world)
        .map((mesh) => mesh.name)
        .filter((name) => name.includes("copy")),
    ).toEqual([]);
    world.dispose();
  });

  it("keeps two definitions apart when their lod distances differ", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pkg = aliased(90);
    stubCookedFetch(pkg, { "cooked/pine_copy_lod1.glb": "assets/rock_lod1.glb" });
    const { assets, models } = countingLoader();
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadWorld({
      assets,
      budgets,
      follow,
      ring: 1,
      surface,
      url: "world/world.json",
    });
    follow.position.x = -32;
    follow.position.z = -32;
    world.update();
    await flushed(world);

    // The same cooked level-0 url, and a different switch distance: that is a different draw, so
    // three named assets stay three.
    expect(markers()).toEqual(["TN_WORLD_ASSET_ALIAS assets=3 canonical=3"]);
    expect(Object.keys(world.assetRefCounts()).sort()).toEqual(["pine", "pine_copy", "rock"]);
    // Both names' own paths are fetched, because the two are two draws.
    expect(models.filter((path) => path.includes("pine")).sort()).toEqual([
      "world/assets/pine.glb",
      "world/assets/pine_copy.glb",
      "world/assets/pine_copy_lod1.glb",
      "world/assets/pine_lod1.glb",
    ]);
    // And each name keeps its own keys, so neither holds the other's records: a level switch splits
    // a name's placements over `id:0:0` and `id:1:0`, so the family's total is what it placed.
    const live = liveMeshes(world);
    for (const id of ["pine", "pine_copy"]) {
      const drawn = live.filter((mesh) => mesh.name.startsWith(`${id}:`));
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn.reduce((count, mesh) => count + mesh.count, 0)).toBe(placedIn(pkg, world, [id]));
    }
    expect(live.map((mesh) => mesh.name)).toContain("pine_copy:0:0");
    world.dispose();
  });
});
