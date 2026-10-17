import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { copyTerrainKit } from "../src/terrain-kit.js";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const templates = path.join(packageRoot, "templates");
const staged = path.join(packageRoot, "template-assets", "terrain");
const starter = fileURLToPath(new URL("../../terrain/starter", import.meta.url));
const KITS = ["alpine", "coastal", "desert", "forest", "tundra"];
const INPUTS = ["assets.json", "bake.mjs", "heightmap.r16", "recipe.json", "surface.json"];
const COPIED = [...INPUTS, "credits.json"].sort();
const SKY_HDRI = "hdri/kloofendal_48d_partly_cloudy_1k.hdr";
const starterCredits = fileURLToPath(
  new URL("../../terrain/starter-assets/credits.json", import.meta.url),
);

async function scratch(): Promise<string> {
  return makeTempDir("terrain-kit-");
}

// Declared credits for a test. It names no provider and is not a provenance record.
function fixtureCredits(kit: string): string {
  return `${JSON.stringify({ kit, note: "Test stand-in. Not a provenance record.", sets: {}, prepared: { assets: [] } }, null, 2)}\n`;
}

// Per-test packaged kits. Each kit copies the original starter inputs and declares a credits file.
async function packagedKits(root: string, kits: readonly string[]): Promise<string> {
  for (const kit of kits) {
    const kitDir = path.join(root, "template-assets", "terrain", kit);
    await mkdir(kitDir, { recursive: true });
    for (const file of INPUTS)
      await copyFile(path.join(starter, kit, file), path.join(kitDir, file));
    await writeFile(path.join(kitDir, "credits.json"), fixtureCredits(kit));
  }
  return path.join(root, "templates");
}

async function expectStarterBytes(target: string, kit: string): Promise<void> {
  for (const file of INPUTS) {
    expect(await readFile(path.join(target, file))).toEqual(
      await readFile(path.join(starter, kit, file)),
    );
  }
}

