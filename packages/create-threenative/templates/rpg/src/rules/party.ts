// The party roster and follow steering. Reference: reone card `party-follow` (party.cpp,
// followleader.cpp). The leader is always first, at most three members, a fourth is refused.

/** Members a party holds. party.cpp:29. */
export const MAX_PARTY = 3;
/** Metres a follower keeps from the leader. types.h:28. */
export const FOLLOW_DISTANCE = 5;
/** A follower runs while it is further than this from where it should stand: squared metres. object.cpp:36. */
export const WALK_THRESHOLD_SQ = 4;
/** Extra metres between followers, so two do not stand on one spot. The kit's rule. */
export const FOLLOW_SPREAD = 1.2;

export class Party {
  readonly #order: string[] = [];

  get members(): readonly string[] {
    return this.#order;
  }

  get leader(): string {
    return this.#order[0] ?? "";
  }

  get full(): boolean {
    return this.#order.length >= MAX_PARTY;
  }

  has(id: string): boolean {
    return this.#order.includes(id);
  }

  /** Refuses a fourth member. */
  add(id: string): boolean {
    if (this.full || this.has(id)) return false;
    this.#order.push(id);
    return true;
  }

  /** Make a member the leader: it moves to the front and the others keep their order. */
  setLeader(id: string): boolean {
    const index = this.#order.indexOf(id);
    if (index < 0) return false;
    this.#order.splice(index, 1);
    this.#order.unshift(id);
    return true;
  }

  /**
   * The quick rotate: with two members they swap, with three the leader goes to the back.
   * `alive` skips a member who is down. Returns the new leader.
   */
  rotate(alive: (id: string) => boolean): string {
    for (let turn = 0; turn < this.#order.length; turn += 1) {
      const first = this.#order.shift();
      if (first !== undefined) this.#order.push(first);
      if (alive(this.leader)) break;
    }
    return this.leader;
  }
}

export interface IFollowStep {
  /** The point to walk to, on the line from the leader to the follower, at the follow distance. */
  readonly x: number;
  readonly z: number;
  readonly run: boolean;
}

/** Where a follower in slot `slot` (0 for the first follower) should head, or undefined when in place. */
export function followStep(
  follower: { readonly x: number; readonly z: number },
  leader: { readonly x: number; readonly z: number },
  slot: number,
): IFollowStep | undefined {
  const dx = follower.x - leader.x;
  const dz = follower.z - leader.z;
  const distance = Math.hypot(dx, dz);
  const stand = FOLLOW_DISTANCE + slot * FOLLOW_SPREAD;
  const remaining = distance - stand;
  if (remaining <= 0.25) return undefined;
  const k = stand / distance;
  return {
    run: remaining * remaining > WALK_THRESHOLD_SQ,
    x: leader.x + dx * k,
    z: leader.z + dz * k,
  };
}
