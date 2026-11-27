// Playtest stations: each one sets up one mechanic in a single tick, so a scenario proves it in
// seconds. `scenes/Play.ts` binds them to keys only under a playtest runner, never in a real build.
import { GATES, LAP_LENGTH, PADS, pathAt, yawOf } from "../arena/layout.js";
import type { Car } from "../entities/Car.js";
import type { World } from "./World.js";

type Station = (world: World) => void;

/** Puts a car `lane` metres right of the circuit's centre line at circuit distance `s`. */
function put(car: Car, s: number, lane: number, speed = 0): void {
  const point = pathAt(s);
  car.place(point.x - point.fz * lane, point.z + point.fx * lane, yawOf(point), speed);
}

/** Parks every rival on the far straight, held still, so a station has only the cars it names. */
function isolate(world: World): void {
  world.holdPlayer = false;
  world.rivals.forEach((driver, index) => {
    driver.car.damage.repair(1e6);
    put(driver.car, LAP_LENGTH / 2 + index * 14, 0);
    driver.setObjective("wait");
    driver.ttl = 1e9;
    driver.grudge = 0;
  });
  world.player.damage.repair(1e6);
}

/** A rival parked dead ahead on the player's lane, held still. */
function target(world: World, index: number, ahead: number): Car {
  const driver = world.rivals[index];
  if (driver === undefined) throw new Error(`No rival ${index}.`);
  put(driver.car, 6 + ahead, 0);
  driver.setObjective("wait");
  driver.ttl = 1e9;
  return driver.car;
}

export const STATIONS: readonly Station[] = [
  // 1 launch: standing still on the start straight, for the gearbox and reverse.
  (world) => {
    isolate(world);
    put(world.player, 6, 0);
  },
  // 2 cruise: 18 m/s on the straight before the first turn, for cornering and the handbrake.
  (world) => {
    isolate(world);
    put(world.player, 30, 0, 18);
  },
  // 3 ram: a rival parked 32 m ahead, the player at 24 m/s.
  (world) => {
    isolate(world);
    put(world.player, 6, 0, 24);
    target(world, 0, 32);
  },
  // 4 wreck-last: one rival one hit from a wreck. The player closes on its tail, so the tail's
  // part, the transmission, is the one worn down.
  (world) => {
    isolate(world);
    put(world.player, 6, 0, 24);
    const rival = target(world, 0, 32);
    rival.damage.parts.transmission = 92;
  },
  // 5 win-wreck: two rivals already wrecked, the third one hit from it.
  (world) => {
    isolate(world);
    put(world.player, 6, 0, 24);
    const rival = target(world, 0, 32);
    rival.damage.parts.transmission = 92;
    for (const index of [1, 2]) world.rivals[index]?.car.wreck();
  },
  // 6 repair: stopped on a pad with damaged parts and a crumpled panel.
  (world) => {
    isolate(world);
    const pad = PADS[0];
    world.player.place(pad.x, pad.z, 0);
    world.player.damage.parts.engine = 60;
    world.player.damage.parts.brake2 = 70;
    world.player.damage.parts.wheel0 = 50;
    world.player.damage.crush.front = 0.8;
  },
  // 7 gate: 14 m before gate 1 at 18 m/s, the first gate of the lap.
  (world) => {
    isolate(world);
    const s = LAP_LENGTH / GATES - 14;
    world.race.set({ lap: 1, nextGate: 1 });
    put(world.player, s, 0, 18);
  },
  // 8 final-gate: the last lap, every gate passed, 14 m before the finish line.
  (world) => {
    isolate(world);
    world.race.set({ lap: 2, nextGate: 0 });
    put(world.player, LAP_LENGTH - 14, 0, 18);
  },
  // 9 low-time: 2.5 seconds on the clock.
  (world) => {
    isolate(world);
    world.race.set({ timeLeft: 2.5 });
    put(world.player, 6, 0);
  },
  // 10 fragile: the player's engine is nearly gone, a rival parked ahead.
  (world) => {
    isolate(world);
    put(world.player, 6, 0, 24);
    target(world, 0, 32);
    world.player.damage.parts.engine = 92;
  },
  // 11 grudge: a rival 22 m ahead of the player with a full grudge.
  (world) => {
    isolate(world);
    put(world.player, 6, 0);
    const driver = world.rivals[0];
    if (driver === undefined) return;
    put(driver.car, 28, 0);
    driver.setObjective("race");
    driver.grudge = 100;
  },
  // 12 jam: a rival pursuing, jammed against a stationary player.
  (world) => {
    isolate(world);
    world.holdPlayer = true;
    put(world.player, 6, 0);
    const driver = world.rivals[0];
    if (driver === undefined) return;
    put(driver.car, 0, 0);
    driver.setObjective("pursue");
    driver.grudge = 100;
  },
  // 13 broken-car: engine, brakes and a wheel worn down, for the handling that damage takes away.
  (world) => {
    isolate(world);
    put(world.player, 30, 0, 12);
    const parts = world.player.damage.parts;
    parts.engine = 70;
    parts.brake0 = 70;
    parts.brake1 = 70;
    parts.brake2 = 70;
    parts.brake3 = 70;
    parts.wheel2 = 60;
  },
];