describe("terrain kit staged integration", () => {
  beforeAll(async () => {
    await run(process.execPath, [path.join(packageRoot, "scripts", "stage-terrain-kits.mjs")]);
  }, 120_000);

  it("stages the five inputs and one credits record per starter kit, byte-identical", async () => {
    expect((await readdir(staged)).sort()).toEqual(KITS);
    for (const kit of KITS) {
      expect((await readdir(path.join(staged, kit))).sort()).toEqual(COPIED);
      for (const file of INPUTS) {
        expect(await readFile(path.join(staged, kit, file))).toEqual(
          await readFile(path.join(starter, kit, file)),
        );
      }
    }
  });

  it("keeps only the sets and props each kit's own tables cite", async () => {
    const alpine = JSON.parse(await readFile(path.join(staged, "alpine", "credits.json"), "utf8"));
    const coastal = JSON.parse(
      await readFile(path.join(staged, "coastal", "credits.json"), "utf8"),
    );
    expect(Object.keys(alpine.sets).sort()).toEqual([
      "forest_ground_04",
      "rock_boulder_dry",
      "snow_02",
    ]);
    expect(new Set(alpine.prepared.assets.map((asset: { url: string }) => asset.url))).toEqual(
      new Set(["https://polyhaven.com/a/boulder_01"]),
    );
    expect(coastal.prepared.assets.map((asset: { url: string }) => asset.url)).toContain(
      "https://polyhaven.com/a/fir_tree_01",
    );
  });

  it("cites the sky HDRI record in every kit, deep-equal to its starter-assets record", async () => {
    const source = JSON.parse(await readFile(starterCredits, "utf8"));
    const record = source.files.find((entry: { file: string }) => entry.file === SKY_HDRI);
    expect(record, SKY_HDRI).toBeDefined();
    for (const kit of KITS) {
      const credits = JSON.parse(await readFile(path.join(staged, kit, "credits.json"), "utf8"));
      const cited = credits.files.filter((entry: { file: string }) => entry.file === SKY_HDRI);
      expect(cited, kit).toEqual([record]);
    }
  });

  it("copies only the requested kit, byte-identical to its staged files", async () => {
    const target = path.join(await scratch(), "terrain", "alpine");
    await copyTerrainKit("alpine", target, templates);
    expect((await readdir(target)).sort()).toEqual(COPIED);
    for (const file of COPIED) {
      expect(await readFile(path.join(target, file))).toEqual(
        await readFile(path.join(staged, "alpine", file)),
      );
    }
  });

  it("ships the staged kits in the packed tarball, and copies one from the packed install", async () => {
    const archives = path.join(await scratch(), "archive");
    await mkdir(archives, { recursive: true });
    await run("pnpm", ["pack", "--pack-destination", archives], { cwd: packageRoot });
    const archive = (await readdir(archives)).find((entry) => entry.endsWith(".tgz"));
    if (archive === undefined) throw new Error("create-threenative pack produced no tarball");
    await run("tar", [
      "-xzf",
      path.join(archives, archive),
      "-C",
      archives,
      "package/template-assets/terrain",
    ]);
    const packed = path.join(archives, "package", "template-assets", "terrain");
    expect((await readdir(packed)).sort()).toEqual(KITS);
    for (const kit of KITS) {
      expect((await readdir(path.join(packed, kit))).sort()).toEqual(COPIED);
      for (const file of INPUTS) {
        expect(await readFile(path.join(packed, kit, file))).toEqual(
          await readFile(path.join(starter, kit, file)),
        );
      }
    }

    // The consumer sits outside this workspace; its only create-threenative is the tarball.
    const consumer = await scratch();
    const installed = path.join(consumer, "node_modules", "create-threenative");
    await mkdir(installed, { recursive: true });
    await run("tar", [
      "-xzf",
      path.join(archives, archive),
      "-C",
      installed,
      "--strip-components=1",
    ]);
    const script = path.join(consumer, "copy-kit.mjs");
    await writeFile(
      script,
      'import { copyTerrainKit } from "create-threenative/terrain-kit";\nawait copyTerrainKit("alpine", process.argv[2]);\n',
    );
    const target = path.join(consumer, "kit");
    await run(process.execPath, [script, target], { cwd: consumer });
    expect((await readdir(target)).sort()).toEqual(COPIED);
    for (const file of COPIED) {
      expect(await readFile(path.join(target, file))).toEqual(
        await readFile(path.join(packed, "alpine", file)),
      );
    }
  }, 300_000);
});

