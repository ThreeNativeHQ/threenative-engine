import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldPackage,
  validateWorldPackage,
} from "@threenative/core/world";
import { validatePlacementOverrides } from "./placements.js";
import type { IPlacement, IPlacementOverride } from "./types.js";
import { placementCells } from "./world-package.js";

const RECORD_VALUES = 8;
const RECORD_BYTES = RECORD_VALUES * Float32Array.BYTES_PER_ELEMENT;

type PlacementEdit = Omit<IPlacementOverride, "position" | "quaternion" | "scale" | "grounding"> & {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  readonly grounding?: boolean;
};

export interface IWorldPlacementEdits {
  /** Replace or add asset kinds. Package-relative paths; `bounds` is required. */
  readonly assets?: Readonly<Record<string, IWorldPackage["assets"][string]>>;
  /** Move, rotate or scale by stable ID. */
  readonly overrides?: Readonly<Record<string, PlacementEdit>>;
  /** Remove by stable ID. */
  readonly remove?: readonly string[];
  /** Remove every record inside a circle. */
  readonly clear?: readonly {
    readonly center: readonly [number, number];
    readonly radius: number;
    readonly assets?: readonly string[];
  }[];
  /** New records. Each `id` must not already exist. */
  readonly add?: readonly (PlacementEdit & { readonly id: string; readonly asset: string })[];
}

export interface IRemovedPlacement {
  readonly id: string;
  readonly asset: string;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: number;
}

interface IEditablePlacement {
  readonly id?: string;
  readonly asset: string;
  readonly position: [number, number, number];
  readonly quaternion: [number, number, number, number];
  readonly scale: [number, number, number];
  readonly originalCell?: string;
}

interface IClearEdit {
  readonly center: readonly [number, number];
  readonly radius: number;
  readonly assets?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error(`${label} must contain 1–256 characters.`);
  return value;
}

function packagePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error(`${label} must be a package-relative path.`);
  return value;
}

function idList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result = value.map((entry, index) => id(entry, `${label}[${String(index)}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate IDs.`);
  return result;
}

function normalizeClears(
  value: unknown,
  assets: Readonly<Record<string, IWorldAsset>>,
): IClearEdit[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("clear must be an array.");
  return value.map((entry, index) => {
    const label = `clear[${String(index)}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
    const allowed = new Set(["center", "radius", "assets"]);
    if (Object.keys(entry).some((key) => !allowed.has(key)))
      throw new Error(`${label} contains an unknown field.`);
    const center = entry.center;
    if (
      !Array.isArray(center) ||
      center.length !== 2 ||
      !center.every((component) => typeof component === "number" && Number.isFinite(component))
    )
      throw new Error(`${label}.center must contain two finite numbers.`);
    if (typeof entry.radius !== "number" || !Number.isFinite(entry.radius) || entry.radius < 0)
      throw new Error(`${label}.radius must be a finite non-negative number.`);
    const filtered = entry.assets;
    if (filtered !== undefined && !Array.isArray(filtered))
      throw new Error(`${label}.assets must be an array.`);
    const selected = filtered?.map((asset, assetIndex) =>
      id(asset, `${label}.assets[${String(assetIndex)}]`),
    );
    if (selected !== undefined && new Set(selected).size !== selected.length)
      throw new Error(`${label}.assets contains duplicate IDs.`);
    for (const asset of selected ?? [])
      if (!Object.hasOwn(assets, asset))
        throw new Error(`${label}.assets names unknown asset '${asset}'.`);
    return {
      assets: selected,
      center: [center[0] as number, center[1] as number],
      radius: entry.radius,
    };
  });
}

function normalizeAssets(
  value: IWorldPlacementEdits["assets"],
  current: Readonly<Record<string, IWorldAsset>>,
): Record<string, IWorldAsset> {
  if (value === undefined) return { ...current };
  if (!isRecord(value)) throw new Error("assets must be an object.");
  const edits: Record<string, IWorldAsset> = {};
  for (const [assetId, valueOfAsset] of Object.entries(value)) {
    const asset = id(assetId, "Asset ID");
    if (!isRecord(valueOfAsset)) throw new Error(`assets.${asset} must be an object.`);
    packagePath(valueOfAsset.glb, `assets.${asset}.glb`);
    if (valueOfAsset.lods !== undefined) {
      if (!Array.isArray(valueOfAsset.lods))
        throw new Error(`assets.${asset}.lods must be an array.`);
      for (const [index, lod] of valueOfAsset.lods.entries()) {
        if (!isRecord(lod))
          throw new Error(`assets.${asset}.lods[${String(index)}] must be an object.`);
        packagePath(lod.glb, `assets.${asset}.lods[${String(index)}].glb`);
      }
    }
    edits[asset] = valueOfAsset;
  }
  return { ...current, ...edits };
}

function normalizeAdds(
  value: unknown,
  assets: Readonly<Record<string, IWorldAsset>>,
): Array<{ id: string; asset: string; transform: IPlacementOverride }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("add must be an array.");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const label = `add[${String(index)}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
    const placementId = id(entry.id, `${label}.id`);
    if (seen.has(placementId)) throw new Error(`add contains duplicate ID '${placementId}'.`);
    seen.add(placementId);
    const asset = id(entry.asset, `${label}.asset`);
    if (!Object.hasOwn(assets, asset))
      throw new Error(`${label}.asset names unknown asset '${asset}'.`);
    const allowed = new Set(["id", "asset", "position", "quaternion", "scale", "grounding"]);
    if (Object.keys(entry).some((key) => !allowed.has(key)))
      throw new Error(`${label} contains an unknown field.`);
    const transform = validatePlacementOverrides({
      [placementId]: {
        position: entry.position,
        quaternion: entry.quaternion,
        scale: entry.scale,
        ...(entry.grounding === undefined ? {} : { grounding: entry.grounding }),
      },
    })[placementId] as IPlacementOverride;
    return { asset, id: placementId, transform };
  });
}

export function validatePlacementIds(value: unknown, count: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== count)
    throw new Error(`placement IDs count must equal the ${String(count)} placement records.`);
  const result = value.map((entry, index) => id(entry, `placement IDs[${String(index)}]`));
  if (new Set(result).size !== result.length) throw new Error("placement IDs must be unique.");
  return result;
}

