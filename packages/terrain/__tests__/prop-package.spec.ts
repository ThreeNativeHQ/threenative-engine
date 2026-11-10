import type { IPlacement } from "@threenative/terrain";
import {
  compilePropBuckets,
  decodePropBucket,
  propPackageFile,
  propPackageFiles,
} from "@threenative/terrain";
import { describe, expect, it } from "vitest";

/**
 * PRD-792 decision: the example keeps a call, not a compiler. The compile that turns placements into
 * streamed prop worlds (`createStreamedProps` in the example before this moved) now lives here, so
 * the bake and the editor's live placements run one implementation and the game only loads the files.
 *
 * The fixture is one world's worth of placements, small enough to check field by field. Its numbers
 * are the ones the example compile wrote for the same input: a 128 m cell size, cells floored and
 * ceiled to the cell grid over the base bounds, one run per asset inside a cell, records of eight
 * float32 (position, quaternion, uniform scale), and the reach and the placement ID sidecars in the
 * record order the cell pass produced.
 */
const UP: [number, number, number] = [0, 1, 0];

function placement(
  id: string,
  asset: string,
  position: [number, number, number],
  scale: number,
  yaw = 0,
): IPlacement {
  return {
    alignToNormal: false,
    asset,
    id,
    layer: `temperate-${asset}`,
    normal: UP,
    position,
    rotation: yaw,
    scale,
  };
}

/** The authored pose a bake hands the compile: the scatter numbers as one record's transform. */
function posed(item: IPlacement): IPlacement {
  return {
    ...item,
    transform: {
      grounding: true,
      position: item.position,
      quaternion: [0, Math.sin(item.rotation / 2), 0, Math.cos(item.rotation / 2)],
      scale: [item.scale, item.scale, item.scale],
    },
  };
}

const ENTRIES = [
  {
    bucket: "local:true",
    placement: posed(placement("grass:0", "grass", [10, 4, 10], 1.5, 0.5)),
    reach: 112,
  },
  {
    bucket: "local:false",
    placement: posed(placement("litter:0", "litter", [11, 4, 11], 1, 0)),
    reach: 16,
  },
  {
    bucket: "local:true",
    placement: posed(placement("grass:1", "grass", [300, 9, 260], 2, 1.25)),
    reach: 112,
  },
  {
    bucket: "far:false",
    kind: "far" as const,
    placement: posed(placement("spruce:0", "spruce", [-700, 40, 5], 3)),
    reach: Number.POSITIVE_INFINITY,
  },
  {
    bucket: "meadow:false",
    kind: "meadow" as const,
    placement: posed(placement("meadow:0", "meadow", [4, 4, -180], 1)),
    reach: 230,
  },
];

const BOUNDS = { minX: -256, minZ: -256, sizeX: 512, sizeZ: 512 };

