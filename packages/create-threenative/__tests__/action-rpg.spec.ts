import { describe, expect, it } from "vitest";
import { ITEMS, Inventory } from "../templates/action-rpg/src/items/Inventory.js";
import { rollDrops } from "../templates/action-rpg/src/loot/drops.js";
import { launchTangent } from "../templates/action-rpg/src/render/vfx.js";
import { StatBlock } from "../templates/action-rpg/src/stats/StatBlock.js";

describe("action-RPG inventory restore", () => {
  it("restores a full bag and separately equipped weapon without losing its attack bonus", () => {
    const serialized = Array.from({ length: 6 }, () => ({
      itemId: "potion" as const,
      quantity: 3,
    }));
    const inventory = new Inventory(serialized.length);

    inventory.restore(serialized, "ember-blade");

    expect(inventory.snapshot()).toEqual(serialized);
    expect(inventory.equipped).toEqual({ itemId: "ember-blade", quantity: 1 });

    const attackBonus =
      inventory.equipped?.itemId === ITEMS.emberBlade.id ? ITEMS.emberBlade.attackBonus : 0;
    const damage = new StatBlock(12);
    damage.apply({ add: attackBonus, source: "equipment" });
    expect(damage.value()).toBe(18);
  });
});

describe("action-RPG seeded drops", () => {
  it("uses the seed for exact and distinct LCG sequences", () => {
    const first = rollDrops(1);
    const second = rollDrops(0x12345678);

    expect(first).toEqual([
      { itemId: "potion", quantity: 1 },
      { itemId: "potion", quantity: 1 },
    ]);
    expect(second).toEqual([
      { itemId: "potion", quantity: 1 },
      { itemId: "ember-blade", quantity: 1 },
    ]);
    expect(second).not.toEqual(first);
  });
});

describe("action-RPG particle launch cone", () => {
  const directions = [
    [0, 0.2, 0], // the attack arc: straight up, written short
    [0.05, 1, 0.04],
    [1, 0.04, 0],
    [0, 1, 0],
    [0, -3, 0],
    [0, 0, 1],
    [0.3, 0.9, 0.3],
  ] as const;

  it("never builds the cone's bitangent from an axis parallel to the direction", () => {
    for (const direction of directions) {
      const tangent = launchTangent(direction);
      const length = Math.hypot(...direction);
      const unit = [direction[0] / length, direction[1] / length, direction[2] / length] as const;
      const cross = [
        unit[1] * tangent[2] - unit[2] * tangent[1],
        unit[2] * tangent[0] - unit[0] * tangent[2],
        unit[0] * tangent[1] - unit[1] * tangent[0],
      ];
      // A zero cross product is the NaN bitangent that loses the GPU device.
      expect(Math.hypot(...cross), JSON.stringify(direction)).toBeGreaterThan(0.1);
    }
  });
});