function cellKey(x: number, z: number): string {
  return `${String(x)},${String(z)}`;
}

function sourceCellIndex(
  manifest: IWorldPackage,
  recordCount: number,
): { assets: string[]; cells: string[] } {
  const assets: Array<string | undefined> = Array.from({ length: recordCount });
  const cells: Array<string | undefined> = Array.from({ length: recordCount });
  for (const cell of manifest.cells) {
    const key = cellKey(cell.x, cell.z);
    for (const run of cell.runs) {
      if (
        !Number.isInteger(run.offset) ||
        !Number.isInteger(run.count) ||
        run.offset < 0 ||
        run.count < 0 ||
        run.offset + run.count > recordCount
      )
        throw new Error(`World package run for '${run.asset}' is outside the placement buffer.`);
      if (!Object.hasOwn(manifest.assets, run.asset))
        throw new Error(`World package run names unknown asset '${run.asset}'.`);
      for (let index = run.offset; index < run.offset + run.count; index += 1) {
        if (assets[index] !== undefined)
          throw new Error(`World package record ${String(index)} is indexed twice.`);
        assets[index] = run.asset;
        cells[index] = key;
      }
    }
  }
  if (assets.some((asset) => asset === undefined))
    throw new Error("World package has placement records that no cell run indexes.");
  return { assets: assets as string[], cells: cells as string[] };
}

function writeItem(item: IEditablePlacement, index: number): IPlacement {
  return {
    alignToNormal: false,
    asset: item.asset,
    id: item.id ?? `record-${String(index)}`,
    layer: "world",
    normal: [0, 1, 0],
    position: [...item.position],
    rotation: 0,
    scale: item.scale[0] as number,
    transform: {
      grounding: false,
      position: [...item.position],
      quaternion: [...item.quaternion],
      scale: [...item.scale],
    },
  };
}

