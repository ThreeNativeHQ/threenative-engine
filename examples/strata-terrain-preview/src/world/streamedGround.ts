import type { ICtx } from "@threenative/core";
import {
  AdmissionBudget,
  type IWorldTileColliderInput,
  TerrainTiles,
  warmUnculled,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import type { Object3D } from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import type { WorldName } from "../render/biomes.js";
import { HORIZON_REACH, createWorldHeight } from "../render/ground/horizon.js";
import type { IBakedWorld, ITerrainStream } from "../render/ground/terrain.js";

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
): { dispose(): void; readonly ready: Promise<void>; readonly tiles: TerrainTiles } {
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
  ctx.beforeRender(() => {
    tiles.follow(follow.position, new AdmissionBudget(ADMISSION_MS, () => performance.now()));
    split.centre.value.set(
      Math.floor((follow.position.x + TILE / 2) / TILE) * TILE,
      Math.floor((follow.position.z + TILE / 2) / TILE) * TILE,
    );
    split.half.value = tiles.settledHalf(follow.position);
    report({
      streamTiles: tiles.residentTileCount,
      streamCoveredHalf: split.half.value,
      streamSeamGap: tiles.maxSeamGap ?? -1,
    });
  });
  // The tiles around the spawn draw unculled behind the curtain until the whole block has drawn
  // twice, so their pipelines are built before the reveal (the spawn view sees few of them). The
  // stream runs once per world draw, because the fixed step does not run while the curtain is up.
  const full = (RADIUS + 0.5) * TILE;
  const ready = warmUnculled(ctx, tiles, { when: () => split.half.value === full });
  return {
    ready,
    tiles,
    dispose: () => {
      split.half.value = 0;
      tiles.removeFromParent();
      tiles.dispose();
      surface.dispose();
    },
  };
}
