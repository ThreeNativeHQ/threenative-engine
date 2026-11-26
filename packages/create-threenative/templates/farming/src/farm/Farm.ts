// The farm's rules: the clock, the purse, the bin, the hotbar and the night. Plain data and
// decisions, no Three.js and no input. `scenes/Play.ts` feeds it what the farmer did and draws
// what it says.
//
// Reference: harvest-moon-64 cards `shipping-income` (game.c:2492 and :2767: the bin is paid once,
// in the end-of-day sequence, and clamped at a ceiling) and `stamina-budget` (game.c:2543: the
// next morning restores stamina to its maximum).
import { CROPS, CROP_IDS, type CropId } from "./crops.js";
import { Field, type ITile, isRipe } from "./field.js";
import {
  FAINT_MINUTE,
  type IDate,
  MINUTES_PER_SECOND,
  WAKE_MINUTE,
  dateLabel,
  dateOf,
} from "./time.js";
import {
  HOTBAR,
  type HotbarSlot,
  STAMINA_MAX,
  TOOL_COST,
  WATER_MAX,
  staminaTier,
} from "./tools.js";

/** Gold in the purse on the first morning. Game-owned. */
export const START_MONEY = 200;
/** The purse and the bin stop here: game.h:6 and :12. */
export const GOLD_CEILING = 999999;
/** A faint costs this share of the purse. Game-owned: the card has no faint fee. */
export const FAINT_FEE = 0.1;
/** Seeds in the bag on the first morning. */
export const START_SEEDS = 6;

export type DayCause = "sleep" | "late" | "exhausted";

export interface ISummaryLine {
  readonly id: CropId;
  readonly label: string;
  readonly count: number;
  readonly value: number;
}

/** What the night screen shows: the day that ended, what the bin paid and what a faint cost. */
export interface ISummary {
  readonly cause: DayCause;
  readonly date: string;
  readonly earned: number;
  readonly lines: readonly ISummaryLine[];
  readonly money: number;
  readonly nextDate: string;
  readonly penalty: number;
}

export type Plan =
  | { readonly valid: false; readonly message: string }
  | { readonly valid: true; readonly cost: number; readonly apply: () => Result };

export interface Result {
  /** Playtest event name. */
  readonly event: string;
  readonly message: string;
}

export type InteractKind = "harvest" | "ship" | "sleep" | "buy" | "none";

/** Which interaction zones the farmer stands in. */
export interface IZones {
  readonly bed: boolean;
  readonly bin: boolean;
  readonly pond: boolean;
  readonly shop: boolean;
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export class Farm {
  readonly field = new Field();
  dayIndex = 0;
  minute = WAKE_MINUTE;
  money = START_MONEY;
  stamina = STAMINA_MAX;
  water = WATER_MAX;
  slot = 0;
  carrying: CropId | undefined;
  faints = 0;
  sleeps = 0;
  readonly seeds: Record<CropId, number> = { pumpkin: 0, tomato: 0, turnip: START_SEEDS };
  readonly bin: Record<CropId, number> = { pumpkin: 0, tomato: 0, turnip: 0 };

  get date(): IDate {
    return dateOf(this.dayIndex);
  }

  get hotbar(): HotbarSlot {
    return HOTBAR[this.slot] ?? (HOTBAR[0] as HotbarSlot);
  }

  get tier(): 0 | 1 | 2 | 3 {
    return staminaTier(this.stamina);
  }

  get binCount(): number {
    return CROP_IDS.reduce((sum, id) => sum + this.bin[id], 0);
  }

  get binValue(): number {
    return Math.min(
      GOLD_CEILING,
      CROP_IDS.reduce((sum, id) => sum + this.bin[id] * CROPS[id].price, 0),
    );
  }

  select(slot: number): void {
    this.slot = ((slot % HOTBAR.length) + HOTBAR.length) % HOTBAR.length;
  }

  /** Advance the clock. True once the farmer is awake past the faint hour. */
  tick(dt: number): boolean {
    this.minute += dt * MINUTES_PER_SECOND;
    return this.minute >= FAINT_MINUTE;
  }

  /**
   * What the selected tool would do on `tile`. The rule runs on a copy first, so a refusal costs
   * nothing and the HUD can say why. `apply` runs it for real and spends the stamina.
   */
  plan(tile: ITile | undefined, nearPond: boolean): Plan {
    const slot = this.hotbar;
    if (this.carrying !== undefined)
      return { message: "Your hands are full. Ship it at the bin.", valid: false };
    if (slot.kind === "tool" && slot.tool === "can" && nearPond)
      return {
        apply: () => {
          this.water = WATER_MAX;
          return { event: "refilled", message: "The can is full." };
        },
        cost: 0,
        valid: true,
      };
    if (tile === undefined) return { message: "", valid: false };
    if (slot.kind === "seed" && this.seeds[slot.crop] <= 0)
      return { message: `No ${slot.crop} seeds. The stall sells them.`, valid: false };
    if (slot.kind === "tool" && slot.tool === "can" && this.water <= 0)
      return { message: "The can is empty. Fill it at the pond.", valid: false };
    const probe: ITile = { ...tile, crop: tile.crop === undefined ? undefined : { ...tile.crop } };
    const outcome = this.#run(slot, probe);
    if (outcome === "blocked")
      return {
        message:
          tile.obstacle === "rock"
            ? "A rock blocks the soil. Use the hammer."
            : "A weed blocks the soil. Use the sickle.",
        valid: false,
      };
    if (outcome === "nothing") return { message: this.#idle(slot, tile), valid: false };
    const cost = TOOL_COST[slot.kind === "seed" ? "seed" : slot.tool];
    return { apply: () => this.#apply(slot, tile, cost), cost, valid: true };
  }

  #run(slot: HotbarSlot, tile: ITile): "done" | "blocked" | "nothing" {
    if (slot.kind === "seed") return this.field.plant(tile, slot.crop);
    if (slot.tool === "hoe") return this.field.till(tile);
    if (slot.tool === "can") return this.field.water(tile);
    if (slot.tool === "sickle") return this.field.cut(tile);
    return this.field.smash(tile);
  }

  #idle(slot: HotbarSlot, tile: ITile): string {
    if (slot.kind === "seed" && !tile.tilled) return "Till the soil before you plant.";
    if (slot.kind === "tool" && slot.tool === "can" && !tile.tilled) return "Water tilled soil.";
    return "";
  }

  #apply(slot: HotbarSlot, tile: ITile, cost: number): Result {
    this.stamina = Math.max(0, this.stamina - cost);
    this.#run(slot, tile);
    if (slot.kind === "seed") {
      this.seeds[slot.crop] -= 1;
      const spec = CROPS[slot.crop];
      const grows = spec.season === this.date.season;
      return {
        event: "planted",
        message: grows
          ? `Planted ${slot.crop}.`
          : `Planted ${slot.crop}. It grows in ${spec.season}.`,
      };
    }
    if (slot.tool === "hoe") return { event: "tilled", message: "" };
    if (slot.tool === "can") {
      this.water -= 1;
      return { event: "watered", message: "" };
    }
    if (slot.tool === "sickle") return { event: "cut-weed", message: "" };
    return { event: tile.obstacle === undefined ? "broke-rock" : "cracked-rock", message: "" };
  }

