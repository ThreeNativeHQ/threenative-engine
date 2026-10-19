import { Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it, vi } from "vitest";
import { TerrainTiles } from "../src/world-tiles.js";

const sampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5 + Math.sin((x + z) * 0.07);

const TILE_SIZE = 16;
const BLOCK_SIDE = 4;
const BLOCK_PREFIX = "tn-terrain-block:";
const STEP = 0.75;
const LEG_FRAMES = 220;
const FRAMES = LEG_FRAMES * 2;

function terrain(mergeTiles: boolean): TerrainTiles {
  return new TerrainTiles({
    mergeTiles,
    residentByteBudget: 64_000_000,
    residentTileBudget: 256,
    sampleHeight,
    // Thresholds inside the streamed ring, so a walk of one tile's width re-levels whole rows.
    lodDistances: [TILE_SIZE * 3, TILE_SIZE * 7],
    streamRadius: 4,
    surface: new MeshBasicMaterial(),
    tileResolution: 33,
    tileSize: TILE_SIZE,
  } as ConstructorParameters<typeof TerrainTiles>[0]);
}

/**
 * A frame allowance in the shape the game passes: units of streamed work, spent in order. Six leaves
 * room for the ring's admissions and still refuses a rebuild now and then, so the walk also covers a
 * block that waits longer than the one-per-frame cap.
 */
function frameBudget(): { admit: (work: () => void) => boolean } {
  let units = 0;
  return {
    admit(work) {
      units += 1;
      if (units > 6) return false;
      work();
      return true;
    },
  };
}

/** Straight through a tile's width of ring crossings, then a right-angle turn: a map walk's churn. */
function path(frame: number): { x: number; z: number } {
  const travelled = frame * STEP;
  return frame < LEG_FRAMES
    ? { x: travelled, z: 0 }
    : { x: LEG_FRAMES * STEP, z: travelled - LEG_FRAMES * STEP };
}

function lodOf(blockId: string): number {
  return Number(blockId.slice(0, blockId.indexOf(":")));
}

function cellOf(x: number, z: number): string {
  return cellKeyFor(Math.floor(x / TILE_SIZE + 0.5), Math.floor(z / TILE_SIZE + 0.5));
}

function cellKeyFor(tileX: number, tileZ: number): string {
  return `${String(tileX)}:${String(tileZ)}`;
}

function blockIdFor(tileX: number, tileZ: number, lod: number): string {
  return `${String(lod)}:${String(Math.floor(tileX / BLOCK_SIDE))},${String(
    Math.floor(tileZ / BLOCK_SIDE),
  )}`;
}

/**
 * One frame of the merged ring, read the way the main pass reads it.
 *
 * A block is a concatenation of whole level geometries, all of its members at the block's LOD tier,
 * so the buffer is a whole number of equal runs and the first vertex of each run names the tile it
 * came from. That is what makes "this tile is hidden because a block draws it" measurable from
 * outside, instead of taking the record the class keeps on trust.
 */
interface ITileRead {
  readonly blockId: string;
  readonly drawn: number;
  readonly morphing: boolean;
  readonly own: boolean;
}

