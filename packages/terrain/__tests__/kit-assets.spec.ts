import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { copyTerrainKit } from "../../create-threenative/src/terrain-kit.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/pack-starter-assets.mjs");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function pack(dir: string) {
  const file = join(dir, "assets.tar.gz");
  await run(process.execPath, [script, file]);
  return { file, bytes: await readFile(file) };
}

let packed: Buffer;
beforeAll(async () => {
  const directory = await makeTempDir("tn-terrain-pack-");
  try {
    packed = (await pack(directory)).bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

async function installed(bytes = packed) {
  const dir = await makeTempDir("tn-terrain-archive-");
  const archive = { file: join(dir, "assets.tar.gz"), bytes };
  await writeFile(archive.file, bytes);
  await mkdir(join(dir, "dist"));
  await copyFile(join(root, "dist/kit.js"), join(dir, "dist/kit.js"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@threenative/terrain",
      type: "module",
      exports: { "./package.json": "./package.json" },
    }),
  );
  const manifest = {
    version: "0.1.0",
    url: "https://invalid.test/assets",
    sha256: sha(archive.bytes),
    bytes: archive.bytes.length,
  };
  await writeFile(join(dir, "starter-assets.json"), JSON.stringify(manifest));
  vi.stubEnv("XDG_CACHE_HOME", join(dir, "cache"));
  vi.stubEnv("THREENATIVE_TERRAIN_ASSETS_URL", pathToFileURL(archive.file).href);
  const module = await import(pathToFileURL(join(dir, "dist/kit.js")).href);
  return {
    dir,
    archive,
    manifest,
    resolve: module.starterAssetsDir as () => Promise<string>,
    bake: module.bakeKit as (url: string, options: { sky: string }) => Promise<void>,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pinned starter assets", () => {
  it("packs identically twice and matches the committed manifest", async () => {
    const first = { bytes: packed };
    const second = await pack(await makeTempDir("tn-terrain-pack-"));
    expect(first.bytes.equals(second.bytes)).toBe(true);
    const manifest = JSON.parse(await readFile(join(root, "starter-assets.json"), "utf8"));
    expect(manifest.sha256).toBe(sha(first.bytes));
    expect(manifest.bytes).toBe(first.bytes.length);
    // The pack version is its own: a package release with unchanged bytes keeps the pinned URL.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.url).toBe(
      `https://github.com/ThreeNativeHQ/threenative-engine/releases/download/terrain-starter-assets-sha256-${manifest.sha256}/terrain-starter-assets-${manifest.version}.tar.gz`,
    );
    expect(first.bytes.readUInt32LE(4)).toBe(0);
  }, 30_000);

  it("extracts a file archive and reuses the cache without reading it again", async () => {
    const fixture = await installed();
    const cache = await fixture.resolve();
    expect(cache).toBe(
      join(fixture.dir, "cache/threenative/terrain-starter-assets", fixture.manifest.sha256),
    );
    expect(
      (await readFile(join(cache, "fir_tree_01/fir-b-lod2.glb"))).equals(
        await readFile(join(root, "starter-assets/fir_tree_01/fir-b-lod2.glb")),
      ),
    ).toBe(true);
    expect(await readFile(join(cache, "credits.json"))).toEqual(
      await readFile(join(root, "starter-assets/credits.json")),
    );
    await rm(fixture.archive.file);
    expect(await fixture.resolve()).toBe(cache);
    expect((await readdir(join(cache, ".."))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  }, 30_000);

  it("bakes a scaffolded forest kit using the file archive with no bundled assets", async () => {
    const fixture = await installed();
    const game = join(fixture.dir, "game");
    const kit = join(fixture.dir, "template-assets/terrain/forest");
    await cp(join(root, "starter/forest"), kit, { recursive: true });
    await copyFile(join(root, "starter-assets/credits.json"), join(kit, "credits.json"));
    await copyTerrainKit("forest", game, join(fixture.dir, "templates"));
    await fixture.bake(pathToFileURL(join(game, "bake.mjs")).href, {
      sky: "hdri/kloofendal_48d_partly_cloudy_1k.hdr",
    });
    expect(JSON.parse(await readFile(join(game, "recipe.json"), "utf8"))).toHaveProperty("recipe");
    expect(
      (await readFile(join(game, "world/models/fir-b-lod1.glb"))).equals(
        await readFile(join(root, "starter-assets/fir_tree_01/fir-b-lod1.glb")),
      ),
    ).toBe(true);
    expect(
      (await readFile(join(game, "world/sky.hdr"))).equals(
        await readFile(join(root, "starter-assets/hdri/kloofendal_48d_partly_cloudy_1k.hdr")),
      ),
    ).toBe(true);
  }, 30_000);

  it("downloads once over HTTP and then uses the cache", async () => {
    const fixture = await installed();
    vi.stubEnv("THREENATIVE_TERRAIN_ASSETS_URL", "https://invalid.test/archive");
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(packed)));
    vi.stubGlobal("fetch", fetch);
    const cache = await fixture.resolve();
    expect(await fixture.resolve()).toBe(cache);
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("prefers workspace assets without fetching", async () => {
    const fixture = await installed();
    await mkdir(join(fixture.dir, "starter-assets"));
    await rm(fixture.archive.file);
    expect(await fixture.resolve()).toBe(join(fixture.dir, "starter-assets"));
  }, 30_000);

  it("rejects a SHA mismatch before extraction", async () => {
    const fixture = await installed();
    fixture.manifest.sha256 = "0".repeat(64);
    await writeFile(join(fixture.dir, "starter-assets.json"), JSON.stringify(fixture.manifest));
    await expect(fixture.resolve()).rejects.toThrow("TN_TERRAIN_ASSETS_SHA256");
    await expect(readdir(join(fixture.dir, "cache"))).rejects.toThrow();
  }, 30_000);

  it("rejects a size mismatch before extraction", async () => {
    const fixture = await installed();
    fixture.manifest.bytes += 1;
    await writeFile(join(fixture.dir, "starter-assets.json"), JSON.stringify(fixture.manifest));
    await expect(fixture.resolve()).rejects.toThrow("TN_TERRAIN_ASSETS_SIZE");
  }, 30_000);

  it("names HTTP failures", async () => {
    const fixture = await installed();
    vi.stubEnv("THREENATIVE_TERRAIN_ASSETS_URL", "https://invalid.test/archive");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fixture.resolve()).rejects.toThrow("TN_TERRAIN_ASSETS_HTTP: 404");
  }, 30_000);

  it.each(["starter-assets/../escaped", "/escaped", "starter-assets/link"])(
    "rejects unsafe archive entry %s atomically",
    async (name) => {
      const tar = gunzipSync(packed);
      tar.fill(0, 0, 100);
      tar.write(name, 0, 100);
      if (name.endsWith("link")) tar[156] = 50;
      tar.fill(32, 148, 156);
      const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      tar.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
      const fixture = await installed(gzipSync(tar, { level: 9 }));
      await expect(fixture.resolve()).rejects.toThrow(
        name.endsWith("link") ? "TN_TERRAIN_ASSETS_TYPE" : "TN_TERRAIN_ASSETS_PATH",
      );
      expect(await readdir(join(fixture.dir, "cache/threenative/terrain-starter-assets"))).toEqual(
        [],
      );
      await expect(readFile(join(fixture.dir, "escaped"))).rejects.toThrow();
    },
    30_000,
  );
});

it("every starter asset directory has a kit or example reference", async () => {
  const references: string[] = [];
  for (const kit of await readdir(join(root, "starter"))) {
    for (const file of ["assets.json", "surface.json", "bake.mjs"])
      references.push(await readFile(join(root, "starter", kit, file), "utf8"));
  }
  async function source(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await source(join(dir, entry.name));
      else if (/\.(ts|mjs)$/u.test(entry.name))
        references.push(await readFile(join(dir, entry.name), "utf8"));
    }
  }
  await source(join(root, "../../examples/strata-terrain-preview/src"));
  const dirs = (await readdir(join(root, "starter-assets"), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  expect(dirs.length).toBeGreaterThan(0);
  for (const dir of dirs)
    expect(
      references.some((text) => text.includes(`${dir.name}/`)),
      `${dir.name} has no asset reference`,
    ).toBe(true);
});
