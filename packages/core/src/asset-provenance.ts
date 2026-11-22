import type { Object3D } from "three";
import { GEOMETRY_ASSET_KEY } from "./geometry-capture.js";

/** The `userData` key recording all distinct logical asset paths merged into one buffer. */
export const GEOMETRY_ASSET_KEYS = "tnAssetPaths";

function collectUnique(target: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value === "" || seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

/** Read single- and multi-asset provenance stamps from a `userData` record. */
export function readAssetProvenance(userData: unknown): string[] {
  if (typeof userData !== "object" || userData === null) return [];
  const record = userData as Record<string, unknown>;
  const paths: string[] = [];
  const seen = new Set<string>();
  collectUnique(paths, seen, record[GEOMETRY_ASSET_KEY]);
  const multi = record[GEOMETRY_ASSET_KEYS];
  if (Array.isArray(multi)) {
    for (const entry of multi) collectUnique(paths, seen, entry);
  }
  return paths;
}

/** Collect provenance stamps along an object's ancestry from the node up to its root. */
export function ancestorAssetProvenance(object: Object3D | null): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let node: Object3D | null = object;
  while (node !== null) {
    for (const path of readAssetProvenance(node.userData)) collectUnique(paths, seen, path);
    node = node.parent;
  }
  return paths;
}

/**
 * Write canonical provenance stamps onto a `userData` record.
 *
 * Zero paths clear both keys so pooled meshes never retain a previous caller's provenance.
 */
export function writeAssetProvenance(
  userData: Record<string, unknown>,
  paths: Iterable<string>,
): void {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) collectUnique(unique, seen, path);
  if (unique.length === 0) {
    delete userData[GEOMETRY_ASSET_KEY];
    delete userData[GEOMETRY_ASSET_KEYS];
    return;
  }
  if (unique.length === 1) {
    userData[GEOMETRY_ASSET_KEY] = unique[0];
    delete userData[GEOMETRY_ASSET_KEYS];
    return;
  }
  delete userData[GEOMETRY_ASSET_KEY];
  userData[GEOMETRY_ASSET_KEYS] = unique;
}

/** Replace provenance on `toUserData` with the stamps read from `fromUserData`. */
export function copyAssetProvenance(
  fromUserData: unknown,
  toUserData: Record<string, unknown>,
): void {
  writeAssetProvenance(toUserData, readAssetProvenance(fromUserData));
}

/** Merge provenance from `fromUserData` into `toUserData` when `fromUserData` carries any. */
export function preserveAssetProvenance(
  fromUserData: unknown,
  toUserData: Record<string, unknown>,
): void {
  const incoming = readAssetProvenance(fromUserData);
  if (incoming.length === 0) return;
  writeAssetProvenance(toUserData, [...readAssetProvenance(toUserData), ...incoming]);
}
