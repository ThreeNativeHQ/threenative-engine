// The prep half of the prop worlds: the bake's records decoded into placements, posed on the ground,
// and the variant, gate and stats tables `streamProps` hands to `WorldCells`. Kept apart from the
// loader so neither file carries the whole mechanism.
import type { WorldCells } from "@threenative/core/world";
import type { Quaternion, Vector3 } from "three";
import type { IPlacement } from "../core/types.js";
import {
  type IPropBucketEntry,
  type IPropBucketPackage,
  decodePropBucket,
} from "../package/prop-package.js";
import { type preparePose, propKey } from "./prop-pose.js";
import type { IPropWorldOptions } from "./prop-world.js";

/** One placement as its container stores it: the record's numbers and the world it draws in. */
export interface IRecord {
  /** The model the record's run names: `asset:variant`, with the shape a non-uniform edit gave it. */
  readonly key: string;
  readonly placement: IPlacement;
  /** The quaternion the bake authored; `preparePose` takes it as the pose override. */
  readonly quaternion: readonly [number, number, number, number];
  readonly reach: number;
}

/** One grounded placement: the pose the game draws, and the variant its asset resolved to. */
export interface IGroundedRecord {
  readonly key: string;
  readonly placement: IPlacement;
  readonly pose: ReturnType<typeof preparePose>;
  readonly reach: number;
  readonly ratio: Vector3;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: number;
}

/** The bucket's records as placements: the bake's own decode, with the record's model and pose. */
export function recordsOf(bucket: IPropBucketPackage): IRecord[] {
  return decodePropBucket(bucket).map((record) => ({
    key: record.key,
    // A run names the model it draws: the asset, the variant, and the shape when one scale cannot
    // carry the placement. The asset alone is what `preparePose` grounds.
    placement: {
      alignToNormal: false,
      asset: record.asset,
      id: record.id,
      layer: record.asset,
      normal: [0, 1, 0],
      position: [...record.position],
      rotation: 0,
      scale: record.scale,
    },
    quaternion: record.quaternion,
    reach: record.reach,
  }));
}

/** The variant counters the bake left: a live placement's fade continues the stream it joined. */
export function variantSeeds(
  records: readonly IRecord[],
  options: IPropWorldOptions,
): Map<string, number> {
  const seeds = new Map<string, number>();
  for (const record of records) {
    const variant = `${record.placement.asset}:${options.variantOf(record.placement)}`;
    seeds.set(variant, (seeds.get(variant) ?? 0) + 1);
  }
  return seeds;
}

/** The streamed world a live placement joins, and how far it draws. */
export function liveEntries(
  placements: readonly IPlacement[],
  seeds: Map<string, number>,
  options: IPropWorldOptions,
): IPropBucketEntry[] {
  const indices = new Map(seeds);
  return placements.map((placement) => {
    const variant = `${placement.asset}:${options.variantOf(placement)}`;
    const index = indices.get(variant) ?? 0;
    indices.set(variant, index + 1);
    const reach = options.reachOf(placement, index);
    const row = options.bucketOf(placement, reach);
    return {
      bucket: row.name,
      key: propKey(placement, options.variantOf(placement)),
      kind: row.kind,
      placement,
      reach,
    };
  });
}

/** The camera-independent stats the run report reads, summed over every streamed world. */
export function statsOf(worlds: readonly WorldCells[]) {
  return worlds.reduce(
    (sum, world) => {
      const s = world.stats();
      return {
        residentCells: sum.residentCells + s.residentCells,
        loadedCells: sum.loadedCells + s.loadedCells,
        instances: sum.instances + s.instances,
        evictions: sum.evictions + s.evictions,
        failures: sum.failures + s.failures,
        loadsInFlight: sum.loadsInFlight + s.loadsInFlight,
        loadsQueued: sum.loadsQueued + s.loadsQueued,
        pendingPrewarm: sum.pendingPrewarm + s.pendingPrewarm,
        impostor: {
          pending: sum.impostor.pending + s.impostor.pending,
          drawn: sum.impostor.drawn + s.impostor.drawn,
        },
        admissionMs: sum.admissionMs + s.admission.spentMs,
        admissionBacklog: sum.admissionBacklog + s.admission.backlog,
        admissionDeferred: sum.admissionDeferred + s.admission.deferred,
      };
    },
    {
      residentCells: 0,
      loadedCells: 0,
      instances: 0,
      evictions: 0,
      failures: 0,
      loadsInFlight: 0,
      loadsQueued: 0,
      pendingPrewarm: 0,
      impostor: { pending: 0, drawn: 0 },
      admissionMs: 0,
      admissionBacklog: 0,
      admissionDeferred: 0,
    },
  );
}

/** The placement IDs the bake wrote: the load plants only the ground the bake left out. */
export function bakedIds(plans: readonly IPropBucketPackage[]): Set<string> {
  const ids = new Set<string>();
  for (const plan of plans) for (const id of plan.ids) ids.add(id);
  return ids;
}

/**
 * The terminal gate a gate asset's variant switches to the engine's whole-asset impostor at.
 *
 * A scaled tree's gate divides by its scale, so the minimum scale of its variant is what keeps the
 * gate beyond the last authored level. A gate inside that step pops the whole tree at a distance the
 * player can see it.
 */
export function impostorDistanceForScale(
  minScale: number,
  lastLodDistance: number,
  farBand: number,
): number {
  if (!Number.isFinite(minScale) || minScale === 0)
    throw new Error("Gate asset terminal distance requires a positive finite placement scale.");
  return Math.max(farBand / Math.abs(minScale), lastLodDistance * (1 + Number.EPSILON));
}

/**
 * The scale each streamed gate variant's terminal gate divides by: the smallest one it draws.
 *
 * The gate divides by a variant's minimum scale, so the minimum is taken over the placements that
 * actually draw it — every gate asset the far field does not own, keyed by the variant that draws it.
 * One bucket's minimum, or a far tree's, puts a gate inside a step the player sees pop.
 */
export function gateScales(
  drawn: Iterable<{ readonly placement: IPlacement; readonly scale: number }>,
  options: IPropWorldOptions,
): Map<string, number> {
  const gates = new Map<string, number>();
  for (const { placement, scale } of drawn) {
    if (placement.asset !== options.gateAsset) continue;
    if (options.bucketOf(placement, Number.POSITIVE_INFINITY).kind === "far") continue;
    const variant = `${placement.asset}:${options.variantOf(placement)}`;
    gates.set(variant, Math.min(gates.get(variant) ?? Number.POSITIVE_INFINITY, Math.abs(scale)));
  }
  return gates;
}
