import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("action-RPG cloud save", () => {
  const SAVE_KEY = "threenative.action-rpg.progress";
  const CACHED_KEY = `tn-backend:kv:${SAVE_KEY}`;
  const INITIAL = { health: 100, room: 1, saveCount: 0 };

  /** The page's localStorage, as much of it as the backend uses. */
  function memoryStorage(seed: Record<string, string> = {}): Storage {
    const items = new Map(Object.entries(seed));
    return {
      get length() {
        return items.size;
      },
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: (index: number) => [...items.keys()][index] ?? null,
      removeItem: (key: string) => void items.delete(key),
      setItem: (key: string, value: string) => void items.set(key, value),
    } as Storage;
  }

  /** A share host that answers the probe and every value read with `value`. */
  function hostFetch(value: unknown): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const headers = { "x-threenative-backend": "1" };
      return String(input).endsWith("/v1/db")
        ? new Response("{}", { headers })
        : new Response(JSON.stringify({ value, version: 2 }), { headers });
    }) as typeof fetch;
  }

  /** The module is imported per test because it builds one backend for the page at import time. */
  async function freshProgress() {
    vi.resetModules();
    return import("../templates/action-rpg/src/progress.js");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps a save written before the backend owned the local layer", async () => {
    const storage = memoryStorage({ [SAVE_KEY]: JSON.stringify({ room: 3, saveCount: 7 }) });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", undefined);
    const progress = await freshProgress();

    await expect(progress.hydrateProgress(INITIAL)).resolves.toMatchObject({
      health: 100,
      room: 3,
      saveCount: 7,
    });
    expect(storage.getItem(CACHED_KEY), "written through to the backend's cache").toContain(
      '"room":3',
    );
    expect(storage.getItem(SAVE_KEY), "the only copy when the write cannot land").not.toBeNull();
    expect(progress.loadProgress(INITIAL)).toMatchObject({ room: 3, saveCount: 7 });
  });

  it("restores hosted progress after localStorage is cleared and the cookie is kept", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", hostFetch({ health: 40, room: 2, saveCount: 11 }));
    const progress = await freshProgress();

    await expect(progress.hydrateProgress(INITIAL)).resolves.toMatchObject({
      health: 40,
      room: 2,
      saveCount: 11,
    });
  });

  it("runs with no host and no storage, and never throws a save away", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("fetch", undefined);
    const progress = await freshProgress();

    await expect(progress.hydrateProgress(INITIAL)).resolves.toEqual(INITIAL);
    expect(() =>
      progress.saveProgress({ getState: () => ({ room: 3, saveCount: 9 }) }),
    ).not.toThrow();
    await Promise.resolve();
    expect(progress.loadProgress(INITIAL)).toMatchObject({ room: 3, saveCount: 9 });
  });
});
