// The selection card's sentences, apart from its layout.
//
// AstraCraft's card names one thing: what this selection is doing right now. That is a small state
// machine — a construction site outranks a factory, a factory outranks an order, an order outranks
// "ready" — and it is the part of the panel that reads wrong when it reads wrong, so it lives here
// where a test can read it instead of inside the JSX.
import { type EntityType, TYPES } from "../sim/types.js";

/** What the card knows about the primary selection, already counted by the scene. */
export interface ISelectionCard {
  readonly built: boolean;
  /** 0..1 of a construction site's weld. */
  readonly progress: number;
  /** Infantry inside a bunker. */
  readonly garrison: number;
  /** 0..1 of each queued unit, front of the queue first. */
  readonly queue: readonly number[];
  /** Distinct order kinds across the selection, as `Play` publishes them. */
  readonly orders: readonly string[];
}

/** Highest-priority order across the selection first: what a commander would want named. */
const STATUS: ReadonlyArray<readonly [string, string]> = [
  ["attack", "ENGAGING HOSTILE"],
  ["construct", "FABRICATING"],
  ["repair", "REPAIRING"],
  ["heal", "RESTORING ALLY"],
  ["garrison", "ENTERING BUNKER"],
  ["gather", "HARVESTING"],
  ["attackMove", "ADVANCING"],
  ["move", "RELOCATING"],
  ["hold", "HOLDING POSITION"],
];

/**
 * The card's status line.
 *
 * A bunker's "production" is the infantry that walked into it (`GARRISON 2 / 4`), and a unit that
 * has finished but cannot leave the door is `EXIT BLOCKED`, not `PRODUCTION ACTIVE`: the queue is
 * full, the unit is not moving, and one of those two words is why.
 */
export function selectionStatus(type: EntityType | undefined, card: ISelectionCard): string {
  const kind = type === undefined ? undefined : TYPES[type];
  if (kind === undefined) return "SYSTEM ONLINE";
  if (!card.built)
    return card.progress > 0 ? `WELDING ${Math.floor(card.progress * 100)}%` : "SURVEYOR EN ROUTE";
  if (kind.capacity !== undefined) return `GARRISON ${card.garrison} / ${kind.capacity}`;
  if (card.queue.length > 0)
    return (card.queue[0] ?? 0) >= 1 ? "EXIT BLOCKED" : "PRODUCTION ACTIVE";
  return STATUS.find(([order]) => card.orders.includes(order))?.[1] ?? "COMBAT READY";
}

/**
 * What the card's damage figure reads.
 *
 * A bunker has no gun of its own: its damage is the garrison — four Vanguards inside fire as four —
 * so reporting the building's own `damage` column would tell a full bunker it is harmless.
 */
export function selectionDamage(
  type: EntityType | undefined,
  garrison: number,
): number | undefined {
  const kind = type === undefined ? undefined : TYPES[type];
  if (kind === undefined) return undefined;
  if (kind.capacity !== undefined) return garrison * (TYPES.ranger.damage ?? 0);
  return kind.heal ?? kind.damage;
}

/** Whether the damage figure counts hit points per second (a Mender) rather than damage a shot. */
export function selectionDamageIsHealing(type: EntityType | undefined): boolean {
  return type !== undefined && TYPES[type].heal !== undefined;
}