  /** The interaction the E key would run here. The HUD prompt and the key read the same answer. */
  interaction(tile: ITile | undefined, zones: IZones): { kind: InteractKind; prompt: string } {
    if (this.carrying !== undefined)
      return zones.bin
        ? { kind: "ship", prompt: `E  SHIP ${this.carrying.toUpperCase()}` }
        : { kind: "none", prompt: "CARRYING  BRING IT TO THE BIN" };
    if (tile !== undefined && isRipe(tile)) return { kind: "harvest", prompt: "E  PICK" };
    if (zones.bed) return { kind: "sleep", prompt: "E  SLEEP" };
    if (zones.shop) {
      const slot = this.hotbar;
      if (slot.kind !== "seed") return { kind: "none", prompt: "SELECT A SEED BAG, KEYS 5 TO 7" };
      const price = CROPS[slot.crop].seedPrice;
      return { kind: "buy", prompt: `E  BUY ${slot.crop.toUpperCase()} SEED  ${price} G` };
    }
    return { kind: "none", prompt: "" };
  }

  harvest(tile: ITile): Result {
    const id = this.field.harvest(tile);
    if (id === undefined) return { event: "", message: "" };
    this.carrying = id;
    return { event: "harvested", message: `Picked a ${id}.` };
  }

  ship(): Result {
    const id = this.carrying;
    if (id === undefined) return { event: "", message: "" };
    this.carrying = undefined;
    this.bin[id] += 1;
    return { event: "shipped", message: `${cap(id)} in the bin. It pays tonight.` };
  }

  buy(): Result {
    const slot = this.hotbar;
    if (slot.kind !== "seed") return { event: "", message: "" };
    const price = CROPS[slot.crop].seedPrice;
    if (this.money < price) return { event: "broke", message: "Not enough gold." };
    this.money -= price;
    this.seeds[slot.crop] += 1;
    return { event: "bought", message: `Bought a ${slot.crop} seed.` };
  }

  /** Open the morning: the clock goes back to 06:00. */
  wake(): void {
    this.minute = WAKE_MINUTE;
  }

  /**
   * End the day: grow the crops, pay the bin, charge a faint, open the next morning. Returns what
   * the night screen shows. The clock stays on the old evening until `wake`.
   */
  endDay(cause: DayCause): ISummary {
    const today = this.date;
    const lines: ISummaryLine[] = CROP_IDS.filter((id) => this.bin[id] > 0).map((id) => ({
      count: this.bin[id],
      id,
      label: CROPS[id].label,
      value: this.bin[id] * CROPS[id].price,
    }));
    const earned = this.binValue;
    for (const id of CROP_IDS) this.bin[id] = 0;
    this.carrying = undefined;
    this.money = Math.min(GOLD_CEILING, this.money + earned);
    const penalty = cause === "sleep" ? 0 : Math.ceil(this.money * FAINT_FEE);
    this.money -= penalty;
    this.dayIndex += 1;
    const tomorrow = this.date;
    this.field.endDay(today.season, tomorrow.day === 1 ? tomorrow.season : undefined);
    // The card restores stamina to its maximum each morning. A farmer who collapsed wakes half spent.
    this.stamina = cause === "sleep" ? STAMINA_MAX : Math.ceil(STAMINA_MAX / 2);
    if (cause === "sleep") this.sleeps += 1;
    else this.faints += 1;
    return {
      cause,
      date: dateLabel(today),
      earned,
      lines,
      money: this.money,
      nextDate: dateLabel(tomorrow),
      penalty,
    };
  }
}
