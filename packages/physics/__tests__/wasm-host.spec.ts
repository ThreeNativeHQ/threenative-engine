import { readFileSync } from "node:fs";
import * as RAPIER from "@dimforge/rapier3d-compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/native.js";
import type { INativePhysicsHost } from "../src/native/host.js";
import { createWasmPhysicsHost } from "../src/native/wasm-host.js";
import {
  type IPhysicsBodyCreateOptions,
  type IPhysicsRuntimeSimulation,
  PHYSICS_TRANSFORM_STRIDE,
  createWebPhysicsSimulation,
  physicsSimulationBackend,
} from "../src/simulation.js";

// PRD-899: the crate's standalone Wasm module drives the shared native backend on web.
const fixtures = new URL("./fixtures/", import.meta.url);
const scenario = JSON.parse(
  readFileSync(new URL("physics-parity.scenario.json", fixtures), "utf8"),
) as {
  gravity: [number, number, number];
  deltaTime: number;
  steps: number;
  removeAtStep: number;
  removeBodyId: number;
  teleportAtStep: number;
  teleportBodyId: number;
  teleportPosition: [number, number, number];
  bodies: {
    id: number;
    type: IPhysicsBodyCreateOptions["type"];
    shape: "box" | "capsule" | "sphere";
    shapeSize: [number, number, number];
    position: [number, number, number];
    mass: number;
    collisionLayer: number;
    collisionMask: number;
    sensor: boolean;
  }[];
  character: {
    bodyId: number;
    offset: number;
    maxSlopeClimbAngle: number;
    autostep: [number, number, number];
    snapToGround: number;
    oneWayLayers: number;
  };
  motions: { bodyId: number; startStep: number; endStep: number; delta: number[] }[];
  checkpoints: number[];
};
const table = JSON.parse(
  readFileSync(new URL("physics-parity.native-transforms.json", fixtures), "utf8"),
) as {
  rapierVersion: string;
  tolerance: number;
  checkpoints: { step: number; transforms: number[][] }[];
};

const calls = new Map<string, number>();
let memory: WebAssembly.Memory;
let host: INativePhysicsHost;

