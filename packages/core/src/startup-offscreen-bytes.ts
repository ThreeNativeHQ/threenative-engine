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
 * A one-off measurement walk, like the playtest observer's, under the same mark: three-native's
 * bridge census then never bills its re-reads of every child to the game's frame.
 */
export function unbilled<T>(work: () => T): T {
  const host = globalThis as { __tnPlaytestObserving?: number };
  host.__tnPlaytestObserving = (host.__tnPlaytestObserving ?? 0) + 1;
  try {
    return work();
  } finally {
    host.__tnPlaytestObserving -= 1;
  }
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
  const objects = unbilled(() => holders(root, camera));
  let awaitedBytes = 0;
  let visibleBytes = 0;
  let unattributedBytes = 0;
  let unsizedFiles = 0;
  const offscreen: IStartupOffscreenFile[] = [];
  // A load downloads its own file plus the shared images and lightmaps it names, and two models
  // can share an image. Each url counts once: models in view first, so a file any visible model
  // needs is visible, then textures and audio, then the models the camera does not show.
  const counted = new Set<string>();
  const take = (asset: IResolvedAsset): number => {
    let bytes = 0;
    for (const file of asset.files ?? [{ bytes: asset.bytes ?? 0, url: asset.url }]) {
      if (counted.has(file.url)) continue;
      counted.add(file.url);
      bytes += file.bytes;
    }
    awaitedBytes += bytes;
    return bytes;
  };
  const sized = [...resolved].filter(([, asset]) => {
    if ((asset.bytes ?? 0) > 0) return true;
    unsizedFiles += 1;
    return false;
  });
  const rank = ([path, asset]: [string, IResolvedAsset]): number =>
    asset.kind !== "model" ? 1 : objects.get(path)?.shown === true ? 0 : 2;
  sized.sort((a, b) => rank(a) - rank(b));
  for (const [path, asset] of sized) {
    const bytes = take(asset);
    if (asset.kind !== "model") {
      unattributedBytes += bytes;
      continue;
    }
    const holder = objects.get(path);
    if (holder?.shown === true) visibleBytes += bytes;
    else if (bytes > 0)
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

export const ASSET_UNUSED_MARKER = "TN_ASSET_UNUSED";

/**
 * When to look: long enough for a game to build what its first minute needs, short enough that a
 * playtest sees it. Not a game constant — the report states it, and a model the game builds later
 * than this is still a launch wait to move, so the advice holds either way.
 */
export const ASSET_UNUSED_AFTER_MS = 60_000;

export const ASSET_UNUSED_FIX =
  "Nothing in the scene came from these models, which the reveal waited for. If nothing ever " +
  "builds one, delete its load; if the game builds it later, ctx.assets.prefetch it after the " +
  "reveal and load it then. A listed file may also be geometry the game merged into a new buffer, " +
  "which drops its provenance: check that before deleting it.";

/** Models the reveal waited for that no scene object came from, `sinceRevealMs` after the reveal. */
export interface IUnusedModels {
  /** The sum over the files whose size the manifest records. */
  readonly bytes: number;
  /** `bytes` is absent where the manifest records no size: unknown, not zero. */
  readonly files: readonly { readonly bytes?: number; readonly path: string }[];
  readonly fix: string;
  readonly sinceRevealMs: number;
  /** Listed files whose size the manifest does not record, so they are in no byte count. */
  readonly unsizedFiles: number;
}

/**
 * Which awaited models have no stamped object or geometry anywhere under `root`, hidden nodes
 * included: a hidden hull is in use, a model nothing ever cloned is dead weight. `undefined` when
 * every awaited model is in the scene. One stamp walk, no bounds and no frustum.
 */
export function measureUnusedModels(
  resolved: ReadonlyMap<string, IResolvedAsset>,
  root: Object3D,
  sinceRevealMs: number,
): IUnusedModels | undefined {
  const present = unbilled(() => {
    const paths = new Set<string>();
    root.traverse((object) => {
      const geometry = (object as Object3D & { geometry?: { userData?: unknown } }).geometry;
      for (const path of [stampOf(object.userData), stampOf(geometry?.userData)])
        if (path !== undefined) paths.add(path);
    });
    return paths;
  });
  const files = [...resolved]
    .filter(([path, asset]) => asset.kind === "model" && !present.has(path))
    .map(([path, asset]) => (asset.bytes === undefined ? { path } : { bytes: asset.bytes, path }))
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  if (files.length === 0) return undefined;
  return {
    bytes: files.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
    files,
    fix: ASSET_UNUSED_FIX,
    sinceRevealMs,
    unsizedFiles: files.filter((file) => file.bytes === undefined).length,
  };
}

/**
 * Report `TN_ASSET_UNUSED` once, `ASSET_UNUSED_AFTER_MS` after the reveal: the awaited models no
 * scene object came from — a load the launch paid for that nothing drew (Midway paid 22.9 MB for
 * three). Measurement only: a throw costs the report, never the game. Returns the cancel.
 */
export function reportUnusedModelsLater(
  awaited: ReadonlyMap<string, IResolvedAsset>,
  root: Object3D,
  gone: () => boolean,
): () => void {
  const timer = setTimeout(() => {
    if (gone()) return;
    try {
      const unused = measureUnusedModels(awaited, root, ASSET_UNUSED_AFTER_MS);
      if (unused !== undefined) console.warn(`${ASSET_UNUSED_MARKER}:${JSON.stringify(unused)}`);
    } catch (error) {
      console.warn(
        `${ASSET_UNUSED_MARKER}_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, ASSET_UNUSED_AFTER_MS);
  return () => clearTimeout(timer);
}
