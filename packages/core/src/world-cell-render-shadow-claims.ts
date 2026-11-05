import type { SharedBatch } from "./world-cell-batches.js";
import type { IAssetPart, ICellBatch, IResidentCell } from "./world-cell-data.js";
import type { ICellRenderHost } from "./world-cell-render.js";
import type { WorldGpuScene } from "./world-gpu-scene.js";
import type { IWorldPackage } from "./world-package.js";

/**
 * Who claims a shadow: whether a level casts at all, which shape it casts with, and the block one
 * cell takes in its caster cluster or in the key's wide mesh.
 *
 * These are the decisions the caster halves are made of, and the main cull, the swap and the LOD
 * path read them as well as this module's own claims. They keep no state: a claim is a segment in a
 * `SharedBatch`, and every batch is the world's.
 */

/** What a claim needs from the renderer it is made for. */
export interface IShadowClaimHost {
  render(): ICellRenderHost;
  manifest(): IWorldPackage;
  smallCasterMetres(): number;
  castShadowLevels(): number;
  shadowMinLevel(): number;
  /** Authored parts are kept as their own casters, so a generated impostor does not replace them. */
  preserveAuthoredParts(): boolean;
  gpuScene(): WorldGpuScene;
  /** Resident placements per canonical asset, which a released key's block goes back from. */
  resident(): Map<string, number>;
  /** The caster cluster one cell's records go to, minted on first use. */
  casterFor(
    assetId: string,
    entry: ICellBatch,
    cell: IResidentCell,
    level?: number,
  ): SharedBatch | undefined;
  /** The key's whole-asset wide caster, minted on first use. */
  wideFor(assetId: string, entry: ICellBatch, level?: number): SharedBatch | undefined;
  /** A block in `shared` for one cell's records, grown when the batch is full. */
  segmentIn(shared: SharedBatch, count: number, cluster?: string): number | undefined;
  /** Fresh meshes already charged against this update's allowance. */
  freshCount(): number;
  /** Record that a key's placed count changed, which the caster's own gate reads. */
  countPlaced(entry: ICellBatch, placed: number): void;
}

/**
 * Whether this level's own batches cast. Only the caster clusters ask; a main mesh never casts, so
 * the shadow map holds exactly the cluster meshes a level's window covers.
 */
export function casts(host: IShadowClaimHost, level: number): boolean {
  return host.castShadowLevels() > level;
}

/**
 * An asset too small to resolve in any window but the finest one's, so its wide caster goes on
 * that level's layer alone. Measured on the authored bounds the package carries, which is the one
 * number a world has for every asset it never loaded a tree for.
 */
export function smallCaster(host: IShadowClaimHost, assetId: string): boolean {
  const bounds = host.manifest().assets[assetId]?.bounds;
  if (bounds === undefined) return false;
  return bounds.max[1] - bounds.min[1] < host.smallCasterMetres();
}

/**
 * Whether this entry owes a wide caster. Generated whole-asset impostors use only part 0; preserved
 * authored parts retain each part's own caster and transform.
 */
export function wideOwed(host: IShadowClaimHost, assetId: string, part: number): boolean {
  if (part === 0) return true;
  return host.preserveAuthoredParts() || host.render().asset(assetId)?.impostor === undefined;
}

/**
 * The level a cell batch casts with: its own when that level casts, otherwise the coarsest
 * casting level, when that level holds the same parts — a chain's derived levels do, authored
 * `lods` need not — so a tree past `castLevels` keeps its shadow in the last shape that has a
 * caster rather than leaving a hole in the map (PRD-541). `undefined`: it casts nothing.
 */
export function castLevelOf(host: IShadowClaimHost, entry: ICellBatch): number | undefined {
  const floor = shadowFloorOf(host, entry.asset);
  if (entry.level < floor) return floor;
  if (casts(host, entry.level)) return entry.level;
  if (host.castShadowLevels() === 0) return undefined;
  const asset = host.render().asset(entry.asset);
  if (asset === undefined || asset.definition.lods !== undefined) return undefined;
  const level = Math.min(entry.level, host.castShadowLevels()) - 1;
  return asset.levels[level]?.[entry.part] === undefined ? undefined : level;
}

/**
 * The level this asset's finer placements cast in (`shadows.minLevel`), clamped to a casting
 * level. 0 when a finer level's parts do not line up with it, since a caster draws its own entry's
 * part index and matrices in that level's shape, and when the shadow levels draw the GPU keys.
 */