function mergeCells(
  original: readonly IWorldCell[],
  generated: readonly IWorldCell[],
  changed: ReadonlySet<string>,
): IWorldCell[] {
  const oldByKey = new Map<string, IWorldCell>();
  for (const cell of original) {
    const key = cellKey(cell.x, cell.z);
    if (oldByKey.has(key)) throw new Error(`World package contains duplicate cell '${key}'.`);
    oldByKey.set(key, cell);
  }
  const generatedByKey = new Map(generated.map((cell) => [cellKey(cell.x, cell.z), cell]));
  const keys = [...new Set([...oldByKey.keys(), ...generatedByKey.keys()])].sort((left, right) => {
    const [leftX = 0, leftZ = 0] = left.split(",").map(Number);
    const [rightX = 0, rightZ = 0] = right.split(",").map(Number);
    return leftX - rightX || leftZ - rightZ;
  });
  return keys.map((key) => {
    const oldCell = oldByKey.get(key);
    const next = generatedByKey.get(key) ?? {
      runs: [],
      x: oldCell?.x ?? 0,
      z: oldCell?.z ?? 0,
    };
    const proxy = oldCell?.proxy;
    return {
      ...next,
      ...(oldCell?.chunks === undefined ? {} : { chunks: oldCell.chunks }),
      ...(proxy === undefined || (changed.has(key) && proxy.scope === "cell") ? {} : { proxy }),
    };
  });
}

/**
 * Apply deterministic startup edits to the decoded placement data before a world is loaded.
 *
 * @situation change generated terrain composition from game source without rebaking the world
 * @requires npm i -D @threenative/terrain
 * @example const edited = editWorldPlacements(data, { remove: ["scree:candidate:7:41"] }, (x, z) => field.heightAt(x, z));
 * @override grounding defaults on, while `grounding: false` preserves the authored Y coordinate
 */