beforeAll(async () => {
  const bytes = readFileSync(new URL("../wasm/threenative_native_physics.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  memory = instance.exports.memory as WebAssembly.Memory;
  // Count every export call (over a copy: the exports object is frozen).
  const counted = new Proxy(
    { ...instance.exports },
    {
      get(target, name: string) {
        const value = target[name];
        if (typeof value !== "function") return value;
        return (...args: number[]) => {
          calls.set(name, (calls.get(name) ?? 0) + 1);
          return (value as (...values: number[]) => number)(...args);
        };
      },
    },
  );
  host = createWasmPhysicsHost(counted);
  globalThis.__THREENATIVE_NATIVE__ = { physics: host };
});

afterAll(() => {
  globalThis.__THREENATIVE_NATIVE__ = undefined;
});

function box(x: number, y: number, z: number, layer = 1, sensor = false) {
  return { collisionLayer: layer, collisionMask: 0xffff, kind: "box" as const, sensor, x, y, z };
}

function body(
  type: IPhysicsBodyCreateOptions["type"],
  position: { x: number; y: number; z: number },
  shape = box(0.5, 0.5, 0.5),
): IPhysicsBodyCreateOptions {
  return {
    mass: type === "dynamic" ? 1 : 0,
    position,
    rotation: { w: 1, x: 0, y: 0, z: 0 },
    sensor: shape.sensor,
    shape,
    type,
  };
}

function simulation(): IPhysicsRuntimeSimulation {
  const [x, y, z] = scenario.gravity;
  return physicsSimulationBackend().createSimulation({ gravity: { x, y, z } });
}

/** A character crossing a bumpy trimesh, with the ground normal it reads after each step. */
function trimeshWalkNormals(world: IPhysicsRuntimeSimulation): number[][] {
  const n = 40;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i += 1)
    for (let j = 0; j <= n; j += 1) {
      const x = (i / n - 0.5) * 20;
      const z = (j / n - 0.5) * 20;
      vertices.push(x, 0.3 * Math.sin(x * 0.7) * Math.cos(z * 0.5), z);
    }
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) {
      const a = i * (n + 1) + j;
      indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
  const ground = {
    ...box(0, 0, 0),
    indices: new Uint32Array(indices),
    kind: "trimesh" as const,
    vertices: new Float32Array(vertices),
  };
  world.createBody(body("fixed", { x: 0, y: 0, z: 0 }, ground));
  const capsule = { ...box(0.4, 0.5, 0, 2), kind: "capsule" as const, z: 0 };
  const id = world.createBody(body("character", { x: -8, y: 1.5, z: -6 }, capsule)).body.id;
  world.configureCharacter(id, {
    maxSlopeClimbAngle: Math.PI / 4,
    offset: 0.01,
    oneWayLayers: 0,
    snapToGround: 0.15,
  });
  const input = new Float32Array(PHYSICS_TRANSFORM_STRIDE);
  const normals: number[][] = [];
  for (let step = 0; step < 300; step += 1) {
    const p = world.readBodyTransform?.(id)?.position;
    if (p === undefined) throw new Error("missing character");
    input.set([id, p.x + 0.05, p.y - 0.03, p.z + 0.04, 0, 0, 0, 1]);
    world.step(1 / 60, { kinematicCount: 1, kinematicTransforms: input });
    const state = world.readCharacterState?.(id);
    const normal = state?.groundNormal ?? { x: 0, y: 1, z: 0 };
    normals.push([normal.x, normal.y, normal.z]);
  }
  world.dispose();
  return normals;
}

describe("Wasm physics host (PRD-899)", () => {
  it("reports the crate's Rapier version", () => {
    expect(host.version).toBe(table.rapierVersion);
  });

  it("one ray query makes one Wasm call and creates no wrapper object", () => {
    const world = simulation();
    const floor = world.createBody(body("fixed", { x: 0, y: -0.5, z: 0 }, box(50, 0.5, 50)));
    const raw = world.rawWorld as ReturnType<INativePhysicsHost["createSimulation"]>;
    const output = new Float32Array(8);
    const query = { collisionMask: 0xffff, from: { x: 0, y: 5, z: 0 }, to: { x: 0, y: -5, z: 0 } };
    expect(raw.intersectRay(query, output)).toBe(1);
    expect(output[0]).toBe(floor.body.id);
    calls.clear();
    let hits = 0;
    for (let index = 0; index < 1000; index += 1) {
      const hit = world.intersectRay({
        collisionMask: 0xffff,
        from: { x: (index % 40) - 20, y: 5, z: 0 },
        to: { x: (index % 40) - 20, y: -5, z: 0 },
      });
      if (hit?.body.id === floor.body.id) hits += 1;
    }
    expect([...calls]).toEqual([["tn_physics_intersect_ray", 1000]]);
    expect(hits).toBe(1000);
    world.dispose();
  });

  it("one fixed step reads every visible body pose with one call", () => {
    const world = simulation();
    world.createBody(body("fixed", { x: 0, y: -0.5, z: 0 }, box(50, 0.5, 50)));
    for (let index = 0; index < 300; index += 1)
      world.createBody(
        body("dynamic", { x: (index % 20) * 1.2, y: 1 + Math.floor(index / 20), z: 0 }),
      );
    const poses = new Float32Array(301 * PHYSICS_TRANSFORM_STRIDE);
    calls.clear();
    world.step(1 / 60);
    expect(world.readVisibleTransforms(poses)).toBe(301);
    expect(calls.get("tn_physics_step")).toBe(1);
    expect(calls.get("tn_physics_read_visible_transforms")).toBe(1);
    expect(poses[PHYSICS_TRANSFORM_STRIDE * 300]).toBe(300);
    world.dispose();
  });

  it("steps the shared parity scenario to the native transform table", () => {
    const world = simulation();
    for (const spec of scenario.bodies) {
      const [x, y, z] = spec.shapeSize;
      const created = world.createBody({
        mass: spec.mass,
        position: { x: spec.position[0], y: spec.position[1], z: spec.position[2] },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        sensor: spec.sensor,
        shape: {
          collisionLayer: spec.collisionLayer,
          collisionMask: spec.collisionMask,
          kind: spec.shape,
          sensor: spec.sensor,
          x,
          y,
          z,
        },
        type: spec.type,
      });
      expect(created.body.id).toBe(spec.id);
    }
    const { character } = scenario;
    world.configureCharacter(character.bodyId, {
      autostep: {
        includeDynamicBodies: character.autostep[2] === 1,
        maxHeight: character.autostep[0],
        minWidth: character.autostep[1],
      },
      maxSlopeClimbAngle: character.maxSlopeClimbAngle,
      offset: character.offset,
      oneWayLayers: character.oneWayLayers,
      snapToGround: character.snapToGround,
    });
    const count = scenario.bodies.length;
    const poses = new Float32Array(count * PHYSICS_TRANSFORM_STRIDE);
    const events = new Uint32Array(count * count * 4);
    const input = new Float32Array(scenario.motions.length * PHYSICS_TRANSFORM_STRIDE);
    const read = () => {
      const rows = world.readVisibleTransforms(poses);
      return Array.from({ length: rows }, (_, row) =>
        Array.from(poses.subarray(row * 8, row * 8 + 8)),
      );
    };
    const observed: { step: number; transforms: number[][] }[] = [];
    for (let step = 0; step < scenario.steps; step += 1) {
      if (step === scenario.removeAtStep) {
        world.removeBody(scenario.removeBodyId);
        world.drainCollisionEvents(events);
      }
      if (step === scenario.teleportAtStep) {
        const [x, y, z] = scenario.teleportPosition;
        world.setBodyTransform(scenario.teleportBodyId, { x, y, z });
      }
      const active = scenario.motions.filter((m) => step >= m.startStep && step < m.endStep);
      for (const [index, motion] of active.entries()) {
        const pose = world.readBodyTransform?.(motion.bodyId);
        if (pose === undefined) throw new Error(`missing body ${motion.bodyId}`);
        input.set(
          [
            motion.bodyId,
            pose.position.x + (motion.delta[0] as number),
            pose.position.y + (motion.delta[1] as number),
            pose.position.z + (motion.delta[2] as number),
            0,
            0,
            0,
            1,
          ],
          index * 8,
        );
      }
      world.step(scenario.deltaTime, { kinematicCount: active.length, kinematicTransforms: input });
      world.drainCollisionEvents(events);
      if (scenario.checkpoints.includes(step)) observed.push({ step, transforms: read() });
    }
    observed.push({ step: scenario.steps, transforms: read() });
    world.dispose();

    expect(observed.map((o) => o.step)).toEqual(table.checkpoints.map((c) => c.step));
    for (const [index, expected] of table.checkpoints.entries()) {
      const actual = observed[index]?.transforms ?? [];
      expect(actual.map((row) => row[0])).toEqual(expected.transforms.map((row) => row[0]));
      for (const [row, record] of expected.transforms.entries())
        for (let column = 1; column < 8; column += 1)
          expect(
            Math.abs((actual[row]?.[column] as number) - (record[column] as number)),
            `step ${expected.step} body ${record[0]} field ${column}`,
          ).toBeLessThanOrEqual(table.tolerance);
    }
  });

  it("keeps ray results right after Wasm memory grows", () => {
    const world = simulation();
    const floor = world.createBody(body("fixed", { x: 0, y: -0.5, z: 0 }, box(50, 0.5, 50)));
    const query = { collisionMask: 0xffff, from: { x: 0, y: 5, z: 0 }, to: { x: 0, y: -5, z: 0 } };
    expect(world.intersectRay(query)?.distance).toBeCloseTo(5);
    const before = memory.buffer;
    // A 6 MiB trimesh copy forces the module to grow, which detaches the old buffer.
    const vertices = new Float32Array(3 << 19);
    vertices.set([30, 0, 30, 31, 0, 30, 30, 0, 31]);
    world.createBody(
      body("fixed", { x: 0, y: 0, z: 0 }, {
        ...box(1, 1, 1),
        indices: new Uint32Array([0, 1, 2]),
        kind: "trimesh",
        vertices,
      } as unknown as ReturnType<typeof box>),
    );
    expect(memory.buffer).not.toBe(before);
    const hit = world.intersectRay(query);
    expect(hit?.body.id).toBe(floor.body.id);
    expect(hit?.distance).toBeCloseTo(5);
    world.dispose();
  });

  it("fails with the C++ binding's messages", () => {
    const raw = host.createSimulation();
    const valid = {
      collisionLayer: 1,
      collisionMask: 0xffff,
      continuousCollision: true,
      mass: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: box(0.5, 0.5, 0.5),
      type: "dynamic" as const,
    };
    expect(() => raw.createBody({ ...valid, type: "ghost" as "dynamic" })).toThrow(
      "physics body options are invalid",
    );
    expect(() => raw.createBody({ ...valid, position: { x: Number.NaN, y: 0, z: 0 } })).toThrow(
      "physics body options are invalid",
    );
    expect(raw.createBody(valid)).toBe(0);
    expect(() => raw.applyBodyImpulse?.(99, { x: 0, y: 1, z: 0 })).toThrow(
      "TN_PHYSICS_UNKNOWN_BODY",
    );
    expect(() =>
      raw.intersectRay(
        { collisionMask: 1, from: { x: 1, y: 1, z: 1 }, to: { x: 1, y: 1, z: 1 } },
        new Float32Array(8),
      ),
    ).toThrow("intersectRay query options are invalid");
    expect(() =>
      raw.intersectRay({ collisionMask: 1, from: valid.position, to: valid.position }),
    ).toThrow("intersectRay requires query options and output");
    expect(() => raw.readVisibleTransforms(new Float32Array(4))).toThrow(
      "transform buffer is too small",
    );
    raw.dispose();
    expect(() => raw.createBody(valid)).toThrow("physics simulation is disposed");
    expect(() => host.createSimulation({ gravity: "down" })).toThrow(
      "physics options contain invalid gravity",
    );
  });

  it("reports the first walkable contact as ground, as the web backend does", async () => {
    // A character crossing a bumpy trimesh touches two faces in one move; the adventure kit's boss
    // fight drifted when the crate kept the last face's normal and compat the first.
    await RAPIER.init();
    const compat = trimeshWalkNormals(
      createWebPhysicsSimulation({
        eventQueue: new RAPIER.EventQueue(true),
        rapier: RAPIER,
        version: RAPIER.version(),
        world: new RAPIER.World({ x: 0, y: -9.81, z: 0 }),
      }),
    );
    const crate = trimeshWalkNormals(simulation());
    for (const [step, normal] of compat.entries())
      for (const [axis, value] of normal.entries())
        expect(crate[step]?.[axis], `step ${step} axis ${axis}`).toBeCloseTo(value, 4);
  });
});