describe("the prop package compile", () => {
  const pkg = compilePropBuckets(ENTRIES, { bounds: BOUNDS });

  it("writes one streamed world per bucket, in first-seen order, with its kind", () => {
    expect(pkg.buckets.map((bucket) => [bucket.bucket, bucket.kind])).toEqual([
      ["local:true", "local"],
      ["local:false", "local"],
      ["far:false", "far"],
      ["meadow:false", "meadow"],
    ]);
    expect(pkg.cellSize).toBe(128);
  });

  it("aligns every bucket's extent to the base square and widens it to its own placements", () => {
    const [local, , far, meadow] = pkg.buckets;
    // Two grass records in cells of the base square leave its floor alone and add one cell each way.
    expect(local?.extent).toEqual({ minX: -256, minZ: -256, sizeX: 640, sizeZ: 640 });
    // The collar tree sits past the square, so its bucket reaches down to −768.
    expect(far?.extent).toEqual({ minX: -768, minZ: -256, sizeX: 1152, sizeZ: 640 });
    expect(meadow?.extent).toEqual({ minX: -256, minZ: -256, sizeX: 640, sizeZ: 640 });
  });

  it("writes the cell, run and record layout the game's compile wrote", () => {
    const local = pkg.buckets[0];
    // Two grass records land in two cells of the base square; the litter record is its own bucket.
    expect(local?.cells).toEqual([
      { runs: [{ asset: "grass", count: 1, offset: 0 }], x: 2, z: 2 },
      { runs: [{ asset: "grass", count: 1, offset: 1 }], x: 4, z: 4 },
    ]);
    expect(local?.ids).toEqual(["grass:0", "grass:1"]);
    expect([...(local?.reach ?? [])]).toEqual([112, 112]);
    const records = new Float32Array((local?.placements as Uint8Array).buffer);
    expect(records.length).toBe(16);
    // Position, authored quaternion, uniform scale: eight float32 per record.
    expect([...records.slice(0, 3)]).toEqual([10, 4, 10]);
    expect([...records.slice(3, 7)].map((value) => Number(value.toFixed(6)))).toEqual([
      0, 0.247404, 0, 0.968912,
    ]);
    expect(records[7]).toBeCloseTo(1.5, 6);
    expect([...records.slice(8, 11)]).toEqual([300, 9, 260]);
  });

  it("reads every bucket back to the IDs, models, poses and reach it was compiled from", () => {
    const decoded = pkg.buckets.flatMap((bucket) => decodePropBucket(bucket));
    expect(decoded.map((record) => record.id).sort()).toEqual(
      ENTRIES.map((entry) => entry.placement.id).sort(),
    );
    for (const entry of ENTRIES) {
      const record = decoded.find((item) => item.id === entry.placement.id);
      expect(record?.asset).toBe(entry.placement.asset);
      expect(record?.key).toBe(entry.placement.asset);
      expect(record?.position).toEqual(entry.placement.position);
      expect(record?.scale).toBeCloseTo(entry.placement.scale, 6);
      expect(record?.reach).toBe(Math.fround(entry.reach));
      const yaw = entry.placement.rotation;
      expect(record?.quaternion[1]).toBeCloseTo(Math.sin(yaw / 2), 6);
      expect(record?.quaternion[3]).toBeCloseTo(Math.cos(yaw / 2), 6);
    }
    const local = pkg.buckets[0];
    if (!local) throw new Error("no bucket");
    expect(() => decodePropBucket({ ...local, ids: [...local.ids, "extra"] })).toThrow(
      "TN_PROP_BUCKET_INVALID",
    );
  });

  it("writes the bucket list as a manifest that names the three files of every bucket", () => {
    const { files, manifest } = propPackageFiles(pkg, "fixture");
    const listed = JSON.parse(new TextDecoder().decode(manifest)) as {
      cellSize: number;
      buckets: { bucket: string; kind: string; placements: string; reach: string; ids: string }[];
    };
    expect(listed.cellSize).toBe(128);
    expect(listed.buckets.map((bucket) => [bucket.bucket, bucket.kind])).toEqual([
      ["local:true", "local"],
      ["local:false", "local"],
      ["far:false", "far"],
      ["meadow:false", "meadow"],
    ]);
    for (const bucket of listed.buckets) {
      expect(files[bucket.placements]).toBeInstanceOf(Uint8Array);
      expect(files[bucket.reach]).toBeInstanceOf(Uint8Array);
      expect(JSON.parse(new TextDecoder().decode(files[bucket.ids]))).toEqual(
        pkg.buckets.find((entry) => entry.bucket === bucket.bucket)?.ids,
      );
      expect(bucket.placements).toBe(propPackageFile("fixture", bucket.bucket, "props.bin"));
    }
    // The far bucket keeps its reach as data: an infinite reach is what makes its cells resident.
    const far = listed.buckets.find((bucket) => bucket.kind === "far");
    if (!far) throw new Error("the far bucket is missing");
    const reach = new Float32Array((files[far.reach] as Uint8Array).buffer);
    expect(reach[0]).toBe(Number.POSITIVE_INFINITY);
  });

  it("refuses a bucket that names two kinds, and a non-uniform record scale", () => {
    expect(() =>
      compilePropBuckets([
        ENTRIES[0] as (typeof ENTRIES)[number],
        {
          bucket: "local:true",
          kind: "meadow",
          placement: placement("a:0", "grass", [0, 0, 0], 1),
          reach: 112,
        },
      ]),
    ).toThrow(/mixes kinds/);
    expect(() =>
      compilePropBuckets([
        {
          bucket: "local:true",
          placement: {
            ...placement("a:0", "grass", [0, 0, 0], 1),
            transform: {
              grounding: true,
              position: [0, 0, 0],
              quaternion: [0, 0, 0, 1],
              scale: [1, 2, 1],
            },
          },
          reach: 112,
        },
      ]),
    ).toThrow(/one uniform scale/);
  });
});
