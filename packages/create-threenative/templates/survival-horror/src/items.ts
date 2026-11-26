import type { ItemId } from "./level.js";

export interface IItemDefinition {
  readonly label: string;
  /** The most of this item one slot holds. Herbs, keys and the gun take a slot each. */
  readonly stack: number;
}

export const ITEMS: Readonly<Record<ItemId, IItemDefinition>> = {
  handgun: { label: "Handgun", stack: 1 },
  ammo: { label: "Handgun Bullets", stack: 60 },
  herb: { label: "Green Herb", stack: 1 },
  key: { label: "Study Key", stack: 1 },
  ribbon: { label: "Ink Ribbon", stack: 10 },
};

export interface IStack {
  readonly item: ItemId;
  readonly quantity: number;
}

/** The six-slot case every classic survival-horror hero carries (the second character gets eight). */
export const CASE_SLOTS = 6;

/**
 * A list of stacks with an optional slot limit: the case has six, the item box has none. Stackable
 * items fill an existing stack before they take a new slot, and what does not fit is returned.
 */
export class Inventory {
  readonly #slots: IStack[] = [];

  constructor(readonly capacity = Number.POSITIVE_INFINITY) {}

  get slots(): readonly IStack[] {
    return this.#slots;
  }

  get full(): boolean {
    return this.#slots.length >= this.capacity;
  }

  count(item: ItemId): number {
    let total = 0;
    for (const stack of this.#slots) if (stack.item === item) total += stack.quantity;
    return total;
  }

  /** Adds what fits and returns the remainder: 0 means it all went in. */
  add(item: ItemId, quantity: number): number {
    const { stack } = ITEMS[item];
    let left = quantity;
    for (let index = 0; index < this.#slots.length && left > 0; index += 1) {
      const slot = this.#slots[index] as IStack;
      if (slot.item !== item || slot.quantity >= stack) continue;
      const moved = Math.min(left, stack - slot.quantity);
      this.#slots[index] = { item, quantity: slot.quantity + moved };
      left -= moved;
    }
    while (left > 0 && this.#slots.length < this.capacity) {
      const moved = Math.min(left, stack);
      this.#slots.push({ item, quantity: moved });
      left -= moved;
    }
    return left;
  }

  /** Whether `add` would take all of it, without adding anything. */
  fits(item: ItemId, quantity: number): boolean {
    const { stack } = ITEMS[item];
    let room = (this.capacity - this.#slots.length) * stack;
    for (const slot of this.#slots) if (slot.item === item) room += stack - slot.quantity;
    return room >= quantity;
  }

  /** Takes up to `quantity` from the last stacks first; an emptied slot is freed. */
  take(item: ItemId, quantity: number): number {
    let taken = 0;
    for (let index = this.#slots.length - 1; index >= 0 && taken < quantity; index -= 1) {
      const slot = this.#slots[index] as IStack;
      if (slot.item !== item) continue;
      const moved = Math.min(quantity - taken, slot.quantity);
      taken += moved;
      if (moved === slot.quantity) this.#slots.splice(index, 1);
      else this.#slots[index] = { item, quantity: slot.quantity - moved };
    }
    return taken;
  }

  /** Removes one whole slot and returns it. */
  removeAt(index: number): IStack | undefined {
    return this.#slots.splice(index, 1)[0];
  }

  restore(stacks: readonly IStack[]): void {
    this.#slots.length = 0;
    for (const stack of stacks) this.#slots.push({ ...stack });
  }

  /** JSON-safe copy for the HUD and for a save. */
  snapshot(): IStack[] {
    return this.#slots.map((stack) => ({ ...stack }));
  }
}
