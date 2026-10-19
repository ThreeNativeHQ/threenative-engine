import { MATERIAL_IDS } from "./masks.js";
import type { IPlacement, ITerrainState } from "./types.js";

/** One streamed asset: its LOD0 model, its authored bounds and the levels it swaps to. */
export interface IWorldPackageAsset {
  readonly glb: string;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly lods?: readonly { readonly glb: string; readonly distance: number }[];
  readonly maxDistance?: number;
}

/** One cell's contiguous run of placement records, eight float32 values each. */
export interface IWorldPackageRun {
  readonly asset: string;
  /** Record offset into the placement buffer, not a byte offset. */
  readonly offset: number;
  readonly count: number;
}

/** The `world.json` contract, declared here so this addon needs no `@threenative/core` import. */
export interface IWorldPackageManifest {
  readonly version: 1;
  readonly extent: {
    readonly minX: number;
    readonly minZ: number;
    readonly sizeX: number;
    readonly sizeZ: number;
  };
  readonly cellSize: number;
  readonly terrain: {
    readonly heightmap: string;
    readonly columns: number;
    readonly rows: number;
    readonly spacing: number;
    readonly heightMin: number;
    readonly heightMax: number;
    readonly layers?: Readonly<Record<string, string>>;
  };
  readonly assets: Readonly<Record<string, IWorldPackageAsset>>;
  readonly placements: string;
  readonly cells: readonly {
    readonly x: number;
    readonly z: number;
    readonly runs: readonly IWorldPackageRun[];
  }[];
}

/** The splat layout to copy into a terrain table: eight material masks in two RGBA8 planes. */
export interface IWorldPackageSplat {
  readonly size: number;
  readonly planes: number;
  readonly masks: Readonly<Record<string, readonly [number, "r" | "g" | "b" | "a"]>>;
}

export interface IBakeWorldPackageOptions {
  /** Every asset any instance may reference. An instance outside this set fails the bake. */
  readonly assets: Readonly<Record<string, IWorldPackageAsset>>;
  /** Metres per streamed cell. Defaults to 64. */
  readonly cellSize?: number;
  /** Extra `terrain.layers` entries, e.g. `{ table: "terrain-table.json" }`. */
  readonly layers?: Readonly<Record<string, string>>;
  readonly names?: {
    readonly heightmap?: string;
    readonly placements?: string;
    readonly splat?: string;
  };
}

export interface IBakedWorldPackage {
  readonly manifest: IWorldPackageManifest;
  readonly splat: IWorldPackageSplat;
  /** The three binary files, keyed by the manifest names that point at them. */
  readonly files: Readonly<Record<string, Uint8Array>>;
}

const HEIGHTMAP_MAX = 65_535;
const RECORD_VALUES = 8;
const COMPONENTS = ["r", "g", "b", "a"] as const;
type Component = (typeof COMPONENTS)[number];
/** Two RGBA8 planes carry the eight material channels; each sample's weights spread across them. */
const PLANES = MATERIAL_IDS.length / COMPONENTS.length;
/** A record holds one uniform scale, so a non-uniform one is refused rather than averaged away. */
const SCALE_TOLERANCE = 1e-3;

/** Where each material channel lands: the plane it is in and its component within that plane. */
const SLOTS = MATERIAL_IDS.map((id, channel) => ({
  channel,
  component: COMPONENTS[channel % COMPONENTS.length] as Component,
  id,
  plane: Math.floor(channel / COMPONENTS.length),
}));

/** One accumulating cell: the instances of every asset that landed in it. */
interface ICellAcc {
  readonly x: number;
  readonly z: number;
  readonly items: Map<string, IPlacement[]>;
}

type ICell = IWorldPackageManifest["cells"][number];

/** `item.transform` when a game authored it, else the scatter pose: yaw about +Y, uniform scale. */
function poseOf(item: IPlacement): {
  position: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
  scale: readonly [number, number, number];
} {
  if (item.transform === undefined)
    return {
      position: item.position,
      quaternion: [0, Math.sin(item.rotation / 2), 0, Math.cos(item.rotation / 2)],
      scale: [item.scale, item.scale, item.scale],
    };
  const { position, quaternion, scale } = item.transform;
  return { position, quaternion, scale };
}

