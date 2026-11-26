// The hotbar, the stamina budget and what each costs.
//
// Reference: harvest-moon-64 card `stamina-budget` (player.c) and `tool-charge` (player.c:293).
import { CROP_IDS, type CropId } from "./crops.js";

/** Stamina ceiling, restored by sleep: player.h:8. */
export const STAMINA_MAX = 250;
/** Water in the can: one use per tile. Game-owned. */
export const WATER_MAX = 10;
/** A rock takes this many hammer blows. Game-owned. */
export const ROCK_HITS = 2;

export type ToolId = "hoe" | "can" | "sickle" | "hammer";

/**
 * Stamina per swing. The card prices a light swing at 1 to 3 points and a heavy third-level
 * swing at 6 (player.c:293, :295): the hoe and the hammer are the heavy tools, the sickle sits at
 * the top of the light range, the can and a seed at the bottom.
 */
export const TOOL_COST: Readonly<Record<ToolId | "seed", number>> = {
  can: 2,
  hammer: 6,
  hoe: 6,
  seed: 1,
  sickle: 3,
};

export type HotbarSlot =
  | { readonly kind: "tool"; readonly tool: ToolId; readonly label: string }
  | { readonly kind: "seed"; readonly crop: CropId; readonly label: string };

/** The seven slots, keys 1 to 7: four tools, then one seed bag per crop. */
export const HOTBAR: readonly HotbarSlot[] = [
  { kind: "tool", tool: "hoe", label: "Hoe" },
  { kind: "tool", tool: "can", label: "Can" },
  { kind: "tool", tool: "sickle", label: "Sickle" },
  { kind: "tool", tool: "hammer", label: "Hammer" },
  ...CROP_IDS.map((crop): HotbarSlot => ({ kind: "seed", crop, label: `${crop} seed` })),
];

/**
 * The card splits the ceiling into quarters and reads the tier from how many are left
 * (player.c:1532): 0 and 1 are fresh, 2 is weary, 3 is spent.
 */
export function staminaTier(stamina: number): 0 | 1 | 2 | 3 {
  const quarter = STAMINA_MAX / 4;
  if (stamina > quarter * 3) return 0;
  if (stamina > quarter * 2) return 1;
  if (stamina > quarter) return 2;
  return 3;
}

/** Walking speed in metres a second per tier. The card gives tiers, not speeds: game-owned. */
export const TIER_SPEED: readonly number[] = [3.6, 3.6, 3, 2.1];
