import type { IPlacement } from "./types.js";
import {
  type IWorldPackageManifest,
  type IWorldPackageRun,
  placementCells,
} from "./world-package.js";

/**
 * The streamed prop worlds one bake writes, and what each one holds.
 *
 * A prop package is the same container as a world package (`world-package.ts`): eight float32 per
 * placement, cells of a fixed size, and one run per asset inside a cell. What it adds is the split
 * into streamed worlds. The game draws its placements in more than one `WorldCells` because reach
 * and shadow policy differ between a horizon-canopy tree and a shadowless blade of grass, and the
 * far field and the vista meadow answer a query flag. This module turns labelled placements into
 * those worlds, so the bake writes them and the game loads them, and neither side owns the grouping.
 */

/** Which streamed world a record draws in, for a loader that answers a query flag before it loads. */
export type IPropBucketKind = "local" | "far" | "meadow";

/** One placement, the streamed world it belongs to, and how far it may draw. */
export interface IPropBucketEntry {
  readonly placement: IPlacement;
  /** The streamed world's name, e.g. `local:true`. Two entries of one name share every container field. */
  readonly bucket: string;
  /** Metres at which the record may be culled; `Number.POSITIVE_INFINITY` keeps every cell resident. */
  readonly reach: number;
  /**
   * The model the record draws, when it is not the placement's asset alone: the game's
   * `asset:variant` key, with a shape suffix when one scale cannot carry the placement. The run a
   * record sits in names it, and the loader's asset table is keyed by it.
   */
  readonly key?: string;
  /** Defaults to `local`. A bucket that names two kinds fails the compile. */
  readonly kind?: IPropBucketKind;
}

/** One streamed prop world: its container, its per-record reach, and its per-record placement ID. */
export interface IPropBucketPackage {
  readonly bucket: string;
  readonly kind: IPropBucketKind;
  readonly extent: IWorldPackageManifest["extent"];
  readonly cells: readonly {
    readonly x: number;
    readonly z: number;
    readonly runs: readonly IWorldPackageRun[];
  }[];
  /** Eight float32 per record: position, quaternion, uniform scale. */
  readonly placements: Uint8Array;
  /** One float32 per record, in record order. */
  readonly reach: Float32Array;
  /** One placement ID per record, in record order. The game's `variantFor` hashes it. */
  readonly ids: readonly string[];
}

export interface IPropPackage {
  readonly cellSize: number;
  readonly buckets: readonly IPropBucketPackage[];
}

export interface ICompilePropBucketsOptions {
  /** Metres per streamed cell. Defaults to 128. */
  readonly cellSize?: number;
  /**
   * The extent every bucket includes before its own placements widen it, e.g. the world square.
   * Without it a bucket spans exactly its own placements.
   */
  readonly bounds?: IWorldPackageManifest["extent"];
}

/** The cell size the game streams props in: 128 m, coarse enough that admission jobs stay bounded. */
export const PROP_CELL_SIZE = 128;
const DEFAULT_KIND: IPropBucketKind = "local";
const KINDS: readonly IPropBucketKind[] = ["far", "local", "meadow"];

interface IBucketAcc {
  readonly bucket: string;
  readonly entries: IPropBucketEntry[];
  kind: IPropBucketKind;
}

/**
 * Group placements into their streamed worlds and write each world's cells and records.
 *
 * The order is the streamed one: cells sorted by `x` then `z`, assets sorted by name inside a cell,
 * and records in the order the entries arrived inside a run. Same-cell, same-asset placements keep
 * their input order, so a re-run of a seeded bake reproduces the buffer byte for byte.
 *
 * @requires npm i -D @threenative/terrain
 * @situation bake the prop worlds a game streams, once, instead of compiling them at load
 * @constraint headless; the caller decides every placement, its streamed world, its reach and its pose
 * @example const pkg = compilePropBuckets(entries, { bounds });
 * @override cellSize and the base extent; the bucket, reach and kind of every entry
 */
