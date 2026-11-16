// The alpine kit's prop policy for the streamed bake: which variant a placement draws, how far it
// draws, and which bucket it lands in. Shapes, materials and dressing live in the game's own scene;
// this file only answers the bake's five policy questions.
import type { IPlacement } from "@threenative/terrain";
import { propKey, withAuthoredPose } from "@threenative/terrain/starter";

/** Draw reach per species, metres. Trees hold to the ring; ground cover fades close. */
const REACH: Readonly<Record<string, number>> = {
  spruce: 900,
  scotspine: 900,
  blackspruce: 800,
  sapling: 320,
  boulder: 260,
  rock: 150,
  scree: 120,
  tundragrass: 130,
  tussock: 120,
  fireweed: 90,
  blueberry: 90,
};

/** Species that cast no shadow: ground cover and loose scree. */
const NO_SHADOW = new Set(["tundragrass", "tussock", "fireweed", "blueberry", "scree"]);

/** Three variants per species, picked by a stable hash of the placement id. */
export function variantFor(placement: IPlacement): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < placement.id.length; i += 1) {
    hash ^= placement.id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) % 3;
}

export function streamedReach(placement: IPlacement): number {
  return REACH[placement.asset] ?? 150;
}

export function streamedBucket(placement: IPlacement, reach: number): string {
  return `${reach === Number.POSITIVE_INFINITY ? "horizon" : "local"}:${!NO_SHADOW.has(placement.asset)}`;
}

export const props = {
  variantFor: (placement: IPlacement) => variantFor(placement),
  streamedReach: (placement: IPlacement) => streamedReach(placement),
  streamedBucket: (placement: IPlacement, reach: number) => streamedBucket(placement, reach),
  propKey: (placement: IPlacement) => propKey(placement, variantFor(placement)),
  withAuthoredPose: (placement: IPlacement) => withAuthoredPose(placement),
};