function readFrame(tiles: TerrainTiles): {
  readonly held: Map<string, Set<string>>;
  readonly perLevel: Map<number, number>;
  readonly tiles: Map<string, ITileRead>;
} {
  const perLevel = new Map<number, number>();
  const cells = new Set<string>();
  const read = new Map<string, ITileRead>();
  for (const key of tiles.residentKeys) {
    const tile = tiles.getTile(key);
    if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
    const visible = tile.lod.levels
      .map(({ object }, index) => (object.visible ? index : -1))
      .filter((index) => index >= 0);
    const level = tile.lod.levels[tile.lodLevel];
    if (level === undefined)
      throw new Error(`Tile '${key}' has no level ${String(tile.lodLevel)}.`);
    // A settled tile shows exactly its own level; a morphing tile shows the finer of the pair, which
    // is how a frame tells the two apart without reading private transition state.
    const morphing = visible.length === 1 && visible[0] !== tile.lodLevel;
    read.set(key, {
      blockId: blockIdFor(tile.tileX, tile.tileZ, tile.lodLevel),
      drawn: visible.length,
      morphing,
      own: visible.length === 1 && visible[0] === tile.lodLevel,
    });
    cells.add(cellKeyFor(tile.tileX, tile.tileZ));
    perLevel.set(tile.lodLevel, (level.object as Mesh).geometry.getAttribute("position").count);
  }
  const held = new Map<string, Set<string>>();
  for (const child of tiles.children)
    if (child instanceof Mesh && child.name.startsWith(BLOCK_PREFIX))
      held.set(child.name.slice(BLOCK_PREFIX.length), readBlock(child, cells, perLevel));
  return { held, perLevel, tiles: read };
}

/** Which tile cells one block's buffer holds, named run by run, and `?offset` for any run it cannot. */
function readBlock(
  mesh: Mesh,
  cells: ReadonlySet<string>,
  perLevel: ReadonlyMap<number, number>,
): Set<string> {
  const id = mesh.name.slice(BLOCK_PREFIX.length);
  const separator = id.indexOf(":");
  const cell = id.slice(separator + 1).split(",");
  const originX = Number(cell[0]) * BLOCK_SIDE * TILE_SIZE;
  const originZ = Number(cell[1]) * BLOCK_SIDE * TILE_SIZE;
  const run = perLevel.get(Number(id.slice(0, separator))) ?? 0;
  const position = mesh.geometry.getAttribute("position");
  const members = new Set<string>();
  for (let offset = 0; offset + run <= position.count; offset += run) {
    const here = cellOf(position.getX(offset) + originX, position.getZ(offset) + originZ);
    members.add(cells.has(here) ? here : `?${String(offset)}`);
  }
  if (position.count % run !== 0) members.add(`?remainder${String(position.count % run)}`);
  return members;
}

/**
 * The per-frame walk invariants, each failure naming its frame.
 *
 * (i) every settled resident tile is drawn exactly once — its own level mesh, or the one block whose
 * geometry holds it, never both and never neither;
 * (ii) a tile whose block has not been rebuilt for it yet keeps drawing its own mesh, so the rebuild
 * queue never opens a hole;
 * (iii) residency is the merge-off walk's residency, tile for tile, every frame;
 * (iv) the `tiles` stat is the resident tile count.
 */
function frameFailures(frame: number, merged: TerrainTiles, plain: TerrainTiles): string[] {
  const { held, tiles } = readFrame(merged);
  return [
    ...tileFailures(frame, merged, tiles, held),
    ...blockFailures(frame, merged, held),
    ...statFailures(frame, merged, plain),
  ];
}

/** (i) and (ii), tile by tile: a tile draws itself or the block that holds it, never both or neither. */
function tileFailures(
  frame: number,
  tiles: TerrainTiles,
  read: ReadonlyMap<string, ITileRead>,
  held: ReadonlyMap<string, Set<string>>,
): string[] {
  const failures: string[] = [];
  for (const [key, tile] of read) {
    const resident = tiles.getTile(key);
    if (resident === undefined) continue;
    const cell = cellKeyFor(resident.tileX, resident.tileZ);
    const inBlock = held.get(tile.blockId)?.has(cell) === true;
    if (tile.morphing) {
      // A tile mid a blend is never merged, so it always draws itself.
      if (tile.drawn !== 1)
        failures.push(
          `frame ${String(frame)}: '${key}' is blending and submits ${String(tile.drawn)} meshes`,
        );
      continue;
    }
    if (tile.own && inBlock)
      failures.push(`frame ${String(frame)}: '${key}' draws itself and block '${tile.blockId}'`);
    if (!tile.own && !inBlock)
      failures.push(
        `frame ${String(frame)}: '${key}' draws nothing, waiting on block '${tile.blockId}'`,
      );
  }
  return failures;
}