export function compilePropBuckets(
  entries: readonly IPropBucketEntry[],
  options: ICompilePropBucketsOptions = {},
): IPropPackage {
  const cellSize = options.cellSize ?? PROP_CELL_SIZE;
  if (!Number.isFinite(cellSize) || cellSize <= 0)
    throw Error(
      `Prop package: cellSize must be a positive finite number, got ${String(cellSize)}.`,
    );
  const buckets = new Map<string, IBucketAcc>();
  for (const entry of entries) {
    const kind = entry.kind ?? DEFAULT_KIND;
    if (!KINDS.includes(kind))
      throw Error(`Prop package: '${entry.bucket}' names unknown kind '${String(kind)}'.`);
    if (!Number.isFinite(entry.reach) && entry.reach !== Number.POSITIVE_INFINITY)
      throw Error(`Prop package: '${entry.placement.id}' has a non-finite reach.`);
    const seen = buckets.get(entry.bucket);
    if (seen === undefined)
      buckets.set(entry.bucket, { bucket: entry.bucket, entries: [entry], kind });
    else if (seen.kind !== kind)
      throw Error(
        `Prop package: bucket '${entry.bucket}' mixes kinds '${seen.kind}' and '${kind}'.`,
      );
    else seen.entries.push(entry);
  }
  return {
    buckets: [...buckets.values()].map((acc) => bucketPackage(acc, cellSize, options.bounds)),
    cellSize,
  };
}

function bucketPackage(
  acc: IBucketAcc,
  cellSize: number,
  bounds: IWorldPackageManifest["extent"] | undefined,
): IPropBucketPackage {
  const extent = bucketExtent(
    acc.entries.map((entry) => entry.placement.position),
    cellSize,
    bounds,
  );
  const modelOf = (entry: IPropBucketEntry): string => entry.key ?? entry.placement.asset;
  const placements = placementCells(
    {
      instances: acc.entries.map((entry) =>
        entry.key === undefined ? entry.placement : { ...entry.placement, asset: entry.key },
      ),
    },
    // The compile validates membership only; the game owns every asset's model, bounds and LODs.
    Object.fromEntries(acc.entries.map((entry) => [modelOf(entry), true])),
    cellSize,
    extent,
  );
  const reach = new Map(acc.entries.map((entry) => [entry.placement.id, entry.reach]));
  for (const id of placements.ids)
    if (!reach.has(id)) throw Error(`Prop package: '${id}' lost its reach in the cell pass.`);
  return {
    bucket: acc.bucket,
    cells: placements.cells,
    extent,
    ids: placements.ids,
    kind: acc.kind,
    placements: placements.bytes,
    reach: Float32Array.from(placements.ids, (id) => reach.get(id) as number),
  };
}