describe("terrain kit copying", () => {
  it.each(KITS)("copies %s byte-identical to its packaged inputs", async (kit) => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, [kit]);
    const target = path.join(root, "kit");
    await copyTerrainKit(kit, target, templatesRoot);
    expect((await readdir(target)).sort()).toEqual(COPIED);
    await expectStarterBytes(target, kit);
    expect(await readFile(path.join(target, "credits.json"))).toEqual(
      await readFile(path.join(root, "template-assets", "terrain", kit, "credits.json")),
    );
  });

  it("copies only the requested kit when all five are packaged", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, KITS);
    const target = path.join(root, "kit");
    await copyTerrainKit("desert", target, templatesRoot);
    expect((await readdir(target)).sort()).toEqual(COPIED);
    await expectStarterBytes(target, "desert");
  });

  it("copies no world files, asset binaries or sibling files", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const kitDir = path.join(root, "template-assets", "terrain", "alpine");
    for (const sibling of ["world.ts", "sky.ts", "README.md"]) {
      await copyFile(path.join(starter, "alpine", sibling), path.join(kitDir, sibling));
    }
    await mkdir(path.join(kitDir, "assets"));
    await writeFile(path.join(kitDir, "assets", "rock.bin"), Buffer.from([0, 1, 2, 3]));
    const target = path.join(root, "kit");
    await copyTerrainKit("alpine", target, templatesRoot);
    expect((await readdir(target)).sort()).toEqual(COPIED);
  });

  it.each(["", "../alpine", "alpine/../coastal", "/alpine", "Alpine", "alpine.bak", "missing"])(
    "rejects kit name %j and writes nothing",
    async (kit) => {
      const root = await scratch();
      const templatesRoot = await packagedKits(root, ["alpine"]);
      const target = path.join(root, "kit");
      await expect(copyTerrainKit(kit, target, templatesRoot)).rejects.toThrow(
        /TN_TERRAIN_KIT_NAME/u,
      );
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a name that climbs out of the packaged terrain root", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    // A complete decoy beside the terrain root. Without the name check, "../alpine" would copy it.
    await cp(
      path.join(root, "template-assets", "terrain", "alpine"),
      path.join(root, "template-assets", "alpine"),
      {
        recursive: true,
      },
    );
    const target = path.join(root, "kit");
    await expect(copyTerrainKit("../alpine", target, templatesRoot)).rejects.toThrow(
      /TN_TERRAIN_KIT_NAME/u,
    );
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when no kit is packaged", async () => {
    const target = path.join(await scratch(), "kit");
    const root = path.join(await scratch(), "templates");
    await expect(copyTerrainKit("alpine", target, root)).rejects.toThrow(/TN_TERRAIN_KIT_UNKNOWN/u);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing target", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const target = path.join(root, "kit");
    await mkdir(target);
    await writeFile(path.join(target, "recipe.json"), "mine");
    await expect(copyTerrainKit("alpine", target, templatesRoot)).rejects.toThrow(
      /TN_TERRAIN_KIT_EXISTS/u,
    );
    expect(await readdir(target)).toEqual(["recipe.json"]);
    expect(await readFile(path.join(target, "recipe.json"), "utf8")).toBe("mine");
  });

  it("rejects a symlink target and writes nothing through it", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const real = path.join(root, "real");
    await mkdir(real);
    const target = path.join(root, "kit");
    await symlink(real, target, "dir");
    await expect(copyTerrainKit("alpine", target, templatesRoot)).rejects.toThrow(
      /TN_TERRAIN_KIT_SYMLINK/u,
    );
    expect(await readdir(real)).toEqual([]);
  });

  it("rejects a target under a symlinked parent and writes nothing through it", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const real = path.join(root, "real");
    await mkdir(real);
    await symlink(real, path.join(root, "link"), "dir");
    const target = path.join(root, "link", "kit");
    await expect(copyTerrainKit("alpine", target, templatesRoot)).rejects.toThrow(
      /TN_TERRAIN_KIT_SYMLINK/u,
    );
    expect(await readdir(real)).toEqual([]);
  });

  it("rejects a symlink above missing parents and creates no folders through it", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const real = path.join(root, "real");
    await mkdir(real);
    await symlink(real, path.join(root, "link"), "dir");
    const target = path.join(root, "link", "missing", "deeper", "kit");
    await expect(copyTerrainKit("alpine", target, templatesRoot)).rejects.toThrow(
      /TN_TERRAIN_KIT_SYMLINK/u,
    );
    expect(await readdir(real)).toEqual([]);
  });

  it("rejects a packaged input that is a symlink", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const kitDir = path.join(root, "template-assets", "terrain", "alpine");
    await rm(path.join(kitDir, "recipe.json"));
    await symlink(path.join(starter, "alpine", "recipe.json"), path.join(kitDir, "recipe.json"));
    const target = path.join(root, "kit");
    await expect(copyTerrainKit("alpine", target, templatesRoot)).rejects.toThrow(
      /TN_TERRAIN_KIT_SOURCE/u,
    );
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes a raw target that climbs through a symlink, and writes nothing outside it", async () => {
    const root = await scratch();
    const templatesRoot = await packagedKits(root, ["alpine"]);
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "inner"), { recursive: true });
    await symlink(path.join(outside, "inner"), path.join(root, "link"), "dir");
    // Raw string on purpose. path.join would normalize the ".." before the call.
    const target = `${root}/link/../kit`;
    await copyTerrainKit("alpine", target, templatesRoot);
    expect((await readdir(path.join(root, "kit"))).sort()).toEqual(COPIED);
    expect(await readdir(outside)).toEqual(["inner"]);
    expect(await readdir(path.join(outside, "inner"))).toEqual([]);
  });
});
