// The farm, as data. `render/farm.ts` turns it into meshes, the scene turns it into colliders and
// interaction zones. Change the farm here: one table, and the look and the rules follow it.
//
// Scale: one unit is one metre. A field tile is two metres, so one tile is two cells of the grid
// material and a farmer standing in it is roughly its width.

export const WORLD_LAYER = 1;
export const PLAYER_LAYER = 2;

/** The field: 8 by 6 tiles, row 0 on the north edge. Tile (col, row) is centred on `tileCenter`. */
export const FIELD = { cols: 8, rows: 6, tile: 2, x0: -8, z0: -9 } as const;

export function tileCenter(col: number, row: number): { x: number; z: number } {
  return { x: FIELD.x0 + (col + 0.5) * FIELD.tile, z: FIELD.z0 + (row + 0.5) * FIELD.tile };
}

/** The tile under a world point, or undefined outside the field. */
export function tileAt(x: number, z: number): { col: number; row: number } | undefined {
  const col = Math.floor((x - FIELD.x0) / FIELD.tile);
  const row = Math.floor((z - FIELD.z0) / FIELD.tile);
  return col < 0 || row < 0 || col >= FIELD.cols || row >= FIELD.rows ? undefined : { col, row };
}

/** Untilled weeds and rocks that block a tile until cleared. */
export const OBSTACLES: readonly { col: number; row: number; kind: "weed" | "rock" }[] = [
  { col: 0, row: 0, kind: "rock" },
  { col: 7, row: 5, kind: "rock" },
  { col: 1, row: 0, kind: "weed" },
  { col: 6, row: 0, kind: "weed" },
  { col: 7, row: 1, kind: "weed" },
  { col: 0, row: 5, kind: "weed" },
  { col: 5, row: 5, kind: "weed" },
];

export const SPAWN = { x: 0, z: 3.5 } as const;

/** A circular interaction zone: stand within `radius` of the centre. */
export interface IZone {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

/** The house sits north of the field. Its door faces south; the bed zone is the doorstep. */
export const HOUSE = { x: 0, z: -16, width: 9, depth: 6, height: 3.4 } as const;
export const BED_ZONE: IZone = { x: 0, z: -11.4, radius: 2.2 };

/** The shipping bin beside the house. */
export const BIN = { x: -9, z: -11, width: 1.8, depth: 1.2, height: 1 } as const;
export const BIN_ZONE: IZone = { x: -9, z: -9.6, radius: 2.4 };

/** The pond east of the field. The can refills within `reach` of its centre. */
export const POND = { x: 13, z: -3, radius: 3 } as const;
export const POND_ZONE: IZone = { x: POND.x, z: POND.z, radius: POND.radius + 1.6 };

/** The seed stall south-east of the field. */
export const SHOP = { x: 11, z: 9.5, width: 3.2, depth: 1.4, height: 1.1 } as const;
export const SHOP_ZONE: IZone = { x: SHOP.x, z: SHOP.z - 1.8, radius: 2.4 };

/** The fenced farm: the farmer walks inside this box. */
export const BOUNDS = { minX: -22, maxX: 22, minZ: -21, maxZ: 14 } as const;

/** Trees on the far side of the fence, as [x, z, scale]. */
export const TREES: readonly (readonly [number, number, number])[] = [
  [-26, -14, 1.3],
  [-27, 2, 1.1],
  [-25, 9, 1.4],
  [26, -12, 1.2],
  [27, 4, 1.4],
  [25, 11, 1.1],
  [-12, -24, 1.2],
  [14, -25, 1.4],
];

export function inZone(zone: IZone, x: number, z: number): boolean {
  return Math.hypot(x - zone.x, z - zone.z) <= zone.radius;
}