/** (i) from the block's side: nothing in a block a tile does not own, or owns at another LOD tier. */
function blockFailures(
  frame: number,
  tiles: TerrainTiles,
  held: ReadonlyMap<string, Set<string>>,
): string[] {
  const failures: string[] = [];
  for (const [id, members] of held)
    for (const member of members) {
      const other = tiles.getTile(member);
      if (member.startsWith("?"))
        failures.push(
          `frame ${String(frame)}: block '${id}' holds '${member}', which no tile owns`,
        );
      else if (other !== undefined && lodOf(id) !== other.lodLevel)
        failures.push(
          `frame ${String(frame)}: block '${id}' holds '${member}', which is now level ${String(other.lodLevel)}`,
        );
    }
  return failures;
}

/** (iii) and (iv): the merge-off walk's residency, and a `tiles` stat that counts it. */
function statFailures(frame: number, merged: TerrainTiles, plain: TerrainTiles): string[] {
  const failures: string[] = [];
  const stat = merged.terrainTiles.tiles;
  if (stat !== merged.residentTileCount)
    failures.push(
      `frame ${String(frame)}: tiles stat ${String(stat)} against ${String(merged.residentTileCount)} resident`,
    );
  if (merged.residentKeys.join() !== plain.residentKeys.join())
    failures.push(`frame ${String(frame)}: residency differs from the merge-off walk`);
  return failures;
}

/** How many tiles this frame streamed in and out of the ring, so the walk proves it streamed. */
function countStreamed(
  seen: Set<string>,
  tiles: TerrainTiles,
): { admitted: number; evicted: number } {
  const keys = tiles.residentKeys;
  let admitted = 0;
  let evicted = 0;
  for (const key of keys)
    if (!seen.has(key)) {
      seen.add(key);
      admitted += 1;
    }
  for (const key of [...seen])
    if (!keys.includes(key)) {
      seen.delete(key);
      evicted += 1;
    }
  return { admitted, evicted };
}

describe("TerrainTiles merge under a walk", () => {
  it("draws every resident tile exactly once on every frame of a streaming walk", () => {
    const marker = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const merged = terrain(true);
    const plain = terrain(false);
    try {
      const failures: string[] = [];
      const seen = new Set<string>();
      const streamed = { admitted: 0, evicted: 0 };
      let blended = 0;
      for (let frame = 0; frame < FRAMES; frame += 1) {
        const at = path(frame);
        for (const tiles of [merged, plain]) {
          tiles.follow(at, frameBudget());
          tiles.process();
        }
        const frame_ = countStreamed(seen, merged);
        streamed.admitted += frame_.admitted;
        streamed.evicted += frame_.evicted;
        blended += merged.blendingTiles === 0 ? 0 : 1;
        failures.push(...frameFailures(frame, merged, plain));
      }
      // Six construction chunks no longer mean six whole tiles. Keep checking every draw while
      // the same bounded allowance finishes the last stationary ring, without raising it.
      for (
        let frame = FRAMES;
        frame < FRAMES + 10_000 && merged.deferredAdmissions > 0;
        frame += 1
      ) {
        for (const tiles of [merged, plain]) {
          tiles.follow(path(FRAMES - 1), frameBudget());
          tiles.process();
        }
        failures.push(...frameFailures(frame, merged, plain));
      }
      marker.mockRestore();
      // The walk has to stream, re-level and blend, or the invariants below prove nothing.
      expect({ blended, resident: merged.residentTileCount }).toEqual({
        blended: expect.any(Number),
        resident: 81,
      });
      expect(streamed.evicted).toBeGreaterThan(0);
      expect(streamed.admitted).toBeGreaterThan(0);
      expect(blended).toBeGreaterThan(0);
      expect(failures.slice(0, 8)).toEqual([]);
    } finally {
      merged.dispose();
      plain.dispose();
      marker.mockRestore();
    }
  });
});