export function shadowFloorOf(host: IShadowClaimHost, assetId: string): number {
  const asset = host.render().asset(assetId);
  if (asset === undefined || keysForShadow(host)) return 0;
  const floor = Math.min(
    host.shadowMinLevel(),
    host.castShadowLevels() - 1,
    asset.levels.length - 1,
  );
  const coarse = asset.levels[floor];
  if (floor <= 0 || coarse === undefined) return 0;
  for (let level = 0; level < floor; level++) {
    const parts = asset.levels[level];
    if (parts?.length !== coarse.length) return 0;
    for (const [index, part] of parts.entries())
      if (!part.local.equals((coarse[index] as IAssetPart).local)) return 0;
  }
  return floor;
}

/**
 * Whether a shadow level draws this world's keys instead of its two caster halves: the GPU scene
 * is up *and* a provider registered on it, which `?tnShadowGpuKeys=1` is what asks for. Both, or
 * neither — a provider with the scene off is a world whose shadow maps have nothing to draw, so
 * the world keeps the caster path until both are true.
 */
export function keysForShadow(host: IShadowClaimHost): boolean {
  return host.gpuScene().on && host.gpuScene().shadowKeys;
}

/**
 * Claim this cell's block in its caster cluster, when the level casts and it does not have one.
 * `false` means the frame's fresh allowance is spent and the swap waits, so the main mesh and its
 * cluster are never half attached.
 */
export function claimCaster(
  host: IShadowClaimHost,
  assetId: string,
  entry: ICellBatch,
  cell: IResidentCell,
): boolean {
  const level = castLevelOf(host, entry);
  if (entry.casterSegment >= 0 || level === undefined) return true;
  // Nothing to claim, and nothing to wait for: a world whose levels draw its keys mints no caster
  // half at all (`#casterFor`), so reading that as a spent allowance refused every swap in the
  // world — the main mesh was never attached, no cell published its placements, and the main pass
  // drew nothing while its meshes sat there prewarmed and empty.
  if (keysForShadow(host)) return true;
  const caster = host.casterFor(assetId, entry, cell, level);
  const at = caster === undefined ? undefined : host.segmentIn(caster, entry.batch.count);
  if (caster === undefined || at === undefined) return false;
  entry.caster = caster;
  entry.casterSegment = at;
  return true;
}

/**
 * Claim this cell's block in its key's wide caster mesh, when the level casts and it does not
 * have one. `false` means the frame's fresh allowance is spent and the swap waits, so the
 * clusters and the wide half are never half attached.
 */
export function claimWide(host: IShadowClaimHost, assetId: string, entry: ICellBatch): boolean {
  const level = castLevelOf(host, entry);
  if (entry.wideSegment >= 0 || level === undefined) return true;
  // A part the asset's one whole-asset representation already covers: the entry keeps its near
  // main and cluster, and the far shadow reads part 0's one quad; see `#wideOwed`.
  if (!wideOwed(host, assetId, entry.part)) return true;
  // As `#claimCaster`: the key twin is this level's wide half, and there is no mesh to wait on.
  if (keysForShadow(host)) return true;
  const wide = host.wideFor(assetId, entry, level);
  // The impostor's far half draws the placement root, not `placement * part local`, so its block
  // is sized to the root records the build kept beside the part's own; see `ICellBatch.wideRoot`.
  const count = entry.wideRoot?.count ?? entry.batch.count;
  const at = wide === undefined ? undefined : host.segmentIn(wide, count);
  if (wide === undefined || at === undefined) return false;
  entry.wide = wide;
  entry.wideSegment = at;
  return true;
}

export function clearSegment(host: IShadowClaimHost, entry: ICellBatch): void {
  if (entry.shared !== undefined && entry.segment >= 0) entry.shared.clear(entry.segment);
  // The source records go back with the block that held them, on every path a cell's records leave:
  // a refilter's replacement, an eviction, and a queued build dropped with its cell. Releasing one
  // twice is a no-op, which is what lets a level's parts share a single list.
  if (entry.gpu !== undefined) {
    const placed = entry.gpu.length;
    for (const at of entry.gpu) host.gpuScene().release(at);
    const left = (host.resident().get(entry.asset) ?? 0) - placed;
    if (left > 0) host.resident().set(entry.asset, left);
    else host.resident().delete(entry.asset);
    // Before the halves go below, which is what clears the handles this reads.
    host.countPlaced(entry, -placed);
  }
  entry.gpu = undefined;
  if (entry.caster !== undefined && entry.casterSegment >= 0)
    entry.caster.clear(entry.casterSegment);
  if (entry.wide !== undefined && entry.wideSegment >= 0) entry.wide.clear(entry.wideSegment);
  entry.shared = undefined;
  entry.segment = -1;
  entry.caster = undefined;
  entry.casterSegment = -1;
  entry.wide = undefined;
  entry.wideSegment = -1;
}
