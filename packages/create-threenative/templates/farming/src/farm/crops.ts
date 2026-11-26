// The crops, as data. Add a row to add a crop: the field, the shop, the HUD and the renderer read
// this table.
//
// Reference: harvest-moon-64 card `shipping-income`. The card holds one price: the lowest root
// crop is worth 60 gold (src/game/items.c:1097), and its summary puts vegetables "in the tens to
// low hundreds". The other prices, the seed prices and the days to ripen are game-owned numbers
// inside that band. The card has no per-crop stage table.
import type { Season } from "./time.js";

export type CropId = "turnip" | "tomato" | "pumpkin";

export interface ICropSpec {
  readonly id: CropId;
  readonly label: string;
  /** The one season it grows in. Watered out of season, it does not advance. */
  readonly season: Season;
  /** Watered days from seed to ripe: the stage it must reach. */
  readonly days: number;
  /** Gold paid for one shipped crop. */
  readonly price: number;
  /** Gold for one seed at the shop. */
  readonly seedPrice: number;
  /** Fruit colour, hex. */
  readonly color: number;
}

export const CROPS: Readonly<Record<CropId, ICropSpec>> = {
  // items.c:1097: the lowest root crop value.
  turnip: { id: "turnip", label: "Turnip", season: "spring", days: 3, price: 60, seedPrice: 20, color: 0xe8e0f0 },
  tomato: { id: "tomato", label: "Tomato", season: "summer", days: 4, price: 100, seedPrice: 45, color: 0xd8352a },
  pumpkin: { id: "pumpkin", label: "Pumpkin", season: "autumn", days: 5, price: 160, seedPrice: 70, color: 0xe8821e },
};

export const CROP_IDS = Object.keys(CROPS) as readonly CropId[];
