import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IWorldPackage, validateWorldPackage } from "@threenative/core/world";
import { Terrain, decodeRAW16 } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const starterAssets = join(packageRoot, "starter-assets");

// Manifest hashes include placementIds; terrain and prop payload hashes stay pinned.
const GOLDEN_HASHES: Record<string, Record<string, string>> = {
  forest: {
    "world.glb": "f5989ec1c806b04c24d06d6324d8be5c7b27d0bf63c569013e21b5b9188793a4",
    "heightmap.u16": "33b3fc66f63ca4df76531a44a2bd84e1aff6f642eb9ab0c6622ebe87d1057c2f",
    "placements.bin": "043726102f486d212b8441293ccbc0f862278c9f457abcc7b99341141f58433f",
    "splat.rgba": "0ba7d09157e6f4d4cb894a35152be0c05098417b88d68175cfbe6b4ff7c41364",
    "world.json": "538ad4e2469e140b86b52b48f435c5e81e5d7d3c8f4bd581e6e3dc9e515e00a6",
  },
  alpine: {
    "heightmap.u16": "bd84cb6c52a1142303dfb0f304190a981f29d77d118d3880e3eb246549838ae1",
    "placements.bin": "5c47dd59619843bc056fbc8391ca7bccdef86c9950cd192c53a6928676865c26",
    "splat.rgba": "fde8bf22c6841847f58ab523682f29e77a774a364cdd0e34c0025b6ad06c6f42",
    "world.json": "48a504fb9764b279fb83646e723542e65efdf0fe5b0429113a3932029afc3b6d",
  },
  coastal: {
    "heightmap.u16": "313539bae3010b949b65e55307736f6140a55255d81fbb8ab5dbae782bdc8482",
    "placements.bin": "e10721cc99dfe96345a6b090eeb834ec87890927d8272ec8a8307b31a989b098",
    "splat.rgba": "b3dcb6967095049a05fa113968b3cd8d74914c7b906f2c522ff109f6dbfe2b40",
    "world.json": "c8a8400859b8b704c1d6772df3552d8518d9ba119f4532ca2ecfb595648d701f",
  },
  desert: {
    "heightmap.u16": "a17965c4dd706f2732cc64af64dba086e006b405086d41a36f2ca37c45ee3add",
    "placements.bin": "8dace58d5c91d50f8492149a826575edbff53d3ee78e5d892bbb12d8f809f3fe",
    "splat.rgba": "a77791af98c157f371dfa1fdc053c712ea3bdb8a9f3f71de33a69b8f06c88d04",
    "world.json": "e9836d3a9920f14c8b94a7294657b588d20465a3c3309b33bc25d595713c2d9a",
  },
  tundra: {
    "heightmap.u16": "2fcf74db51407bcd4e65b7ae92e31da6ff1b0c7152301952fecedeea36c80710",
    "placements.bin": "05aa8931ff15b96d21999947ca2c5fdb89fe2b0e17228d8f072021767b55a9ff",
    "splat.rgba": "981bd12869273d4f959fcaed53b27b325b5748b7ec558ac25c4258b4fd5c9f07",
    "world.json": "4c0a82d265a73d7f0af9dc67b3cd58229ba0c587edd9c66ddd01c2a2828fb8dc",
  },
};

/** SHA256 of each kit's inline heights and evaluated height grid at e12a5d578, as Float32 bytes. */
const BASELINE_HEIGHTS: Record<string, { values: string; evaluated: string }> = {
  forest: {
    values: "46e9bdddaae82a29f770358e51f282486b41d0cab268a25bd58ba885c70a5ed8",
    evaluated: "16db2efbc4f44fa016a69f8240ae5bf9ce92f15070ea67d436e575cea02ad55f",
  },
  alpine: {
    values: "72995391d8244365e32f8d8c38f80c04e6ec948b819918876d1f5d6eeed66c81",
    evaluated: "5000eea008516889508c4efc0074bb8a36c41a0c5e0f1484c3c667d60644fc1c",
  },
  coastal: {
    values: "726595506d7dda30da88401b74c878375bcb40d88cef0debb4a10f27f47a2d17",
    evaluated: "020ce3ba6dadb740886941287303c7ab37e53da2143cfcea3072eb197c934feb",
  },
  desert: {
    values: "b0f471e65576313f26f98e456323c4c6eb6c4e688c931e4cafc2c66663abce85",
    evaluated: "86740e21dad3412d21524d1c85e85d5106d05eccc6e66f010ffd8168d1cdda54",
  },
  tundra: {
    values: "3fbcbc21b23e03a1c89d8ce0ccc2c8b93380973304e4be7662bc23185a706b58",
    evaluated: "3c8e91abeacbd4469974513812c1ffc1703064808ba9facd1dbfb63a59fbdc62",
  },
};