function uniformScale(asset: string, id: string, scale: readonly [number, number, number]): number {
  const mean = (scale[0] + scale[1] + scale[2]) / 3;
  const deviation = Math.max(
    Math.abs(scale[0] - mean),
    Math.abs(scale[1] - mean),
    Math.abs(scale[2] - mean),
  );
  if (!(mean > 0) || deviation > mean * SCALE_TOLERANCE)
    throw Error(
      `World package: placement '${id}' of asset '${asset}' is scaled ${JSON.stringify(scale)}; a placement record carries one uniform scale.`,
    );
  return mean;
}

function placementRecord(item: IPlacement): number[] {
  if (item.transform === undefined && !Number.isFinite(item.rotation))
    throw Error(`World package: placement '${item.id}' has a non-finite rotation.`);
  const { position, quaternion, scale } = poseOf(item);
  const length = Math.hypot(...quaternion);
  if (!(length > 0)) throw Error(`World package: placement '${item.id}' has a zero quaternion.`);
  return [
    position[0],
    position[1],
    position[2],
    quaternion[0] / length,
    quaternion[1] / length,
    quaternion[2] / length,
    quaternion[3] / length,
    uniformScale(item.asset, item.id, scale),
  ];
}

/**
 * Every instance as float32 records, in cells of `cellSize` metres, and the runs that index them.
 *
 * A run is a contiguous `[offset, offset + count)` range, so the buffer cannot follow the order the
 * instances arrive in: two assets sharing a cell interleave, and extending each run where it was
 * first seen would overlap them. Instances are therefore bucketed per cell and asset first, then
 * written cell by cell and asset by asset, which is the layout the Blender recipe emits too.
 */
