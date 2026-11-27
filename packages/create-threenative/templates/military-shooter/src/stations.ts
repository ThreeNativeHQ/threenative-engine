import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { POSTS } from "./level.js";

/**
 * Playtest stations: each key puts the player at a fixed test spot, so one scenario proves one
 * mechanic in a few ticks instead of a scripted walk across the yard. `duel` names the one soldier
 * that may fire there; every other soldier holds fire, so a scenario measures one mechanic and not
 * the whole yard. No station: everyone fires. Delete them with the playtests.
 */
export interface IStation {
  readonly x: number;
  readonly z: number;
  /** Yaw, three.js convention: 0 faces north (-z). */
  readonly yaw: number;
  readonly pitch?: number;
  readonly duel?: string;
}

function facing(x: number, z: number, target: { readonly x: number; readonly z: number }): number {
  return Math.atan2(x - target.x, z - target.z);
}

function post(id: string): { readonly x: number; readonly z: number } {
  const found = POSTS.find((candidate) => candidate.id === id);
  if (found === undefined)
    throw new Error(`A playtest station names a post that does not exist: ${id}.`);
  return found;
}

export const STATIONS: Readonly<Record<string, IStation>> = {
  // The west lane, 30 m long and out of every soldier's reach: movement, stance and sprint.
  station1: { x: -20, z: 15, yaw: 0, duel: "none" },
  // In the open, 16 m from the far-west soldier, with no wall between: accuracy and aim.
  station2: { x: -5.5, z: 4, yaw: facing(-5.5, 4, post("far-west")), duel: "far-west" },
  // Behind the south low wall, facing the centre soldier: cover.
  station3: { x: 0, z: 6.6, yaw: 0, duel: "centre" },
  // Six metres from the far-east soldier, in the open, aimed down 24 degrees: a grenade that lands short and rolls.
  station4: { x: 10, z: -6.5, yaw: 0, pitch: -0.42, duel: "none" },
  // The same open lane as station2, nobody firing: the rifle kills.
  station5: { x: -5.5, z: 4, yaw: facing(-5.5, 4, post("far-west")), duel: "none" },
};
export const STATION_NAMES = Object.keys(STATIONS);

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
export const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;