interface ITable {
  readonly base: { id: string };
  readonly layers: readonly { id: string }[];
  readonly splat: { masks: Record<string, [number, string]> };
  readonly textures: string;
}

/** The lake and river the bake writes beside the world, for the game to draw. */
interface IKitWater {
  readonly lakes: readonly { id: string; at: number[]; radius: number; level: number }[];
  readonly rivers: readonly { id: string; width: number; points: number[][] }[];
}

/** Copies the named kit into a temp directory whose node_modules resolves the workspace packages. */
function kitInTempDir(kitName = "forest"): string {
  const dir = makeTempDirSync(`terrain-starter-kit-${kitName}-`);
  const kit = join(packageRoot, "starter", kitName);
  for (const name of ["bake.mjs", "recipe.json", "assets.json", "surface.json", "heightmap.r16"])
    copyFileSync(join(kit, name), join(dir, name));
  mkdirSync(join(dir, "node_modules", "@threenative"), { recursive: true });
  symlinkSync(packageRoot, join(dir, "node_modules", "@threenative", "terrain"), "dir");
  // forest/bake.mjs imports the cook from @threenative/assets, so the fixture links this checkout's.
  symlinkSync(
    join(packageRoot, "..", "assets"),
    join(dir, "node_modules", "@threenative", "assets"),
    "dir",
  );
  return dir;
}

function bake(out: string, kitName = "forest"): { files: Map<string, string>; total: number } {
  const dir = kitInTempDir(kitName);
  execFileSync(process.execPath, ["bake.mjs", "--assets", starterAssets, "--out", out], {
    cwd: dir,
    stdio: "pipe",
  });
  const files = new Map<string, string>();
  let total = 0;
  for (const path of readdirSync(out, { recursive: true })) {
    const name = String(path);
    const full = join(out, name);
    if (!statSync(full).isFile()) continue;
    const bytes = readFileSync(full);
    total += bytes.byteLength;
    files.set(name, createHash("sha256").update(bytes).digest("hex"));
  }
  return { files, total };
}

