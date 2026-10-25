import { Box3, type Camera, Frustum, Matrix4, type Object3D } from "three";
import type { IResolvedAsset } from "./assets.js";
import { GEOMETRY_ASSET_KEY } from "./geometry-capture.js";

/** Why a file the reveal waited for shows nothing at the reveal. */
export type OffscreenReason = "hidden" | "not-placed" | "outside-view";

export interface IStartupOffscreenFile {
  readonly bytes: number;
  readonly path: string;
  readonly reason: OffscreenReason;
}

/**
 * What the reveal waited for, split by whether the spawn camera shows it.
 *
 * Measured, never configured: nothing here is compared with a fixed size. `warn` is a ratio of two
 * numbers from the same run (off-screen bytes against visible bytes), so no constant needs
 * revisiting when links or games change.
 */
export interface IStartupOffscreenBytes {
  /** Every sized byte the reveal waited for through `ctx.assets`. */
  readonly awaitedBytes: number;
  /** The fix, so a reader of one console line needs no other document. */
  readonly fix: string;
  /** Bytes of models with an object in view. */
  readonly visibleBytes: number;
  /** Bytes of models with no visible object in the frustum. */
  readonly offscreenBytes: number;
  /** Textures and audio: no scene object ties them to a view, so the engine does not guess. */
  readonly unattributedBytes: number;
  /** Awaited files whose size the manifest does not record, so they are in no byte count. */
  readonly unsizedFiles: number;
  /** The five largest off-screen files. */
  readonly top: readonly IStartupOffscreenFile[];
  /** Most of the wait bought nothing on screen: off-screen bytes exceed visible bytes. */
  readonly warn: boolean;
}

export const STARTUP_OFFSCREEN_BYTES_MARKER = "TN_STARTUP_OFFSCREEN_BYTES";

export const STARTUP_OFFSCREEN_FIX =
  "Stream these files with WorldCells, or ctx.assets.prefetch them after the reveal, and keep " +
  "awaiting everything the spawn camera sees. A not-placed file may also be geometry the game " +
  "merged into a new buffer, which drops its provenance: check that before moving it.";

const TOP_FILES = 5;

function stampOf(userData: unknown): string | undefined {
  const stamped = (userData as Record<string, unknown> | undefined)?.[GEOMETRY_ASSET_KEY];
  return typeof stamped === "string" && stamped !== "" ? stamped : undefined;
}

/**
 * Which logical paths have an object in the scene, and whether any of them shows.
 *
 * A path is stamped on the model root and on every mesh geometry the loader returned, so an
 * instanced batch built from a model's geometry keeps it even though the root never enters the
 * scene. "Shows" means visible through the whole ancestry with world bounds in the frustum.
 */
function holders(root: Object3D, camera: Camera): Map<string, { shown: boolean; placed: boolean }> {
  camera.updateWorldMatrix(true, false);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const found = new Map<string, { shown: boolean; placed: boolean }>();
  const box = new Box3();
  const visit = (object: Object3D, hidden: boolean): void => {
    const isHidden = hidden || !object.visible;
    const geometry = (object as Object3D & { geometry?: { userData?: unknown } }).geometry;
    for (const path of new Set([stampOf(object.userData), stampOf(geometry?.userData)])) {
      if (path === undefined) continue;
      const entry = found.get(path) ?? { placed: false, shown: false };
      found.set(path, entry);
      if (isHidden) continue;
      entry.placed = true;
      if (!entry.shown && !box.setFromObject(object).isEmpty() && frustum.intersectsBox(box))
        entry.shown = true;
    }
    for (const child of object.children) visit(child, isHidden);
  };
  visit(root, false);
  return found;
}

/**
 * Split the bytes a reveal waited for into what the spawn camera shows and what it does not.
 *
 * `resolved` is `ctx.assets.resolved` at the reveal: every path that settled by then, with the
 * kind and manifest size the loader recorded. A path with no stamp anywhere in `root` reads
 * `not-placed`; a path stamped only under a hidden node reads `hidden`; otherwise a path whose
 * bounds miss the frustum reads `outside-view`.
 */
export function measureStartupOffscreenBytes(
  resolved: ReadonlyMap<string, IResolvedAsset>,
  root: Object3D,
  camera: Camera,
): IStartupOffscreenBytes {
  const objects = holders(root, camera);
  let awaitedBytes = 0;
  let visibleBytes = 0;
  let unattributedBytes = 0;
  let unsizedFiles = 0;
  const offscreen: IStartupOffscreenFile[] = [];
  for (const [path, asset] of resolved) {
    const bytes = asset.bytes ?? 0;
    if (bytes <= 0) {
      unsizedFiles += 1;
      continue;
    }
    awaitedBytes += bytes;
    if (asset.kind !== "model") {
      unattributedBytes += bytes;
      continue;
    }
    const holder = objects.get(path);
    if (holder?.shown === true) visibleBytes += bytes;
    else
      offscreen.push({
        bytes,
        path,
        reason: holder === undefined ? "not-placed" : holder.placed ? "outside-view" : "hidden",
      });
  }
  offscreen.sort((a, b) => b.bytes - a.bytes);
  const offscreenBytes = offscreen.reduce((sum, file) => sum + file.bytes, 0);
  return {
    awaitedBytes,
    fix: STARTUP_OFFSCREEN_FIX,
    offscreenBytes,
    top: offscreen.slice(0, TOP_FILES),
    unattributedBytes,
    unsizedFiles,
    visibleBytes,
    warn: offscreenBytes > visibleBytes,
  };
}