/** The cell-aligned box a bucket spans: the base bounds, widened to hold every placement. */
function bucketExtent(
  positions: readonly (readonly [number, number, number])[],
  cellSize: number,
  bounds: IWorldPackageManifest["extent"] | undefined,
): IWorldPackageManifest["extent"] {
  const first = positions[0];
  if (first === undefined) throw Error("Prop package: a bucket holds no placement.");
  let { minX, minZ } = bounds ?? { minX: first[0], minZ: first[2] };
  let maxX = bounds === undefined ? first[0] : bounds.minX + bounds.sizeX;
  let maxZ = bounds === undefined ? first[2] : bounds.minZ + bounds.sizeZ;
  for (const [x, , z] of positions) {
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw Error(`Prop package: a placement sits at a non-finite [${String(x)}, ${String(z)}].`);
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  minX = Math.floor(minX / cellSize) * cellSize;
  minZ = Math.floor(minZ / cellSize) * cellSize;
  maxX = (Math.floor(maxX / cellSize) + 1) * cellSize;
  maxZ = (Math.floor(maxZ / cellSize) + 1) * cellSize;
  return { minX, minZ, sizeX: maxX - minX, sizeZ: maxZ - minZ };
}

/**
 * The asset a package run names.
 *
 * A prop run names the model it draws, `asset:variant[@shape]`; a container written by
 * `bakeWorldPackage` names the asset alone. Both reduce to the asset here, which is what a count, a
 * material or a placement's own `asset` field holds.
 *
 * @requires npm i -D @threenative/terrain
 * @situation count one species across a world's prop buckets, or name the asset a run draws
 * @example const asset = propAssetOf("spruce:2"); // "spruce"
 */
export function propAssetOf(modelKey: string): string {
  const at = modelKey.indexOf(":");
  return at < 0 ? modelKey : modelKey.slice(0, at);
}

/** One record of a compiled prop bucket, in record order. */
export interface IPropBucketRecord {
  readonly id: string;
  /** The model the record draws, as its run names it (`spruce:2`, or with a shape suffix). */
  readonly key: string;
  /** The asset alone, `propAssetOf(key)`. */
  readonly asset: string;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: number;
  readonly reach: number;
}

/**
 * The records of one compiled prop bucket, read back in record order: the inverse of
 * `compilePropBuckets`, so a loader that fetched a bake's files gets each record's ID, model,
 * pose and reach without re-deriving the container layout.
 *
 * @requires npm i -D @threenative/terrain
 * @situation read a baked prop bucket back into placements to ground them on this machine's terrain
 * @constraint throws `TN_PROP_BUCKET_INVALID` when the record buffer, the IDs and the runs disagree
 * @example for (const record of decodePropBucket(bucket)) pose(record.key, record.position, record.quaternion);
 */
export function decodePropBucket(bucket: IPropBucketPackage): IPropBucketRecord[] {
  const floats = new Float32Array(
    bucket.placements.buffer,
    bucket.placements.byteOffset,
    bucket.placements.byteLength / 4,
  );
  if (floats.length !== bucket.ids.length * 8)
    throw new Error(
      `TN_PROP_BUCKET_INVALID: bucket '${bucket.bucket}' holds ${floats.length / 8} records for ${bucket.ids.length} IDs.`,
    );
  const keys: string[] = new Array(bucket.ids.length);
  for (const cell of bucket.cells)
    for (const run of cell.runs)
      for (let index = 0; index < run.count; index++) keys[run.offset + index] = run.asset;
  return bucket.ids.map((id, index) => {
    const key = keys[index];
    if (key === undefined)
      throw new Error(
        `TN_PROP_BUCKET_INVALID: bucket '${bucket.bucket}' record '${id}' sits in no run.`,
      );
    const at = index * 8;
    const f = (k: number): number => floats[at + k] as number;
    return {
      id,
      key,
      asset: propAssetOf(key),
      position: [f(0), f(1), f(2)],
      quaternion: [f(3), f(4), f(5), f(6)],
      scale: f(7),
      reach: bucket.reach[index] ?? bucket.reach[0] ?? Number.POSITIVE_INFINITY,
    };
  });
}

/** The files one bake writes for a world's prop package: its bucket list and each bucket's three files. */
export interface IPropPackageFiles {
  readonly manifest: Uint8Array;
  readonly files: Readonly<Record<string, Uint8Array>>;
}

/**
 * A path under `world/` that no bucket name can break: `local:true` becomes `local-true`.
 *
 * The bucket's own name is kept in the manifest, so this rename is only a file-system concern.
 *
 * @requires npm i -D @threenative/terrain
 * @situation name one of a bucket's three files without a bucket key that breaks a path
 * @example const file = propPackageFile("forest", "local:true", "props.bin"); // "forest.local-true.props.bin"
 */
export function propPackageFile(world: string, bucket: string, suffix: string): string {
  return `${world}.${bucket.replace(/[^a-zA-Z0-9]+/g, "-")}.${suffix}`;
}

/**
 * Write a compiled package as the manifest the game fetches and one set of files per bucket.
 *
 * The manifest names the files rather than embedding them, so a loader fetches only the buckets its
 * query flags keep (`?farForest=on` keeps the far field, `?meadow=off` drops the vista cover).
 *
 * @requires npm i -D @threenative/terrain
 * @situation write a compiled package to disk: one manifest and three files per streamed world
 * @constraint the manifest names the files; nothing here touches a file system
 * @example const { manifest, files } = propPackageFiles(pkg, "forest");
 */
export function propPackageFiles(pkg: IPropPackage, world: string): IPropPackageFiles {
  const files: Record<string, Uint8Array> = {};
  const buckets = pkg.buckets.map((bucket) => {
    const names = {
      ids: propPackageFile(world, bucket.bucket, "ids.json"),
      placements: propPackageFile(world, bucket.bucket, "props.bin"),
      reach: propPackageFile(world, bucket.bucket, "reach.bin"),
    };
    files[names.placements] = bucket.placements;
    files[names.reach] = new Uint8Array(bucket.reach.buffer, bucket.reach.byteOffset);
    files[names.ids] = new TextEncoder().encode(JSON.stringify(bucket.ids));
    return {
      bucket: bucket.bucket,
      cells: bucket.cells,
      extent: bucket.extent,
      kind: bucket.kind,
      ...names,
    };
  });
  const manifest = { buckets, cellSize: pkg.cellSize, version: 1 };
  return { files, manifest: new TextEncoder().encode(JSON.stringify(manifest)) };
}
