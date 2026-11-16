import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Terrain, decodeRAW16 } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const starterAssets = join(packageRoot, "starter-assets");

// Manifest hashes include placementIds; terrain and prop payload hashes stay pinned.
const GOLDEN_HASHES: Record<string, Record<string, string>> = {
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
    "heightmap.u16": "ff6f77a9f170ed3a3f52087052150fdeec763dafab874a7adfeab328dd7d2cf8",
    "placements.bin": "040aeb0d7bfcb2792fb6d254f9b0402f029f989ca94d63cc4bf21d64020d6704",
    "splat.rgba": "8afba577e7e3a355d24cba1ddbb0e7b002ab593bb206198a3e35b7f1555b130c",
    "world.json": "965e6ac039105990e803f18716d9df1001aec8c1ac9ce2cddcd8a9a0c41f4c0e",
  },
};

/** SHA256 of each kit's inline heights and evaluated height grid at e12a5d578, as Float32 bytes. */
const BASELINE_HEIGHTS: Record<string, { values: string; evaluated: string }> = {
  forest: {
    values: "46e9bdddaae82a29f770358e51f282486b41d0cab268a25bd58ba885c70a5ed8",
    evaluated: "57751c30d9ea1a74dc6fadd445bd17a59fcf03ef4cb58925faac66770d737b26",
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
    evaluated: "7446793dd47a5bbe2004c21418a02a3db640296dda966fa5439170d9a59651a7",
  },
};

/** One layer of the forest's ground table: its maps, relative to the `world/` folder. */
interface IForestLayer {
  readonly id: string;
  readonly maps: { diffuse: string; normal?: string };
}

/** Copies the named kit into a temp directory whose node_modules resolves the workspace packages. */
function kitInTempDir(kitName: string): string {
  const dir = makeTempDirSync(`terrain-starter-kit-${kitName}-`);
  const kit = join(packageRoot, "starter", kitName);
  for (const name of ["bake.mjs", "recipe.json", "assets.json", "surface.json", "heightmap.r16"])
    copyFileSync(join(kit, name), join(dir, name));
  mkdirSync(join(dir, "node_modules", "@threenative"), { recursive: true });
  symlinkSync(packageRoot, join(dir, "node_modules", "@threenative", "terrain"), "dir");
  // A kit's bake.mjs imports the cook from @threenative/assets, so the fixture links this checkout's.
  symlinkSync(
    join(packageRoot, "..", "assets"),
    join(dir, "node_modules", "@threenative", "assets"),
    "dir",
  );
  // The kit's `arbor` rows grow with this package, the README's third devDependency.
  symlinkSync(
    join(packageRoot, "..", "procedural-vegetation"),
    join(dir, "node_modules", "@threenative", "procedural-vegetation"),
    "dir",
  );
  return dir;
}

function bake(out: string, kitName: string): { files: Map<string, string>; total: number } {
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
  /** The forest kit's own bake, run in place: it imports the kit's TypeScript under tsx. */
  function bakeForest(out: string): Map<string, string> {
    execFileSync(process.execPath, [join(packageRoot, "starter/forest/bake.mjs"), "--out", out], {
      stdio: "pipe",
    });
    const files = new Map<string, string>();
    for (const path of readdirSync(out, { recursive: true })) {
      const full = join(out, String(path));
      if (statSync(full).isFile())
        files.set(String(path), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
    return files;
  }

  it("bakes every file its scene fetches, and the art they name, deterministically", () => {
    const out = makeTempDirSync("terrain-starter-forest-");
    const files = bakeForest(out);
    const props = JSON.parse(readFileSync(join(out, "world/forest.props.json"), "utf8")) as {
      buckets: { placements: string; reach: string; ids: string }[];
    };
    const fetched = [
      "forest.json",
      "horizon.json",
      "forest.props.json",
      "forest.canopy.bin",
      "forest.sky.bin",
      "forest.world.json",
      "forest.layers.json",
      "forest.splat.rgba8",
      ...props.buckets.flatMap((bucket) => [bucket.placements, bucket.reach, bucket.ids]),
    ];
    for (const file of fetched) expect(files.has(`world/${file}`), file).toBe(true);
    const table = JSON.parse(readFileSync(join(out, "world/forest.layers.json"), "utf8")) as {
      base: IForestLayer;
      layers: IForestLayer[];
    };
    for (const layer of [table.base, ...table.layers])
      for (const map of Object.values(layer.maps))
        expect(files.has(join("world", map)), `${layer.id} ${map}`).toBe(true);
    for (const art of ["hdri/kloofendal_48d_partly_cloudy_2k.hdr", "mannequin-swim.glb"])
      expect(files.has(art), art).toBe(true);
    // The pinned survey bakes the pinned lake and creek the scene floods.
    const world = JSON.parse(readFileSync(join(out, "world/forest.json"), "utf8"));
    expect(world.lakes).toEqual([{ id: "lake", at: [-70, 25], radius: 105, level: 13.3 }]);
    expect(world.rivers).toHaveLength(1);
    // One kit, one world: a second bake is byte-identical.
    expect([...bakeForest(makeTempDirSync("terrain-starter-forest-"))].sort()).toEqual(
      [...files].sort(),
    );
  }, 240_000);

  it("refuses a bare, empty or flag-valued --out before writing", () => {
    const dir = makeTempDirSync("terrain-starter-flags-forest-");
    const bakeWith = (...args: string[]) =>
      execFileSync(process.execPath, [join(packageRoot, "starter/forest/bake.mjs"), ...args], {
        cwd: dir,
        stdio: "pipe",
      });
    expect(() => bakeWith("--out")).toThrow(/--out needs a nonempty/);
    expect(() => bakeWith("--out", "")).toThrow(/--out needs a nonempty/);
    expect(() => bakeWith("--out", "--force")).toThrow(/--out needs a nonempty/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(["alpine", "coastal", "desert", "tundra"] as const)(
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
      "starter/forest/README.md",
      "starter/forest/scene.ts",
      "starter/forest/render/props/pack.ts",
      "starter/forest/render/ground/palette.js",
      "starter/forest/world/terrainAssets.ts",
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
      "starter/arbor/wind.ts",
      "starter-assets.json",
      "starter-credits.json",
      "THIRD_PARTY_NOTICES.md",
      ...["forest", "alpine", "desert", "tundra", "coastal"].map(
        (kit) => `starter/${kit}/heightmap.r16`,
      ),
    ])
      expect(files.has(path), `packed tarball is missing ${path}`).toBe(true);
    expect(packedFiles.some((file) => file.path.startsWith("starter-assets/"))).toBe(false);
    // No baked world ships: the forest's `world/` folder holds only its source.
    expect(
      packedFiles.some(
        (file) => /^starter\/[^/]+\/world\//u.test(file.path) && !file.path.endsWith(".ts"),
      ),
    ).toBe(false);
    expect(packed[0]?.size).toBeLessThan(2_000_000);
    const archive = JSON.parse(readFileSync(join(packageRoot, "starter-assets.json"), "utf8"));
    expect(archive.bytes).toBeGreaterThan(0);
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
    console.log(`starter asset archive: ${archive.bytes} B; ${archive.sha256}`);
    expect(readFileSync(join(packageRoot, "starter-credits.json"))).toEqual(
      readFileSync(join(starterAssets, "credits.json")),
    );
  });

  it.each(["alpine", "coastal", "desert", "tundra"] as const)(
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
