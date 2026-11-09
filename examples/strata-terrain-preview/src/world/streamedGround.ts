import type { ICtx } from "@threenative/core";
import {
  type IAdmissionBudget,
  type IWorldTileColliderInput,
  TerrainTiles,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import type { Object3D } from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import type { WorldName } from "../render/biomes.js";
import { HORIZON_REACH, createWorldHeight } from "../render/horizon.js";
import type { IBakedWorld, ITerrainStream } from "../render/terrain.js";

/** Tile width in metres: 32 cells of the square's own 2 m spacing, so tile and square share vertices. */
const TILE = 64;
/** Tiles each side of the player's: a 576 m square, wider than the playable square itself. */
const RADIUS = 4;
/** Tiles each side of the player's that collide: the player only ever stands on its own or a neighbour. */
const COLLIDER_RADIUS = 1;
/** One frame's tile building, in milliseconds; the rest waits for the next frame. */
const ADMISSION_MS = 2;

/**
 * PRD-790: the ground past the playable square, streamed around the player by `TerrainTiles` out to
 * the collar's reach. Tiles sample `createWorldHeight`, the same surface the square and the collar
 * draw, so a tile meets both with no step. The largest block of resident tiles around the player is
 * written to `split` each frame: the tiles draw inside it, the collar everywhere else, so a tile that
 * is still building leaves the collar showing, never a hole.
 */
export function addStreamedGround(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  data: IBakedWorld,
  world: WorldName,
  surface: MeshStandardNodeMaterial,
  split: ITerrainStream,
  follow: Object3D,
  report: (facts: {
    streamTiles: number;
    streamCoveredHalf: number;
    streamSeamGap: number;
  }) => void,
): { dispose(): void; readonly tiles: TerrainTiles } {
  const half = data.size / 2;
  const reach = half + HORIZON_REACH;
  const tiles = new TerrainTiles({
    surface,
    sampleHeight: createWorldHeight(data, world),
    tileSize: TILE,
    tileResolution: TILE / (data.size / (data.resolution - 1)) + 1,
    // One level: 81 tiles of 33² vertices are ~166 k triangles, and a single level meets its
    // neighbour vertex for vertex (mixed levels left a raw 2 m step for the stitches to close).
    lodFactors: [1],
    lodDistances: [],
    streamRadius: RADIUS,
    colliderRadius: COLLIDER_RADIUS,
    residentTileBudget: (2 * RADIUS + 1) ** 2,
    residentByteBudget: Number.MAX_SAFE_INTEGER,
    receiveShadow: true,
    extent: { minX: -reach, maxX: reach, minZ: -reach, maxZ: reach },
    // The square draws and collides its own ground.
    hole: { minX: -half, maxX: half, minZ: -half, maxZ: half },
    createCollider: ({ field, key, object }: IWorldTileColliderInput) =>
      new RigidBody3D({
        object,
        physics: ctx.physics,
        type: "fixed",
        entity: `terrain.${key}`,
        // 4: what the player walks on. 8: the ground alone, for ground queries.
        collisionLayer: 4 | 8,
        shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
          x: TILE,
          y: 1,
          z: TILE,
        }),
      }),
  });
  ctx.add(tiles);
  ctx.afterPhysics(() => {
    let spent = 0;
    const budget: IAdmissionBudget = {
      admit(work) {
        if (spent >= ADMISSION_MS) return false;
        const started = performance.now();
        work();
        spent += performance.now() - started;
        return true;
      },
    };
    tiles.follow(follow.position, budget);
    const centreX = Math.floor((follow.position.x + TILE / 2) / TILE);
    const centreZ = Math.floor((follow.position.z + TILE / 2) / TILE);
    split.centre.value.set(centreX * TILE, centreZ * TILE);
    split.half.value = coveredHalf(tiles, centreX, centreZ, half, reach);
    report({
      streamTiles: tiles.residentTileCount,
      streamCoveredHalf: split.half.value,
      streamSeamGap: tiles.maxSeamGap ?? -1,
    });
  });
  return {
    tiles,
    dispose: () => {
      split.half.value = 0;
      tiles.removeFromParent();
      tiles.dispose();
      surface.dispose();
    },
  };
}

/**
 * Half-width of the largest square of tiles around `centreX, centreZ` that is fully drawn: each tile
 * in it is resident, or lies wholly inside the playable square (the square draws it) or wholly past
 * the reach (nothing draws there). Zero when even the player's own tile is still building.
 */
function coveredHalf(
  tiles: TerrainTiles,
  centreX: number,
  centreZ: number,
  half: number,
  reach: number,
): number {
  const settled = (tileX: number, tileZ: number): boolean => {
    if (tiles.getTile(`${String(tileX)}:${String(tileZ)}`) !== undefined) return true;
    const low = (index: number) => index * TILE - TILE / 2;
    const high = (index: number) => index * TILE + TILE / 2;
    const inside =
      low(tileX) >= -half && high(tileX) <= half && low(tileZ) >= -half && high(tileZ) <= half;
    const past =
      low(tileX) >= reach || high(tileX) <= -reach || low(tileZ) >= reach || high(tileZ) <= -reach;
    return inside || past;
  };
  let ring = -1;
  for (let k = 0; k <= RADIUS; k++) {
    for (let d = -k; d <= k; d++)
      if (
        !settled(centreX + d, centreZ - k) ||
        !settled(centreX + d, centreZ + k) ||
        !settled(centreX - k, centreZ + d) ||
        !settled(centreX + k, centreZ + d)
      )
        return ring < 0 ? 0 : (ring + 0.5) * TILE;
    ring = k;
  }
  return (ring + 0.5) * TILE;
}