export function editWorldPlacements(
  data: { manifest: IWorldPackage; placements: ArrayBuffer; ids?: readonly string[] },
  edits: IWorldPlacementEdits,
  heightAt: (x: number, z: number) => number,
): {
  manifest: IWorldPackage;
  placements: ArrayBuffer;
  ids?: readonly string[];
  unmatched: readonly string[];
  removed: readonly IRemovedPlacement[];
} {
  if (!(data.placements instanceof ArrayBuffer) || data.placements.byteLength % RECORD_BYTES !== 0)
    throw new Error(
      "placements must be an ArrayBuffer containing eight float32 values per record.",
    );
  if (typeof heightAt !== "function") throw new Error("heightAt must be a function.");
  if (typeof edits !== "object" || edits === null || Array.isArray(edits))
    throw new Error("placement edits must be an object.");
  const allowed = new Set(["assets", "overrides", "remove", "clear", "add"]);
  if (Object.keys(edits).some((key) => !allowed.has(key)))
    throw new Error("placement edits contains an unknown field.");

  const sourceManifest = data.manifest;
  const recordCount = data.placements.byteLength / RECORD_BYTES;
  const sourceIds = validatePlacementIds(data.ids, recordCount);
  const indexed = sourceCellIndex(sourceManifest, recordCount);
  const finalAssets = normalizeAssets(edits.assets, sourceManifest.assets);
  const clears = normalizeClears(edits.clear, finalAssets);
  const remove = idList(edits.remove, "remove");
  const overrides = validatePlacementOverrides(edits.overrides ?? {});
  const adds = normalizeAdds(edits.add, finalAssets);
  const overrideIds = new Set(Object.keys(overrides));
  if ((remove.length > 0 || overrideIds.size > 0) && sourceIds === undefined)
    throw new Error("Placement ID edits require a sidecar; re-bake once to add placement IDs.");
  for (const placementId of remove)
    if (overrideIds.has(placementId))
      throw new Error(`Placement '${placementId}' cannot be in both remove and overrides.`);
  if (sourceIds !== undefined) {
    const sourceIdSet = new Set(sourceIds);
    for (const addition of adds)
      if (sourceIdSet.has(addition.id))
        throw new Error(`Added placement '${addition.id}' already exists.`);
  }

  const floats = new Float32Array(data.placements);
  let current: IEditablePlacement[] = Array.from({ length: recordCount }, (_, index) => {
    const offset = index * RECORD_VALUES;
    const scale = floats[offset + 7] as number;
    return {
      asset: indexed.assets[index] as string,
      id: sourceIds?.[index],
      originalCell: indexed.cells[index],
      position: [
        floats[offset] as number,
        floats[offset + 1] as number,
        floats[offset + 2] as number,
      ],
      quaternion: [
        floats[offset + 3] as number,
        floats[offset + 4] as number,
        floats[offset + 5] as number,
        floats[offset + 6] as number,
      ],
      scale: [scale, scale, scale],
    };
  });
  const changedCells = new Set<string>();
  const unmatched: string[] = [];
  const removed: IRemovedPlacement[] = [];
  for (const placementId of remove) {
    const index = current.findIndex((item) => item.id === placementId);
    if (index < 0) {
      unmatched.push(placementId);
      continue;
    }
    const [item] = current.splice(index, 1);
    if (item === undefined)
      throw new Error(`Placement '${placementId}' disappeared during removal.`);
    if (item.originalCell !== undefined) changedCells.add(item.originalCell);
    removed.push({
      asset: item.asset,
      id: placementId,
      position: [...item.position],
      quaternion: [...item.quaternion],
      scale: item.scale[0] as number,
    });
  }
  for (const clear of clears) {
    const radiusSquared = clear.radius * clear.radius;
    current = current.filter((item) => {
      if (item.id !== undefined && overrideIds.has(item.id)) return true;
      const dx = item.position[0] - clear.center[0];
      const dz = item.position[2] - clear.center[1];
      const matchesAsset = clear.assets === undefined || clear.assets.includes(item.asset);
      const hit = matchesAsset && dx * dx + dz * dz <= radiusSquared;
      if (hit && item.originalCell !== undefined) changedCells.add(item.originalCell);
      return !hit;
    });
  }
  for (const [placementId, override] of Object.entries(overrides)) {
    const index = current.findIndex((item) => item.id === placementId);
    if (index < 0) {
      unmatched.push(placementId);
      continue;
    }
    const item = current[index] as IEditablePlacement;
    if (item.originalCell !== undefined) changedCells.add(item.originalCell);
    const position: [number, number, number] = [
      override.position[0],
      override.position[1],
      override.position[2],
    ];
    if (override.grounding) position[1] = heightAt(position[0], position[2]);
    current[index] = {
      ...item,
      position,
      quaternion: [...override.quaternion],
      scale: [...override.scale],
    };
  }
  for (const addition of adds) {
    const position: [number, number, number] = [
      addition.transform.position[0],
      addition.transform.position[1],
      addition.transform.position[2],
    ];
    if (addition.transform.grounding) position[1] = heightAt(position[0], position[2]);
    current.push({
      asset: addition.asset,
      id: addition.id,
      position,
      quaternion: [...addition.transform.quaternion],
      scale: [...addition.transform.scale],
    });
  }
  if (unmatched.length > 0)
    console.warn(`World placement edits: unmatched IDs: ${unmatched.join(", ")}`);

  const acrossX = Math.max(1, Math.ceil(sourceManifest.extent.sizeX / sourceManifest.cellSize));
  const cellFor = (position: readonly [number, number, number]): string => {
    const x = Math.min(
      acrossX - 1,
      Math.max(0, Math.floor((position[0] - sourceManifest.extent.minX) / sourceManifest.cellSize)),
    );
    const z = Math.min(
      Math.max(0, Math.ceil(sourceManifest.extent.sizeZ / sourceManifest.cellSize) - 1),
      Math.max(0, Math.floor((position[2] - sourceManifest.extent.minZ) / sourceManifest.cellSize)),
    );
    return cellKey(x, z);
  };
  for (const item of current) {
    const finalCell = cellFor(item.position);
    if (item.originalCell !== undefined && item.originalCell !== finalCell)
      changedCells.add(finalCell);
    if (item.originalCell === undefined || item.originalCell !== finalCell)
      changedCells.add(finalCell);
    if (Object.hasOwn(edits.assets ?? {}, item.asset)) changedCells.add(finalCell);
  }

  const baked = placementCells(
    { instances: current.map(writeItem) },
    finalAssets,
    sourceManifest.cellSize,
    sourceManifest.extent,
  );
  const bytes = baked.bytes;
  const manifest = {
    ...sourceManifest,
    assets: finalAssets,
    cells: mergeCells(sourceManifest.cells, baked.cells, changedCells),
  } as IWorldPackage;
  const validation = validateWorldPackage(manifest, { placementsByteLength: bytes.byteLength });
  if (!validation.ok)
    throw new Error(
      `Edited world package is invalid: ${validation.errors[0]?.message ?? "unknown error"}`,
    );
  return {
    ids: sourceIds === undefined ? undefined : baked.ids,
    manifest,
    placements: bytes.buffer as ArrayBuffer,
    removed,
    unmatched,
  };
}
