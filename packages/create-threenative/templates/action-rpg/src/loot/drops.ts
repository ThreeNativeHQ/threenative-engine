import { createRandom } from "@threenative/core";
import type { ItemId } from "../items/Inventory.js";

export interface IDrop {
  readonly itemId: ItemId;
  readonly quantity: number;
}

const TABLE: readonly { readonly itemId: ItemId; readonly weight: number }[] = [
  { itemId: "potion", weight: 70 },
  { itemId: "ember-blade", weight: 30 },
];

export function rollDrops(seed: number, rolls = 2): IDrop[] {
  if (!Number.isInteger(seed) || seed < 0)
    throw new RangeError("Drop seeds must be non-negative integers.");
  if (!Number.isInteger(rolls) || rolls < 1) throw new RangeError("Drop rolls must be positive.");
  const random = createRandom(seed);
  const drops: IDrop[] = [];
  for (let index = 0; index < rolls; index += 1) {
    const pick = random() * 100;
    let cursor = 0;
    for (const entry of TABLE) {
      cursor += entry.weight;
      if (pick < cursor) {
        drops.push({ itemId: entry.itemId, quantity: 1 });
        break;
      }
    }
  }
  return drops;
}

export function describeDrops(drops: readonly IDrop[]): string {
  return drops.map((drop) => `${drop.itemId} x${drop.quantity}`).join(", ");
}
