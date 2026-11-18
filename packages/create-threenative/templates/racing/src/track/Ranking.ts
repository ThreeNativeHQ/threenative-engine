import { Vector3 } from "three";
import { CIRCUIT, type CircuitLine } from "./circuit.js";

export interface IRacerProgress {
  readonly id: string;
  readonly lap: number;
  readonly position: Vector3;
}

/**
 * A ranked row is game state, so it holds plain values only: hot reload throws on a class
 * instance, and a `position: Vector3` here reloaded the whole page on every edit.
 */
export interface IRankedRacer {
  readonly id: string;
  readonly lap: number;
  readonly place: number;
  readonly routeProgress: number;
}

export interface IRankedRacerScratch {
  id: string;
  lap: number;
  place: number;
  routeProgress: number;
}

const projectionScratch = {
  curvature: 0,
  distance: 0,
  lateral: 0,
  point: new Vector3(0, 0, 0),
  tangent: new Vector3(0, 0, 1),
};

function compareRankedRacers(left: IRankedRacerScratch, right: IRankedRacerScratch): number {
  return right.routeProgress - left.routeProgress || left.id.localeCompare(right.id);
}

/**
 * How far around the circuit a car has come, in metres, counting whole laps.
 *
 * A projection is 0…one lap, so a lap count read straight off it can never leave 0…1 — which is
 * how a car a lap ahead and a car on the same metre once ranked as level. The lap number is added
 * on, and it is the **lap**, not the metre, that separates the two.
 */
export function routeProgress(
  route: CircuitLine,
  position: Vector3,
  lap: number,
  target = projectionScratch,
): number {
  if (!Number.isInteger(lap) || lap < 0)
    throw new Error("Racing route lap must be a non-negative integer.");
  return lap * route.totalLength + route.project(position, target).distance;
}

export function rankRacers(
  route: CircuitLine,
  racers: readonly IRacerProgress[],
  target = projectionScratch,
  buffer: IRankedRacerScratch[] = [],
): readonly IRankedRacer[] {
  if (buffer.length > racers.length) buffer.length = racers.length;
  for (let index = buffer.length; index < racers.length; index += 1) {
    buffer.push({ id: "", lap: 0, place: 0, routeProgress: 0 });
  }
  for (let index = 0; index < racers.length; index += 1) {
    const racer = racers[index];
    if (racer === undefined) throw new Error("Racing racer input is missing.");
    const ranked = buffer[index];
    if (ranked === undefined) throw new Error("Racing ranking buffer slot is missing.");
    ranked.id = racer.id;
    ranked.lap = racer.lap;
    ranked.routeProgress = routeProgress(route, racer.position, racer.lap, target);
    ranked.place = 0;
  }
  buffer.sort(compareRankedRacers);
  for (let index = 0; index < buffer.length; index += 1) {
    const racer = buffer[index];
    if (racer === undefined) throw new Error("Racing ranked racer is missing.");
    racer.place = index + 1;
  }
  return buffer;
}

export { CIRCUIT };