function placementCells(
  state: ITerrainState,
  assets: Readonly<Record<string, IWorldPackageAsset>>,
  cellSize: number,
  extent: IWorldPackageManifest["extent"],
): { bytes: Uint8Array; cells: ICell[] } {
  const cells = new Map<string, ICellAcc>();
  const across = Math.max(1, Math.ceil(extent.sizeX / cellSize));
  const cellOf = (value: number, min: number): number =>
    Math.min(across - 1, Math.max(0, Math.floor((value - min) / cellSize)));
  for (const item of state.instances) {
    if (assets[item.asset] === undefined)
      throw Error(
        `World package: placement '${item.id}' names asset '${item.asset}', which options.assets does not.`,
      );
    const x = cellOf(item.position[0], extent.minX);
    const z = cellOf(item.position[2], extent.minZ);
    const key = `${String(x)},${String(z)}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { items: new Map(), x, z };
      cells.set(key, cell);
    }
    const bucket = cell.items.get(item.asset);
    if (bucket === undefined) cell.items.set(item.asset, [item]);
    else bucket.push(item);
  }

  const buffer = new ArrayBuffer(state.instances.length * RECORD_VALUES * 4);
  const records = new Float32Array(buffer);
  const ordered: ICell[] = [];
  let written = 0;
  const byId = (left: [string, IPlacement[]], right: [string, IPlacement[]]): number =>
    left[0] < right[0] ? -1 : 1;
  for (const cell of [...cells.values()].sort((a, b) => a.x - b.x || a.z - b.z)) {
    const runs: IWorldPackageRun[] = [];
    for (const [asset, items] of [...cell.items.entries()].sort(byId)) {
      runs.push({ asset, count: items.length, offset: written });
      for (const item of items) {
        records.set(placementRecord(item), written * RECORD_VALUES);
        written += 1;
      }
    }
    ordered.push({ runs, x: cell.x, z: cell.z });
  }
  return { bytes: new Uint8Array(buffer), cells: ordered };
}

/**
 * Bake an evaluated terrain into the engine's world package: a `world.json` manifest, a uint16
 * heightmap, a splat mask array, a placement buffer of eight float32 per instance, and the square
 * cells that stream them. The encodings and row orders are the ones the Blender recipe
 * `export_world.py` writes, so one runtime streams both without a second reader.
 *
 * @requires npm i -D @threenative/terrain
 * @situation hand an evaluated Strata terrain to a game without a Blender round trip
 * @constraint headless authoring; no three, no DOM, and nothing here decides how the world looks
 * @example const { manifest, files } = bakeWorldPackage(state, { assets });
 * @override every asset path, bound, LOD distance and cell size comes from the caller's options
 */
export function bakeWorldPackage(
  state: ITerrainState,
  options: IBakeWorldPackageOptions,
): IBakedWorldPackage {
  const { size, resolution } = state;
  const { assets, cellSize = 64, layers, names } = options;
  const heightmapName = names?.heightmap ?? "heightmap.u16";
  const placementsName = names?.placements ?? "placements.bin";
  const splatName = names?.splat ?? "splat.rgba";
  const extent = { minX: -size / 2, minZ: -size / 2, sizeX: size, sizeZ: size };

  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;
  for (const height of state.height) {
    if (!Number.isFinite(height)) throw Error("World package: terrain heights must be finite.");
    heightMin = Math.min(heightMin, height);
    heightMax = Math.max(heightMax, height);
  }
  // A flat world still needs a non-zero range, because the quantisation divides by it.
  if (heightMax - heightMin < 1e-6) heightMax = heightMin + 1;

  // Row-major, each row at a greater z — the order the core heightmap sampler reads.
  const heightmap = new Uint8Array(resolution * resolution * 2);
  const heights = new DataView(heightmap.buffer);
  for (let i = 0; i < state.height.length; i += 1)
    heights.setUint16(
      i * 2,
      Math.round(
        (((state.height[i] as number) - heightMin) / (heightMax - heightMin)) * HEIGHTMAP_MAX,
      ),
      true,
    );

  const placements = placementCells(state, assets, cellSize, extent);

  return {
    files: {
      [heightmapName]: heightmap,
      [placementsName]: placements.bytes,
      [splatName]: splatBytes(state, resolution),
    },
    manifest: {
      assets,
      cellSize,
      cells: placements.cells,
      extent,
      placements: placementsName,
      terrain: {
        columns: resolution,
        heightMax,
        heightMin,
        heightmap: heightmapName,
        layers: { splat: splatName, ...layers },
        rows: resolution,
        spacing: size / (resolution - 1),
      },
      version: 1,
    },
    splat: {
      masks: Object.fromEntries(SLOTS.map(({ component, id, plane }) => [id, [plane, component]])),
      planes: PLANES,
      size: resolution,
    },
  };
}

/**
 * The eight material weights per sample as RGBA8 planes, row 0 at the extent's far z edge.
 *
 * The core splat shader reads `v = (minZ + sizeZ - z) / sizeZ` over unflipped data, so a plane's
 * first row is the largest z. The heightmap runs the other way, hence the reversed rows here.
 */
function splatBytes(state: ITerrainState, resolution: number): Uint8Array {
  const planeBytes = resolution * resolution * 4;
  if (state.splat.length !== resolution * resolution * MATERIAL_IDS.length)
    throw Error(
      `World package: splat has ${String(state.splat.length)} weights, expected ${String(resolution * resolution * MATERIAL_IDS.length)}.`,
    );
  const bytes = new Uint8Array(planeBytes * PLANES);
  for (let row = 0; row < resolution; row += 1) {
    const source = (resolution - 1 - row) * resolution;
    for (let column = 0; column < resolution; column += 1) {
      const sample = (source + column) * MATERIAL_IDS.length;
      for (const slot of SLOTS) {
        const weight = state.splat[sample + slot.channel] as number;
        bytes[
          slot.plane * planeBytes +
            row * resolution * 4 +
            column * 4 +
            COMPONENTS.indexOf(slot.component)
        ] = Math.round(Math.min(1, Math.max(0, weight)) * 255);
      }
    }
  }
  return bytes;
}
