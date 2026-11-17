import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Terrain, decodeRAW16 } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const starterAssets = join(packageRoot, "starter-assets");

// No pinned cell-package hashes: since 2026-11-16 every data kit bakes the streamed world (PRD-892
// Phase 2), so `world.json`, `placements.bin` and `splat.rgba` are no kit's output any more. Their
// recipes stay pinned by the RAW16 hydration case below and their streamed output by `kit-bake.spec.ts`.
/** SHA256 of each kit's inline heights and evaluated height grid at e12a5d578, as Float32 bytes. */
const BASELINE_HEIGHTS: Record<string, { values: string; evaluated: string }> = {
  forest: {
    values: "46e9bdddaae82a29f770358e51f282486b41d0cab268a25bd58ba885c70a5ed8",
    evaluated: "57751c30d9ea1a74dc6fadd445bd17a59fcf03ef4cb58925faac66770d737b26",
  },
  alpine: {
    values: "7c7fa4490588672e0f17b328ff02d5529843c618edee82c47fb650c324effbcc",
    evaluated: "6d7ee5858a2d4d257bb6210a63b45d6effc8761b1e5ade6e634299927ec6a7dc",
  },
  // Evaluated since PRD-892 Phase 2 with the lagoon bed lowered under its 2.25 m surface.
  coastal: {
    values: "726595506d7dda30da88401b74c878375bcb40d88cef0debb4a10f27f47a2d17",
    evaluated: "aedaf0355dd0d767bf370db44d704ba0b04378a86f039abae037de905be3f942",
  },
  desert: {
    values: "b0f471e65576313f26f98e456323c4c6eb6c4e688c931e4cafc2c66663abce85",
    evaluated: "beb557010f5a0ffeba9767560c066a6735b1d39d920db05f5ddadc4b1dfe6855",
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
