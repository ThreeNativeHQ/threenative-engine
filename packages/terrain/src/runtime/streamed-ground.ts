import type { ICtx } from "@threenative/core";
import {
  AdmissionBudget,
  type HeightfieldCollar,
  type IWorldTileColliderInput,
  TerrainTiles,
  warmUnculled,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import type { Object3D } from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import {
  type ICollarRingCurve,
  type ICollarStream,
  STREAM_TILE,
  collarSeamGap,
  createMorphedHeight,
} from "./collar.js";

/** Tiles each side of the player's: a 576 m square, wider than the playable square itself. */
const RADIUS = 4;
/** Tiles each side of the player's that collide: the player only ever stands on its own or a neighbour. */
const COLLIDER_RADIUS = 1;
/** One frame's tile building, in milliseconds; the rest waits for the next frame. */
const ADMISSION_MS = 2;

/** What one frame of streaming reports into the scene's own state. */
export interface IStreamedGroundFacts {
  readonly streamTiles: number;
  readonly streamCoveredHalf: number;
  readonly streamSeamGap: number;
  readonly streamCollarGap: number;
  readonly streamCollarFold: number;
}

/** Everything the mechanism reads: the game's ground and collar, and the block it follows. */
export interface IStreamedGroundOptions {
  /** The scene's context: it owns the tiles' lifetime and the physics bodies. */
  readonly ctx: ICtx<Record<string, unknown>, IPhysicsContext>;
  /** The world's own name, for the one line a malformed kit leaves behind. */
  readonly name: string;
  /** The playable square's side, metres. */
  readonly size: number;
  /** The square heightfield's samples per side; the tile grid shares its spacing. */
  readonly resolution: number;
  /**
   * The ground at any `(x, z)` of the world, the square and the collar both: the kit's own survey
   * function, so a tile meets the square and its neighbours with no step.
   */
  readonly height: (x: number, z: number) => number;
  /** The collar the square grows out to; the tiles stop at its rim. */
  readonly collar: HeightfieldCollar;
  /** The curve the collar's rings were built with, so the morph inverts it. */
  readonly curve: ICollarRingCurve;
  /** Metres past the square's edge the collar reaches: the stream ends there. */
  readonly reach: number;
  /** The block the tiles draw, read by the tile material's collar morph. */
  readonly stream: ICollarStream;
  /** The ground material the tiles draw with, owned by the game and disposed with the tiles. */
  readonly surface: MeshStandardNodeMaterial;
  /** What the block follows: the player's actor. */
  readonly follow: Object3D;
  /** Where each frame's resident tiles and seam measures go. */
  readonly report: (facts: IStreamedGroundFacts) => void;
}

/**
 * PRD-790: the ground past the playable square, streamed around the player by `TerrainTiles` out to
 * the collar's reach. Tiles sample the kit's own height function, the surface the square and the
 * collar's vertices stand on, so a tile meets the square and its neighbours with no step. The tile
 * material slides the outermost tile onto the collar's drawn height (`collarMorph`), so at the
 * collar every tile vertex stands on it; `?tnTerrainValidate=1` reports `streamCollarGap`. The
 * largest block of resident tiles around the player is written to the stream each frame: the tiles
 * draw inside it, the collar everywhere else, so a tile that is still building leaves the collar
 * showing, never a hole.
 *
 * @requires npm i -D @threenative/terrain @threenative/physics
 * @situation stream an authored square's ground past its edge, out to a drawn collar
 * @constraint the game supplies the height, the collar, its curve and the tile material
 * @example const ground = addStreamedGround({ ctx, name, size, resolution, height, collar, curve, reach, stream, surface, follow, report });
 */
export function addStreamedGround(options: IStreamedGroundOptions): {
  dispose(): void;
  readonly ready: Promise<void>;
  readonly tiles: TerrainTiles;
} {
  const { ctx, name, size, resolution, height, collar, curve, reach, stream, surface, follow } =
    options;
  if (!(size > 0) || !Number.isInteger(resolution) || resolution < 2)
    throw new Error(
      `TN_STARTER_GROUND_DATA: ${name} world: a ${resolution}² grid over ${size} m cannot stream ground.`,
    );
  const half = size / 2;
  const extent = half + reach;
  const spacing = size / (resolution - 1);
  const tiles = new TerrainTiles({
    surface,
    sampleHeight: height,
    tileSize: STREAM_TILE,
    tileResolution: STREAM_TILE / spacing + 1,
    // One level: 81 tiles of 33² vertices are ~166 k triangles, and a single level meets its
    // neighbour vertex for vertex (mixed levels left a raw 2 m step for the stitches to close).
    lodFactors: [1],
    lodDistances: [],
    streamRadius: RADIUS,
    colliderRadius: COLLIDER_RADIUS,
    residentTileBudget: (2 * RADIUS + 1) ** 2,
    residentByteBudget: Number.MAX_SAFE_INTEGER,
    receiveShadow: true,
    extent: { minX: -extent, maxX: extent, minZ: -extent, maxZ: extent },
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
          x: STREAM_TILE,
          y: 1,
          z: STREAM_TILE,
        }),
      }),
  });
  ctx.add(tiles);
  // `?tnTerrainValidate=1`: the tile-to-collar seam, read along the split square's edge each time it
  // moves; tile-to-tile seams are core's `maxSeamGap`.
  const collarSeam = { fold: 0, gap: 0, key: "" };
  ctx.beforeRender(() => {
    tiles.follow(follow.position, new AdmissionBudget(ADMISSION_MS, () => performance.now()));
    stream.centre.value.set(
      Math.floor((follow.position.x + STREAM_TILE / 2) / STREAM_TILE) * STREAM_TILE,
      Math.floor((follow.position.z + STREAM_TILE / 2) / STREAM_TILE) * STREAM_TILE,
    );
    stream.half.value = tiles.settledHalf(follow.position);
    const tileSeam = tiles.maxSeamGap;
    const { x, y } = stream.centre.value;
    const key = `${x},${y},${stream.half.value}`;
    if (tileSeam !== undefined && stream.half.value > 0 && key !== collarSeam.key) {
      // Every 0.5 m, 0.7 ms per move; 0.1 m cost 4.2 ms and read the same fold on the route.
      const morphed = createMorphedHeight(
        collar,
        curve,
        height,
        x,
        y,
        stream.half.value,
        STREAM_TILE,
      );
      const seam = collarSeamGap(collar, morphed, x, y, stream.half.value, spacing, 0.5);
      collarSeam.gap = Math.max(collarSeam.gap, seam.gap);
      collarSeam.fold = Math.max(collarSeam.fold, seam.fold);
      collarSeam.key = key;
    }
    options.report({
      streamTiles: tiles.residentTileCount,
      streamCoveredHalf: stream.half.value,
      streamSeamGap: tileSeam ?? -1,
      // The tile-to-collar step at the tile vertices, as core measures a tile-to-tile seam, and the
      // step between them where a collar fold crosses a tile's edge; -1 when not measured.
      streamCollarGap: tileSeam === undefined ? -1 : collarSeam.gap,
      streamCollarFold: tileSeam === undefined ? -1 : collarSeam.fold,
    });
  });
  // The tiles around the spawn draw unculled behind the curtain until the whole block has drawn
  // twice, so their pipelines are built before the reveal (the spawn view sees few of them). The
  // stream runs once per world draw, because the fixed step does not run while the curtain is up.
  const full = (RADIUS + 0.5) * STREAM_TILE;
  const ready = warmUnculled(ctx, tiles, { when: () => stream.half.value === full });
  return {
    ready,
    tiles,
    dispose: () => {
      stream.half.value = 0;
      tiles.removeFromParent();
      tiles.dispose();
      surface.dispose();
    },
  };
}
