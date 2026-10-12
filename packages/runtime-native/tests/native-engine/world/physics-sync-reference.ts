/**
 * PRD-528 boxes 53/54: records what the TypeScript physics path — the real `packages/physics`
 * simulation on WASM Rapier 0.19.3 — produces over the shared parity scenario, as the JSON the
 * native `PhysicsSync` test replays: every checkpoint's body transform and area membership, and the
 * whole collision-event sequence in the order Rapier reported it.
 *
 * The scenario itself records no transforms, so the web arm's own numbers are the reference. They
 * come from `physicsSimulationBackend().createSimulation()`, which `packages/physics/src/web.ts`
 * backs with the WASM world and its `EventQueue`, driven exactly as
 * `native/physics/tests/parity.rs` drives the native arm.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/world/physics-sync-reference.ts
 *   ... -- --check   (fails when the committed table is not what the TS simulation produces today)
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type IPhysicsRuntimeSimulation,
  PHYSICS_COLLISION_EVENT_STRIDE,
  PHYSICS_TRANSFORM_STRIDE,
  physicsSimulationBackend,
} from "../../../../physics/src/simulation.js";
import "../../../../physics/src/web.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "physics_sync_reference.json");
const SCENARIO = path.resolve(
  HERE,
  "../../../../physics/__tests__/fixtures/physics-parity.scenario.json",
);
const AREA_ID = 5;

interface IScenarioBody {
  readonly id: number;
  readonly type: "character" | "dynamic" | "fixed" | "kinematic";
  readonly shape: "box" | "capsule" | "sphere";
  readonly shapeSize: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly mass: number;
  readonly collisionLayer: number;
  readonly collisionMask: number;
  readonly sensor: boolean;
}

interface IScenarioMotion {
  readonly bodyId: number;
  readonly startStep: number;
  readonly endStep: number;
  readonly delta: readonly [number, number, number];
}

interface IScenario {
  readonly schemaVersion: number;
  readonly expectedRapierVersions: { readonly web: string; readonly rust: string };
  readonly gravity: readonly [number, number, number];
  readonly deltaTime: number;
  readonly steps: number;
  readonly removeAtStep: number;
  readonly removeBodyId: number;
  readonly teleportAtStep: number;
  readonly teleportBodyId: number;
  readonly teleportPosition: readonly [number, number, number];
  readonly bodies: readonly IScenarioBody[];
  readonly character: {
    readonly bodyId: number;
    readonly offset: number;
    readonly maxSlopeClimbAngle: number;
    readonly autostep: readonly [number, number, number];
    readonly snapToGround: number;
    readonly oneWayLayers: number;
  };
  readonly motions: readonly IScenarioMotion[];
  readonly checkpoints: readonly number[];
}

interface IRecordedBody {
  readonly id: number;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
}

const scenarioBytes = readFileSync(SCENARIO);
const scenario = JSON.parse(scenarioBytes.toString("utf8")) as IScenario;
const scenarioSha256 = createHash("sha256").update(scenarioBytes).digest("hex");

function shapeOf(body: IScenarioBody) {
  return {
    collisionLayer: body.collisionLayer,
    collisionMask: body.collisionMask,
    kind: body.shape,
    sensor: body.sensor,
    x: body.shapeSize[0],
    y: body.shapeSize[1],
    z: body.shapeSize[2],
  } as const;
}

/** Every live body's id and its seven transform scalars, as `readVisibleTransforms` writes them. */
function transforms(simulation: IPhysicsRuntimeSimulation) {
  const buffer = new Float32Array(scenario.bodies.length * PHYSICS_TRANSFORM_STRIDE);
  const count = simulation.readVisibleTransforms(buffer);
  const result = new Map<number, IRecordedBody>();
  for (let index = 0; index < count; index += 1) {
    const offset = index * PHYSICS_TRANSFORM_STRIDE;
    const at = (scalar: number) => buffer[offset + scalar] as number;
    result.set(at(0), {
      id: at(0),
      position: [at(1), at(2), at(3)],
      quaternion: [at(4), at(5), at(6), at(7)],
    });
  }
  return result;
}

function drainEvents(simulation: IPhysicsRuntimeSimulation): string[] {
  const buffer = new Uint32Array(
    scenario.bodies.length * scenario.bodies.length * PHYSICS_COLLISION_EVENT_STRIDE,
  );
  const count = simulation.drainCollisionEvents(buffer);
  const events: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * PHYSICS_COLLISION_EVENT_STRIDE;
    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;
    events.push(`${Math.min(first, second)}-${Math.max(first, second)}-${buffer[offset + 2]}`);
  }
  return events;
}

