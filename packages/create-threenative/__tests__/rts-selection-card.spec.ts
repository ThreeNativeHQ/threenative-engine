import { describe, expect, it } from "vitest";
import { TYPES } from "../templates/rts/src/sim/types.js";
import {
  type ISelectionCard,
  selectionDamage,
  selectionDamageIsHealing,
  selectionStatus,
} from "../templates/rts/src/ui/labels.js";

/**
 * The selection card's sentences.
 *
 * AstraCraft's card says what the selection is doing, and two of its lines are the ones a port
 * drops because they are not an order kind: a bunker reports its garrison (`GARRISON 2 / 4`) and
 * its damage *is* that garrison, and a unit that has finished training but cannot leave the door
 * reads `EXIT BLOCKED` rather than `PRODUCTION ACTIVE`.
 */

const IDLE: ISelectionCard = { built: true, garrison: 0, orders: [], progress: 0, queue: [] };

describe("rts selection card status", () => {
  it("names the order the selection is under, highest priority first", () => {
    expect(selectionStatus("ranger", { ...IDLE, orders: ["move"] })).toBe("RELOCATING");
    expect(selectionStatus("ranger", { ...IDLE, orders: ["move", "attack"] })).toBe(
      "ENGAGING HOSTILE",
    );
    expect(selectionStatus("ranger", IDLE)).toBe("COMBAT READY");
    expect(selectionStatus(undefined, IDLE)).toBe("SYSTEM ONLINE");
  });

  it("reports a construction site before anything the site could also be doing", () => {
    expect(selectionStatus("barracks", { ...IDLE, built: false, progress: 0 })).toBe(
      "SURVEYOR EN ROUTE",
    );
    expect(selectionStatus("barracks", { ...IDLE, built: false, progress: 0.42 })).toBe(
      "WELDING 42%",
    );
  });

  it("counts a bunker's garrison, and calls a blocked exit blocked", () => {
    expect(selectionStatus("bunker", { ...IDLE, garrison: 2 })).toBe("GARRISON 2 / 4");
    expect(selectionStatus("barracks", { ...IDLE, queue: [0.42] })).toBe("PRODUCTION ACTIVE");
    expect(selectionStatus("barracks", { ...IDLE, queue: [1] })).toBe("EXIT BLOCKED");
  });

  it("gives a bunker the damage of the infantry inside it", () => {
    const ranger = TYPES.ranger.damage ?? 0;
    expect(ranger).toBeGreaterThan(0);
    expect(selectionDamage("bunker", 0)).toBe(0);
    expect(selectionDamage("bunker", 3)).toBe(3 * ranger);
    expect(selectionDamage("ranger", 0)).toBe(ranger);
    expect(selectionDamage(undefined, 0)).toBeUndefined();
    expect(selectionDamageIsHealing("bunker")).toBe(false);
  });
});
