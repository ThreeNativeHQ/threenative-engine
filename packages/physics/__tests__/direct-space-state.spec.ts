import * as RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { PhysicsDirectSpaceState3D } from "../src/PhysicsDirectSpaceState3D.js";
import { type INativeSimulation, createNativePhysicsSimulation } from "../src/native/host.js";
import { createWebPhysicsSimulation } from "../src/simulation.js";

const AGENT_COUNT = 5;
const FRAME_COUNT = 60;

beforeAll(async () => {
  await RAPIER.init();
});

function createSimulation() {
  return createWebPhysicsSimulation({
    eventQueue: new RAPIER.EventQueue(true),
    rapier: RAPIER,
    version: RAPIER.version(),
    world: new RAPIER.World({ x: 0, y: 0, z: 0 }),
  });
}

function addStaticBox(
  simulation: ReturnType<typeof createSimulation>,
  position: { readonly x: number; readonly y: number; readonly z: number },
): void {
  simulation.createBody({
    mass: 0,
    position,
    rotation: { w: 1, x: 0, y: 0, z: 0 },
    sensor: false,
    shape: CollisionShape3D.box(1, 1, 1).descriptor,
    type: "fixed",
  });
}

interface IVisibilityMeasurement {
  readonly frames: number;
  readonly queries: number;
  readonly queryMs: number;
}

function requireQueryObservation(measurement: IVisibilityMeasurement): void {
  if (
    measurement.frames === 0 ||
    measurement.queries === 0 ||
    !Number.isFinite(measurement.queryMs)
  ) {
    throw new Error("TN_PRD325_VISIBILITY_MISSING_QUERY_OBSERVATION");
  }
}

describe("Phase 0 direct-space visibility measurement", () => {
  it("records one shipped ray query per agent per fixed frame and fails closed when absent", () => {
    const simulation = createSimulation();
    for (let index = 0; index < 143; index += 1) {
      addStaticBox(simulation, {
        x: (index % 13) * 2 - 12,
        y: 1,
        z: Math.floor(index / 13) * 2 - 10,
      });
    }
    simulation.step(1 / 60);
    const space = new PhysicsDirectSpaceState3D(simulation);
    let queryMs = 0;
    let queries = 0;
    const runQuery = (options: Parameters<PhysicsDirectSpaceState3D["intersectRay"]>[0]): void => {
      space.intersectRay(options);
      queries += 1;
    };
    const started = performance.now();
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      for (let agent = 0; agent < AGENT_COUNT; agent += 1) {
        runQuery({
          collisionMask: 1,
          from: { x: agent * 0.25, y: 1.7, z: 20 },
          to: { x: agent * 0.25, y: 1.7, z: -20 },
        });
      }
    }
    queryMs = performance.now() - started;
    const measurement = { frames: FRAME_COUNT, queries, queryMs };
    requireQueryObservation(measurement);
    expect(measurement.queries).toBe(FRAME_COUNT * AGENT_COUNT);
    expect(measurement.queryMs).toBeGreaterThanOrEqual(0);
    console.info(`TN_PRD325_VISIBILITY_UNIT:${JSON.stringify(measurement)}`);
    simulation.dispose();
  });
});

describe("native ray output decoding", () => {
  const query = { collisionMask: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 10, z: 0 } };
  /** A native host whose one body is `target` and whose ray writes `record` into the output. */
  function nativeRay(record: readonly number[]) {
    const raw = {
      createBody: vi.fn().mockReturnValue(0),
      intersectRay: vi.fn((_query: unknown, out: Float32Array) => {
        out.set(record);
        return 1;
      }),
    };
    const simulation = createNativePhysicsSimulation(raw as unknown as INativeSimulation, "0.30.0");
    simulation.createBody({
      entity: "target",
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.box(1, 1, 1).descriptor,
      type: "fixed",
    });
    return simulation;
  }

  it("returns one hit with the query-hit fields in order, then distance and normal", () => {
    const hit = nativeRay([0, 1, 2, 3, 0, 1, 0, 4.5]).intersectRay(query);
    expect(hit && Object.keys(hit)).toEqual(["body", "entity", "position", "distance", "normal"]);
    expect(hit).toMatchObject({
      distance: 4.5,
      entity: "target",
      normal: { x: 0, y: 1, z: 0 },
      position: { x: 1, y: 2, z: 3 },
    });
    expect(hit?.body.entity).toBe("target");
  });

  it("fails closed on every malformed record with the same message as before", () => {
    const cases: [readonly number[], RegExp][] = [
      [[-1, 1, 2, 3, 0, 1, 0, 1], /ray output is malformed/],
      [[0.5, 1, 2, 3, 0, 1, 0, 1], /ray output is malformed/],
      [[7, 1, 2, 3, 0, 1, 0, 1], /query returned an unknown body/],
      [[0, Number.NaN, 2, 3, 0, 1, 0, 1], /query hit position contains a non-finite vector/],
      [[0, 1, 2, 3, 0, 1, 0, -1], /ray output distance is invalid/],
      [[0, 1, 2, 3, 0, 1, 0, Number.POSITIVE_INFINITY], /ray output distance is invalid/],
      [[0, 1, 2, 3, 0, Number.NaN, 0, 1], /ray output normal contains a non-finite vector/],
    ];
    for (const [record, message] of cases)
      expect(() => nativeRay(record).intersectRay(query)).toThrow(message);
  });
});