/** The active motions of `step`, as the step's kinematic input records. */
function kinematicInput(step: number, current: Map<number, IRecordedBody>): Float32Array {
  const active = scenario.motions.filter(
    (motion) => step >= motion.startStep && step < motion.endStep,
  );
  const input = new Float32Array(active.length * PHYSICS_TRANSFORM_STRIDE);
  for (const [index, motion] of active.entries()) {
    const position = current.get(motion.bodyId);
    if (position === undefined)
      throw new Error(
        `TN_PHYSICS_SYNC_REFERENCE_MOTION: step ${step} moves missing body ${motion.bodyId}`,
      );
    input.set(
      [
        motion.bodyId,
        position.position[0] + motion.delta[0],
        position.position[1] + motion.delta[1],
        position.position[2] + motion.delta[2],
        0,
        0,
        0,
        1,
      ],
      index * PHYSICS_TRANSFORM_STRIDE,
    );
  }
  return input;
}

async function record() {
  const backend = physicsSimulationBackend();
  await backend.initialize();
  const simulation = backend.createSimulation({
    gravity: { x: scenario.gravity[0], y: scenario.gravity[1], z: scenario.gravity[2] },
  });
  if (scenario.schemaVersion !== 1)
    throw new Error(`TN_PHYSICS_SYNC_REFERENCE_SCHEMA: schema ${scenario.schemaVersion} is not 1`);
  if (simulation.version !== scenario.expectedRapierVersions.web)
    throw new Error(
      `TN_PHYSICS_SYNC_REFERENCE_VERSION: this run used Rapier ${simulation.version}, the scenario expects ${scenario.expectedRapierVersions.web}`,
    );

  for (const body of scenario.bodies)
    simulation.createBody({
      mass: body.mass,
      position: { x: body.position[0], y: body.position[1], z: body.position[2] },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: body.sensor,
      shape: shapeOf(body),
      type: body.type,
    });
  simulation.configureCharacter(scenario.character.bodyId, {
    autostep: {
      includeDynamicBodies: scenario.character.autostep[2] === 1,
      maxHeight: scenario.character.autostep[0],
      minWidth: scenario.character.autostep[1],
    },
    maxSlopeClimbAngle: scenario.character.maxSlopeClimbAngle,
    offset: scenario.character.offset,
    oneWayLayers: scenario.character.oneWayLayers,
    snapToGround: scenario.character.snapToGround,
  });

  const checkpoints: { bodies: IRecordedBody[]; areaMembership: number[]; step: number }[] = [];
  const collisionEventSequence: string[] = [];

  for (let step = 0; step < scenario.steps; step += 1) {
    if (step === scenario.removeAtStep) {
      simulation.removeBody(scenario.removeBodyId);
      collisionEventSequence.push(...drainEvents(simulation));
    }
    if (step === scenario.teleportAtStep)
      simulation.setBodyTransform(scenario.teleportBodyId, {
        x: scenario.teleportPosition[0],
        y: scenario.teleportPosition[1],
        z: scenario.teleportPosition[2],
      });

    const input = kinematicInput(step, transforms(simulation));
    simulation.step(scenario.deltaTime, {
      kinematicCount: input.length / PHYSICS_TRANSFORM_STRIDE,
      kinematicTransforms: input,
    });
    collisionEventSequence.push(...drainEvents(simulation));

    if (scenario.checkpoints.includes(step)) {
      checkpoints.push({
        areaMembership: [...(simulation.areaIntersections?.(AREA_ID) ?? [])].sort(
          (left, right) => left - right,
        ),
        bodies: [...transforms(simulation).values()],
        step,
      });
    }
  }

  const resting = transforms(simulation).get(1);
  const state = simulation.readCharacterState?.(scenario.character.bodyId);
  if (resting === undefined) throw new Error("TN_PHYSICS_SYNC_REFERENCE_MISSING: body 1 vanished");
  return {
    checkpoints,
    collisionEventSequence,
    deltaTime: scenario.deltaTime,
    groundCollider: state?.groundCollider ?? null,
    grounded: state?.grounded ?? false,
    restingPosition: resting.position,
    scenarioSha256,
    steps: scenario.steps,
    webRapierVersion: simulation.version,
  };
}

const table = await record();
const text = `${JSON.stringify(table, null, 1)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      `TN_PHYSICS_SYNC_REFERENCE_STALE: ${OUT} is not what the TS simulation produces today`,
    );
    process.exit(1);
  }
  console.log(
    `physics sync reference current: ${table.checkpoints.length} checkpoints, ${table.collisionEventSequence.length} events`,
  );
} else {
  writeFileSync(OUT, text);
  console.log(
    `wrote ${table.checkpoints.length} checkpoints and ${table.collisionEventSequence.length} events to ${OUT}`,
  );
}
