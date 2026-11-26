// Playtest stations: each key puts the fighters in a fixed test setup, so one scenario proves one
// mechanic in a few ticks instead of a scripted walk across the stage. They answer only under a
// playtest runner (`UNDER_PLAYTEST` in `Play.ts`). Delete them with the playtests.
import { SPAWN } from "../level.js";
import { type ICpuMemory } from "../sim/cpu.js";
import { JAB } from "../sim/attacks.js";
import { CPU_WEIGHT, SHIELD_MAX, STOCKS } from "../sim/constants.js";
import { startAttack } from "../sim/fighter.js";
import type { Match } from "../sim/match.js";

export interface IStationHost {
  readonly match: Match;
  readonly cpu: ICpuMemory;
}

/** Station `n` is `STATIONS[n - 1]`. */
export const STATIONS: readonly ((host: IStationHost) => void)[] = [
  // 1. A punching bag one metre in front of the player, both at zero percent.
  ({ match, cpu }) => {
    match.place("p1", -1, 0, 1);
    match.place("cpu", 0, 0, -1);
    for (const f of Object.values(match.fighters)) {
      f.percent = 0;
      f.shield = SHIELD_MAX;
      f.stocks = STOCKS;
    }
    match.fighters.cpu.weight = CPU_WEIGHT;
    cpu.dummy = true;
  },
  // 2. The bag at 100 percent.
  ({ match }) => {
    match.fighters.cpu.percent = 100;
  },
  // 3. A heavy bag.
  ({ match }) => {
    match.fighters.cpu.weight = 1.6;
  },
  // 4. A light bag.
  ({ match }) => {
    match.fighters.cpu.weight = 0.7;
  },
  // 5. The player's shield is nearly spent.
  ({ match }) => {
    match.fighters.p1.shield = 1;
  },
  // 6. The bag stands on the right edge at 180 percent, with the player beside it.
  ({ match, cpu }) => {
    match.place("p1", 4.9, 0, 1);
    match.place("cpu", 6.2, 0, -1);
    match.fighters.cpu.percent = 180;
    cpu.dummy = true;
  },
  // 7. The player falls beside the right ledge, below the stage top.
  ({ match, cpu }) => {
    match.place("p1", 7.9, -1.4, -1);
    match.fighters.p1.vy = -1;
    cpu.dummy = true;
  },
  // 8. A fair fight: the CPU is awake and the fighters start apart.
  ({ match, cpu }) => {
    match.place("p1", SPAWN.p1.x - 1, 0, 1);
    match.place("cpu", SPAWN.cpu.x + 1, 0, -1);
    cpu.dummy = false;
    cpu.wakeAt = 0;
  },
  // 9. The CPU steps up to the player and swings a jab now.
  ({ match, cpu }) => {
    const p1 = match.fighters.p1;
    match.place("cpu", p1.x + p1.facing, p1.y, (-p1.facing) as -1 | 1);
    startAttack(match.fighters.cpu, JAB);
    cpu.dummy = true;
  },
  // 10. The CPU is off the stage, beside the right ledge, and awake.
  ({ match, cpu }) => {
    match.place("p1", -4, 0, 1);
    match.place("cpu", 10.5, -1, -1);
    cpu.dummy = false;
    cpu.wakeAt = 0;
  },
  // 11. The player falls toward the bottom blast zone.
  ({ match, cpu }) => {
    match.place("p1", 0, -13, 1);
    match.fighters.p1.vy = -6;
    cpu.dummy = true;
  },
  // 12. Both fighters are on their last stock.
  ({ match }) => {
    match.fighters.p1.stocks = 1;
    match.fighters.cpu.stocks = 1;
  },
  // 13. The fighters far apart, one up on a platform: the camera backs off to keep both in frame.
  ({ match, cpu }) => {
    match.place("p1", -6.5, 0, 1);
    match.place("cpu", 4.5, 2.6, -1);
    cpu.dummy = true;
  },
];
