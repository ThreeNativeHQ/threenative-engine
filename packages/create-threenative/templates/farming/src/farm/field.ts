// The field grid: what each tile holds and what each tool does to it. Plain data and rules, no
// Three.js. `render/fieldView.ts` draws it and `Farm.ts` drives it.
//
// Reference: harvest-moon-64 card `crop-growth` and `watering-and-rain` (src/game/groundObjects.c).
// The card keeps a dry and a watered twin of every soil and plant id. A watered plant holds the
// advance bit, so one pass at the day boundary moves it up one stage, and the night then dries it:
// a field needs water every day. At a month start a seasonal pass kills the crops that do not
// belong to the new season (groundObjects.c:1253). This file keeps both rules.
import { FIELD, OBSTACLES } from "../level.js";
import { CROPS, type CropId } from "./crops.js";
import type { Season } from "./time.js";
import { ROCK_HITS } from "./tools.js";

export type Obstacle = "weed" | "rock";

export interface ICrop {
  readonly id: CropId;
  /** Watered days so far. Ripe at `CROPS[id].days`. */
  stage: number;
  dead: boolean;
}

export interface ITile {
  tilled: boolean;
  watered: boolean;
  crop: ICrop | undefined;
  obstacle: Obstacle | undefined;
  /** Hammer blows taken by a rock. */
  hits: number;
}

export type TileKind =
  | "plain"
  | "tilled"
  | "watered"
  | "seedling"
  | "growing"
  | "ripe"
  | "dead"
  | "weed"
  | "rock";

/** What a tool did: it changed the tile, it was refused by an obstacle, or it had nothing to do. */
export type Outcome = "done" | "blocked" | "nothing";

export interface IFieldStats {
  tilled: number;
  watered: number;
  planted: number;
  ripe: number;
  dead: number;
  weeds: number;
  rocks: number;
  stageSum: number;
}

export function isRipe(tile: ITile): boolean {
  const crop = tile.crop;
  return crop !== undefined && !crop.dead && crop.stage >= CROPS[crop.id].days;
}

export class Field {
  readonly tiles: ITile[] = Array.from({ length: FIELD.cols * FIELD.rows }, () => ({
    crop: undefined,
    hits: 0,
    obstacle: undefined,
    tilled: false,
    watered: false,
  }));

  constructor() {
    for (const { col, row, kind } of OBSTACLES) {
      const tile = this.at(col, row);
      if (tile !== undefined) tile.obstacle = kind;
    }
  }

  index(col: number, row: number): number {
    return row * FIELD.cols + col;
  }

  at(col: number, row: number): ITile | undefined {
    if (col < 0 || row < 0 || col >= FIELD.cols || row >= FIELD.rows) return undefined;
    return this.tiles[this.index(col, row)];
  }

  kind(tile: ITile): TileKind {
    if (tile.obstacle !== undefined) return tile.obstacle;
    const crop = tile.crop;
    if (crop !== undefined) {
      if (crop.dead) return "dead";
      if (isRipe(tile)) return "ripe";
      return crop.stage === 0 ? "seedling" : "growing";
    }
    if (tile.watered) return "watered";
    return tile.tilled ? "tilled" : "plain";
  }

  /** The hoe: turn plain ground to soil, or clear a dead crop back to soil. */
  till(tile: ITile): Outcome {
    if (tile.obstacle !== undefined) return "blocked";
    if (tile.crop?.dead === true) {
      tile.crop = undefined;
      return "done";
    }
    if (tile.crop !== undefined || tile.tilled) return "nothing";
    tile.tilled = true;
    return "done";
  }

  /** The can: wet tilled soil, with or without a crop on it. */
  water(tile: ITile): Outcome {
    if (!tile.tilled || tile.watered) return "nothing";
    tile.watered = true;
    return "done";
  }

  plant(tile: ITile, id: CropId): Outcome {
    if (tile.obstacle !== undefined) return "blocked";
    if (!tile.tilled || tile.crop !== undefined) return "nothing";
    tile.crop = { dead: false, id, stage: 0 };
    return "done";
  }

  /** The sickle takes a weed. */
  cut(tile: ITile): Outcome {
    if (tile.obstacle !== "weed") return "nothing";
    tile.obstacle = undefined;
    return "done";
  }

  /** The hammer cracks a rock, then breaks it. */
  smash(tile: ITile): Outcome {
    if (tile.obstacle !== "rock") return "nothing";
    tile.hits += 1;
    if (tile.hits >= ROCK_HITS) tile.obstacle = undefined;
    return "done";
  }

  /** Take a ripe crop off the tile. The soil stays tilled and dry. */
  harvest(tile: ITile): CropId | undefined {
    if (!isRipe(tile) || tile.crop === undefined) return undefined;
    const id = tile.crop.id;
    tile.crop = undefined;
    tile.watered = false;
    return id;
  }

  /**
   * The night pass. A crop watered today and in its season gains one stage. Every tile dries. When
   * the new day opens a season, a crop that does not belong to it dies.
   */
  endDay(today: Season, seasonStarts: Season | undefined): void {
    for (const tile of this.tiles) {
      const crop = tile.crop;
      if (crop !== undefined && !crop.dead && tile.watered) {
        const spec = CROPS[crop.id];
        if (spec.season === today) crop.stage = Math.min(spec.days, crop.stage + 1);
      }
      tile.watered = false;
      if (
        crop !== undefined &&
        seasonStarts !== undefined &&
        CROPS[crop.id].season !== seasonStarts
      )
        crop.dead = true;
    }
  }

  stats(): IFieldStats {
    const stats: IFieldStats = {
      dead: 0,
      planted: 0,
      ripe: 0,
      rocks: 0,
      stageSum: 0,
      tilled: 0,
      watered: 0,
      weeds: 0,
    };
    for (const tile of this.tiles) {
      if (tile.tilled) stats.tilled += 1;
      if (tile.watered) stats.watered += 1;
      if (tile.obstacle === "weed") stats.weeds += 1;
      if (tile.obstacle === "rock") stats.rocks += 1;
      const crop = tile.crop;
      if (crop === undefined) continue;
      if (crop.dead) stats.dead += 1;
      else {
        stats.planted += 1;
        stats.stageSum += crop.stage;
        if (isRipe(tile)) stats.ripe += 1;
      }
    }
    return stats;
  }
}
