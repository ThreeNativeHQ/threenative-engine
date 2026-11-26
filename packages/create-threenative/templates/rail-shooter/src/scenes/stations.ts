import { Vector3 } from "three";
import { Enemy } from "../entities/Enemy.js";
import type { Ship } from "../entities/Ship.js";
import type { Weapons } from "../entities/Weapons.js";
import { PICKUPS, WAVES } from "../level.js";
import { SHIELD } from "../tuning.js";

export interface IStationWorld {
  readonly ship: Ship;
  readonly weapons: Weapons;
  readonly addEnemy: (enemy: Enemy) => void;
  /** The distance at which the ship holds before the boss. */
  readonly arenaStop: number;
  /** Moves the ship along the rail and marks every wave it passes as already flown. */
  readonly skipTo: (s: number) => void;
}

/**
 * Playtest stations: each key sets up one situation, so a scenario proves one mechanic in a few
 * ticks instead of a long flight. They answer only under a playtest runner. Delete them with the
 * playtests that use them.
 */
export function createStations(world: IStationWorld): Readonly<Record<string, () => void>> {
  const { ship, weapons, addEnemy } = world;
  let dummies = 0;
  return {
    // A hostile shot 14 m ahead, aimed at the ship.
    station1: () => {
      const from = new Vector3().copy(ship.position).addScaledVector(ship.frame.forward, 14);
      weapons.fireEnemy(from, ship.frame.forward.clone().negate(), SHIELD.shotDamage);
    },
    // A scout riding 40 m ahead on the reticle's line, for the laser and its hit count.
    station2: () =>
      addEnemy(
        new Enemy({ id: `dummy.${++dummies}`, kind: "scout", pinned: { ahead: 40, x: 0, y: 0 } }),
      ),
    // A gunship riding 45 m ahead and 8 m to the side: outside the lasers, inside the lock-on.
    station3: () =>
      addEnemy(
        new Enemy({ id: `dummy.${++dummies}`, kind: "gunship", pinned: { ahead: 45, x: 8, y: 0 } }),
      ),
    // Just before the first wave.
    station4: () => world.skipTo((WAVES[0]?.trigger ?? 150) - 4),
    // Wounded, 12 m before the first shield ring and lined up with it.
    station5: () => {
      const [s, x, y] = PICKUPS[0] ?? [700, 0, 0];
      world.skipTo(s - 12);
      ship.offsetX = x;
      ship.offsetY = y;
      ship.hit(120);
    },
    // At the arena, with the hull unhurtable so a long fight outlives the boss's fire.
    station6: () => {
      world.skipTo(world.arenaStop - 70);
      ship.invulnerable = true;
    },
    // A killing blow, through the same path every hit takes.
    station7: () => {
      ship.hit(SHIELD.max + 10);
    },
  };
}