describe("forest starter kit", () => {
  it("bakes a world package the engine's validator accepts, deterministically", () => {
    const out = join(makeTempDirSync("terrain-starter-world-"), "world");
    const { files, total } = bake(out);
    const manifest = JSON.parse(readFileSync(join(out, "world.json"), "utf8")) as IWorldPackage;
    const result = validateWorldPackage(manifest, {
      heightmapByteLength: readFileSync(join(out, manifest.terrain.heightmap)).byteLength,
      placementsByteLength: readFileSync(join(out, manifest.placements)).byteLength,
    });
    expect(result.errors).toEqual([]);

    expect(manifest.terrain.columns).toBe(257);
    expect(manifest.extent.sizeX).toBe(512);
    const perAsset: Record<string, number> = {};
    for (const cell of manifest.cells)
      for (const run of cell.runs) perAsset[run.asset] = (perAsset[run.asset] ?? 0) + run.count;
    expect(perAsset.fir).toBeGreaterThanOrEqual(2000);
    expect(perAsset.boulder).toBe(320);
    expect(Object.keys(perAsset).sort()).toEqual([
      "boulder",
      "fern-a",
      "fern-b",
      "fir",
      "fir-c",
      "stone-a",
      "stone-b",
    ]);
    // The combined and streamed representations are alternatives, not additive.
    const combinedBytes = statSync(join(out, "world.glb")).size;
    expect(combinedBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(total - combinedBytes).toBeLessThanOrEqual(25 * 1024 * 1024);

    // Pinned golden hashes for starter-kit forest bake (PRD-592 AC-1)
    expect(files.get("heightmap.u16")).toBe(
      "33b3fc66f63ca4df76531a44a2bd84e1aff6f642eb9ab0c6622ebe87d1057c2f",
    );
    expect(files.get("placements.bin")).toBe(
      "043726102f486d212b8441293ccbc0f862278c9f457abcc7b99341141f58433f",
    );
    expect(files.get("splat.rgba")).toBe(
      "0ba7d09157e6f4d4cb894a35152be0c05098417b88d68175cfbe6b4ff7c41364",
    );
    expect(files.get("world.json")).toBe(
      "538ad4e2469e140b86b52b48f435c5e81e5d7d3c8f4bd581e6e3dc9e515e00a6",
    );

    // One recipe and seed, one package: a second bake is byte-identical.
    const second = bake(join(makeTempDirSync("terrain-starter-world-"), "world"));
    expect([...second.files].sort()).toEqual([...files].sort());
  });

  it.each(["forest", "alpine", "coastal", "desert", "tundra"] as const)(
    "produces pinned golden baseline hashes for %s kit bake (PRD-592 AC-1)",
    (kitName) => {
      const out = join(makeTempDirSync(`terrain-starter-world-${kitName}-`), "world");
      const { files } = bake(out, kitName);
      const expected = GOLDEN_HASHES[kitName] ?? {};
      expect.assertions(Object.keys(expected).length);
      for (const [file, hash] of Object.entries(expected)) {
        expect(files.get(file), `${kitName} ${file} hash mismatch`).toBe(hash);
      }
    },
  );

  it.each(["forest", "alpine", "coastal", "desert", "tundra"] as const)(
    "hydrates the %s RAW16 sidecar to the original inline heights, bit for bit (PRD-589 AC-2)",
    (kitName) => {
      const kit = join(packageRoot, "starter", kitName);
      expect(statSync(join(kit, "recipe.json")).size).toBeLessThan(200_000);
      const current = JSON.parse(readFileSync(join(kit, "recipe.json"), "utf8"));
      const data = current.recipe.layers[0].params.data;
      // Decode the sidecar exactly as bake.mjs does, from the path the recipe names.
      const sidecar = readFileSync(join(kit, data.raw16));
      expect(sidecar.byteLength).toBe(132098);
      // The same rounding as the bake loader: each decoded float returns to the 0.1 m lattice.
      data.values = Array.from(
        decodeRAW16(sidecar, data).values,
        (value) => Math.round(value * 10) / 10,
      );

      // Equal Float32 bytes mean no height moved, not even by one unit in the last place.
      const digest = (heights: ArrayLike<number>) =>
        createHash("sha256")
          .update(new Uint8Array(Float32Array.from(heights).buffer))
          .digest("hex");
      const pinned = BASELINE_HEIGHTS[kitName];
      expect(digest(data.values)).toBe(pinned?.values);
      expect(digest(Terrain.fromJSON(current.recipe).evaluate().height)).toBe(pinned?.evaluated);
    },
  );

  it("writes every model and texture its manifest and table name", () => {
    const out = join(makeTempDirSync("terrain-starter-world-"), "world");
    bake(out);
    const manifest = JSON.parse(readFileSync(join(out, "world.json"), "utf8")) as IWorldPackage;
    const tablePath = manifest.terrain.layers?.table;
    if (tablePath === undefined) throw new Error("The manifest names no terrain table");
    const table = JSON.parse(readFileSync(join(out, tablePath), "utf8")) as ITable;

    const named = [
      manifest.terrain.heightmap,
      manifest.placements,
      ...(manifest.terrain.layers === undefined ? [] : Object.values(manifest.terrain.layers)),
      ...Object.values(manifest.assets).flatMap((asset) => [
        asset.glb,
        ...(asset.lods ?? []).map((lod) => lod.glb),
      ]),
    ];
    for (const layer of [table.base, ...table.layers]) {
      expect(Object.keys(table.splat.masks)).toContain(layer.id);
      named.push(`${table.textures}/${layer.id}_diff.jpg`, `${table.textures}/${layer.id}_nrm.jpg`);
    }
    named.push("sky.hdr");
    for (const name of named) {
      // Local by construction: a package-relative path, never a scheme or a root.
      expect(name, `${name} is not package-relative`).not.toMatch(/^(\/|[a-z][a-z0-9+.-]*:)/iu);
      const path = join(out, name);
      expect(() => readFileSync(path), `${name} is missing from the baked package`).not.toThrow();
    }
    // Every model carries its own images: a GLB's JSON chunk names no external uri.
    for (const name of named.filter((file) => file.endsWith(".glb"))) {
      const glb = readFileSync(join(out, name));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
        images?: { uri?: string }[];
        buffers?: { uri?: string }[];
      };
      const uris = [...(json.images ?? []), ...(json.buffers ?? [])].flatMap((entry) =>
        entry.uri === undefined ? [] : [entry.uri],
      );
      expect(uris, `${name} references files outside itself`).toEqual([]);
    }
  });

  it("bakes the lake and river the game draws, at the generator's own level and course", () => {
    const out = join(makeTempDirSync("terrain-starter-water-"), "world");
    bake(out);
    const water = JSON.parse(readFileSync(join(out, "water.json"), "utf8")) as IKitWater;
    expect(water.lakes).toEqual([{ id: "lake", at: [-70, 25], radius: 105, level: 13.3 }]);
    expect(water.rivers).toHaveLength(1);
    expect(water.rivers[0]?.points.length).toBeGreaterThan(10);
    expect(water.rivers[0]?.width).toBeGreaterThan(0);
  });

  it("ships kit source and pinned asset metadata without binaries or generated worlds", () => {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as { size: number; files: { path: string; size: number }[] }[];
    const packedFiles = packed[0]?.files ?? [];
    const files = new Map(packedFiles.map((file) => [file.path, file.size]));
    for (const path of [
      "starter/forest/recipe.json",
      "starter/forest/assets.json",
      "starter/forest/surface.json",
      "starter/forest/bake.mjs",
      "starter/forest/world.ts",
      "starter/forest/water.ts",
      "starter/forest/sky.ts",
      "starter/alpine/recipe.json",
      "starter/alpine/assets.json",
      "starter/alpine/surface.json",
      "starter/alpine/bake.mjs",
      "starter/alpine/world.ts",
      "starter/alpine/sky.ts",
      "starter/desert/recipe.json",
      "starter/desert/assets.json",
      "starter/desert/surface.json",
      "starter/desert/bake.mjs",
      "starter/desert/world.ts",
      "starter/desert/sky.ts",
      "starter/tundra/recipe.json",
      "starter/tundra/assets.json",
      "starter/tundra/surface.json",
      "starter/tundra/bake.mjs",
      "starter/tundra/world.ts",
      "starter/tundra/sky.ts",
      "starter/tundra/water.ts",
      "starter/coastal/recipe.json",
      "starter/coastal/assets.json",
      "starter/coastal/surface.json",
      "starter/coastal/bake.mjs",
      "starter/coastal/world.ts",
      "starter/coastal/sky.ts",
      "starter/coastal/sea.ts",
      "starter-assets.json",
      "starter-credits.json",
      "THIRD_PARTY_NOTICES.md",
      ...["forest", "alpine", "desert", "tundra", "coastal"].map(
        (kit) => `starter/${kit}/heightmap.r16`,
      ),
    ])
      expect(files.has(path), `packed tarball is missing ${path}`).toBe(true);
    expect(packedFiles.some((file) => file.path.startsWith("starter-assets/"))).toBe(false);
    expect(packedFiles.some((file) => /^starter\/[^/]+\/world\//u.test(file.path))).toBe(false);
    expect(packed[0]?.size).toBeLessThan(2_000_000);
    const archive = JSON.parse(readFileSync(join(packageRoot, "starter-assets.json"), "utf8"));
    expect(archive.bytes).toBeGreaterThan(0);
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
    console.log(`starter asset archive: ${archive.bytes} B; ${archive.sha256}`);
    expect(readFileSync(join(packageRoot, "starter-credits.json"))).toEqual(
      readFileSync(join(starterAssets, "credits.json")),
    );
  });

  it.each(["forest", "alpine", "coastal", "desert", "tundra"] as const)(
    "refuses a bare, empty or flag-valued --out/--assets before writing (%s)",
    (kitName) => {
      const dir = makeTempDirSync(`terrain-starter-flags-${kitName}-`);
      const bakeWith = (...args: string[]) =>
        execFileSync(
          process.execPath,
          [join(packageRoot, "starter", kitName, "bake.mjs"), ...args],
          { cwd: dir, stdio: "pipe" },
        );

      // A bare flag, an empty value and a following flag are all refused, by name.
      expect(() => bakeWith("--out")).toThrow(/--out needs a nonempty/);
      expect(() => bakeWith("--out", "")).toThrow(/--out needs a nonempty/);
      expect(() => bakeWith("--out", "--assets", starterAssets)).toThrow(/--out needs a nonempty/);
      expect(() => bakeWith("--assets")).toThrow(/--assets needs a nonempty/);
      expect(() => bakeWith("--assets", "")).toThrow(/--assets needs a nonempty/);
      expect(() => bakeWith("--assets", "--out", dir)).toThrow(/--assets needs a nonempty/);
      // Nothing was written into the working directory.
      expect(readdirSync(dir)).toEqual([]);
    },
  );
});
