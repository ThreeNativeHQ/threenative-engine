// Combat rounds. Reference: reone card `combat-round-timing` (combat.cpp).
// A round belongs to the attacker. Its first attack lands at the half mark, a duel partner's
// answer lands at the end, and the round ends the attacker's queued action.

/** Seconds per round, advanced by the frame delta. combat.cpp:35. */
export const ROUND_DURATION = 3;
/** A reversed attack joins the round only before this fraction of it. combat.cpp:57. */
export const DUEL_WINDOW = 0.5;
/** Seconds after a round ends before combat switches off. combat.cpp:37. */
export const COMBAT_DEACTIVATE_DELAY = 8;
/**
 * Seconds before a result that the swing starts, so the blade meets the target as the result
 * applies. The kit's animation rule, not from the card.
 */
export const SWING_LEAD = 0.25;

export interface IAttack {
  readonly attacker: string;
  readonly target: string;
}

export type RoundEvent =
  | { readonly kind: "swing"; readonly attack: IAttack }
  | { readonly kind: "resolve"; readonly attack: IAttack }
  | { readonly kind: "end"; readonly attackers: readonly string[] };

interface IRound {
  time: number;
  readonly first: IAttack;
  second: IAttack | undefined;
  swung: [boolean, boolean];
  resolved: [boolean, boolean];
}

export class CombatRounds {
  readonly #rounds = new Map<string, IRound>();
  /** Seconds since the last round ended or began: combat holds while it is under the delay. */
  idle = COMBAT_DEACTIVATE_DELAY;

  /** True while the actor owns a round or is the answering side of a duel. */
  isBusy(actor: string): boolean {
    for (const [owner, round] of this.#rounds)
      if (owner === actor || round.second?.attacker === actor) return true;
    return false;
  }

  /** The round the actor takes part in, as seconds elapsed; 0 when it has none. */
  elapsed(actor: string): number {
    for (const [owner, round] of this.#rounds)
      if (owner === actor || round.second?.attacker === actor) return round.time;
    return 0;
  }

  get active(): boolean {
    return this.#rounds.size > 0 || this.idle < COMBAT_DEACTIVATE_DELAY;
  }

  /**
   * Register an attack. Returns "started" for a new round, "duel" when it joined the target's
   * round as the second attack, and "busy" when the attacker already fights this round.
   */
  register(attacker: string, target: string): "started" | "duel" | "busy" {
    if (this.isBusy(attacker)) return "busy";
    this.idle = 0;
    const theirs = this.#rounds.get(target);
    if (
      theirs !== undefined &&
      theirs.second === undefined &&
      theirs.first.target === attacker &&
      theirs.time < ROUND_DURATION * DUEL_WINDOW
    ) {
      theirs.second = { attacker, target };
      return "duel";
    }
    this.#rounds.set(attacker, {
      first: { attacker, target },
      resolved: [false, false],
      second: undefined,
      swung: [false, false],
      time: 0,
    });
    return "started";
  }

  /**
   * An actor that went down leaves its round, and a duel partner's answer goes with it. Returns the
   * actors the round no longer holds, so the game can let them move again.
   */
  cancel(actor: string): string[] {
    const freed: string[] = [];
    const own = this.#rounds.get(actor);
    if (own?.second !== undefined) freed.push(own.second.attacker);
    this.#rounds.delete(actor);
    for (const round of this.#rounds.values())
      if (round.second?.attacker === actor) round.second = undefined;
    return freed;
  }

  update(dt: number): RoundEvent[] {
    const events: RoundEvent[] = [];
    if (this.#rounds.size === 0) this.idle = Math.min(COMBAT_DEACTIVATE_DELAY, this.idle + dt);
    for (const [owner, round] of this.#rounds) {
      round.time = Math.min(ROUND_DURATION, round.time + dt);
      const half = ROUND_DURATION * DUEL_WINDOW;
      const slots: [IAttack | undefined, number][] = [
        [round.first, half],
        [round.second, ROUND_DURATION],
      ];
      slots.forEach(([attack, at], index) => {
        if (attack === undefined) return;
        if (!round.swung[index as 0 | 1] && round.time >= at - SWING_LEAD) {
          round.swung[index as 0 | 1] = true;
          events.push({ attack, kind: "swing" });
        }
        if (!round.resolved[index as 0 | 1] && round.time >= at) {
          round.resolved[index as 0 | 1] = true;
          events.push({ attack, kind: "resolve" });
        }
      });
      if (round.time >= ROUND_DURATION) {
        const attackers = [owner];
        if (round.second !== undefined) attackers.push(round.second.attacker);
        this.#rounds.delete(owner);
        this.idle = 0;
        events.push({ attackers, kind: "end" });
      }
    }
    return events;
  }
}
