// PRD-899: the web build of the physics crate (`build-native-physics.mjs --web`, a standalone
// wasm32-unknown-unknown module) steps the shared parity scenario to the committed native table.
// Run: node scripts/build-native-physics.mjs --web && node --test tests/physics-web-parity.node.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const runtimeRoot = new URL("../", import.meta.url);
const modulePath = new URL(
  ".runtime/physics-target/wasm32-unknown-unknown/release/threenative_native_physics.wasm",
  runtimeRoot,
);
const fixtures = new URL("../physics/__tests__/fixtures/", runtimeRoot);
const scenarioBytes = readFileSync(new URL("physics-parity.scenario.json", fixtures));
const scenario = JSON.parse(scenarioBytes.toString("utf8"));
const table = JSON.parse(
  readFileSync(new URL("physics-parity.native-transforms.json", fixtures), "utf8"),
);

const TRANSFORM_WIDTH = 8;
const EVENT_WIDTH = 4;
const BODY_OPTIONS_BYTES = 68; // TnPhysicsBodyOptions, repr(C), wasm32
const CHARACTER_OPTIONS_BYTES = 40; // TnPhysicsCharacterOptions, repr(C), wasm32
const BODY_TYPES = { dynamic: 0, fixed: 1, kinematic: 2, character: 3 };
const SHAPE_TYPES = { box: 0, sphere: 1, capsule: 2 };

function assertMatchesTable(observed) {
  assert.equal(observed.length, table.checkpoints.length);
  let maxDelta = 0;
  for (const [index, expected] of table.checkpoints.entries()) {
    const actual = observed[index];
    assert.equal(actual.step, expected.step);
    assert.equal(actual.transforms.length, expected.transforms.length, `step ${actual.step}`);
    for (const [row, record] of expected.transforms.entries()) {
      const got = actual.transforms[row];
      assert.equal(got[0], record[0], `step ${actual.step} body order`);
      for (let column = 1; column < TRANSFORM_WIDTH; column += 1) {
        const delta = Math.abs(got[column] - record[column]);
        maxDelta = Math.max(maxDelta, delta);
        assert.ok(
          delta <= table.tolerance,
          `step ${actual.step} body ${record[0]} field ${column}: ${got[column]} vs ${record[column]}`,
        );
      }
    }
  }
  return maxDelta;
}

test("the web physics module steps the parity scenario to the native transform table", async () => {
  assert.ok(
    existsSync(modulePath),
    `missing ${modulePath.pathname}: run node scripts/build-native-physics.mjs --web`,
  );
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {});
  const wasm = instance.exports;
  const view = () => new DataView(wasm.memory.buffer);
  const alloc = (bytes) => {
    const pointer = wasm.tn_physics_alloc(bytes);
    assert.notEqual(pointer, 0, `tn_physics_alloc(${bytes}) failed`);
    return pointer;
  };
  const writeRecord = (pointer, fields) => {
    const memory = view();
    for (const [offset, kind, value] of fields) {
      if (kind === "f32") memory.setFloat32(pointer + offset, value, true);
      else if (kind === "u32") memory.setUint32(pointer + offset, value, true);
      else memory.setUint8(pointer + offset, value ? 1 : 0);
    }
  };

  const versionPointer = wasm.tn_physics_version();
  const versionBytes = new Uint8Array(wasm.memory.buffer, versionPointer, 16);
  const version = new TextDecoder().decode(versionBytes.subarray(0, versionBytes.indexOf(0)));
  assert.equal(version, table.rapierVersion);
  assert.equal(createHash("sha256").update(scenarioBytes).digest("hex"), table.scenarioSha256);

  const world = alloc(12);
  writeRecord(world, scenario.gravity.map((value, index) => [index * 4, "f32", value]));
  const simulation = wasm.tn_physics_create(world);
  assert.notEqual(simulation, 0, "tn_physics_create returned null");

  const bodyRecord = alloc(BODY_OPTIONS_BYTES);
  for (const body of scenario.bodies) {
    writeRecord(bodyRecord, [
      [0, "u32", body.id],
      [4, "u32", BODY_TYPES[body.type]],
      [8, "u32", SHAPE_TYPES[body.shape]],
      [12, "f32", body.position[0]],
      [16, "f32", body.position[1]],
      [20, "f32", body.position[2]],
      [24, "f32", 0],
      [28, "f32", 0],
      [32, "f32", 0],
      [36, "f32", 1],
      [40, "f32", body.shapeSize[0]],
      [44, "f32", body.shapeSize[1]],
      [48, "f32", body.shapeSize[2]],
      [52, "f32", body.mass],
      [56, "u32", body.collisionLayer],
      [60, "u32", body.collisionMask],
      [64, "bool", body.sensor],
      [65, "bool", true],
    ]);
    assert.equal(wasm.tn_physics_add_body(simulation, bodyRecord), 1, `${body.name} rejected`);
  }
  const { character } = scenario;
  const characterRecord = alloc(CHARACTER_OPTIONS_BYTES);
  writeRecord(characterRecord, [
    [0, "u32", character.bodyId],
    [4, "f32", character.offset],
    [8, "f32", character.maxSlopeClimbAngle],
    [12, "bool", true],
    [16, "f32", character.autostep[0]],
    [20, "f32", character.autostep[1]],
    [24, "bool", character.autostep[2] === 1],
    [25, "bool", true],
    [28, "f32", character.snapToGround],
    [32, "u32", character.oneWayLayers],
    [36, "bool", false],
  ]);
  assert.equal(wasm.tn_physics_configure_character(simulation, characterRecord), 1);

  const bodyCount = scenario.bodies.length;
  const transformFloats = bodyCount * TRANSFORM_WIDTH;
  const transforms = alloc(transformFloats * 4);
  const eventWords = bodyCount * bodyCount * EVENT_WIDTH;
  const events = alloc(eventWords * 4);
  const input = alloc(scenario.motions.length * TRANSFORM_WIDTH * 4);
  const readTransforms = () => {
    const count = wasm.tn_physics_read_visible_transforms(simulation, transforms, transformFloats);
    assert.ok(count >= 0, "tn_physics_read_visible_transforms rejected its buffer");
    const values = new Float32Array(wasm.memory.buffer, transforms, count * TRANSFORM_WIDTH);
    return Array.from({ length: count }, (_, index) =>
      Array.from(values.subarray(index * TRANSFORM_WIDTH, (index + 1) * TRANSFORM_WIDTH)),
    );
  };
  const drainEvents = () =>
    assert.ok(wasm.tn_physics_drain_collision_events(simulation, events, eventWords) >= 0);

  const observed = [];
  for (let step = 0; step < scenario.steps; step += 1) {
    if (step === scenario.removeAtStep) {
      assert.equal(wasm.tn_physics_remove_body(simulation, scenario.removeBodyId), 1);
      drainEvents();
    }
    if (step === scenario.teleportAtStep) {
      const [x, y, z] = scenario.teleportPosition;
      assert.equal(
        wasm.tn_physics_set_body_transform(simulation, scenario.teleportBodyId, x, y, z),
        1,
      );
    }
    const current = new Map(readTransforms().map((record) => [record[0], record]));
    const active = scenario.motions.filter(
      (motion) => step >= motion.startStep && step < motion.endStep,
    );
    const records = new Float32Array(wasm.memory.buffer, input, active.length * TRANSFORM_WIDTH);
    for (const [index, motion] of active.entries()) {
      const position = current.get(motion.bodyId);
      assert.ok(position, `motion references missing body ${motion.bodyId}`);
      records.set(
        [
          motion.bodyId,
          position[1] + motion.delta[0],
          position[2] + motion.delta[1],
          position[3] + motion.delta[2],
          0,
          0,
          0,
          1,
        ],
        index * TRANSFORM_WIDTH,
      );
    }
    assert.equal(
      wasm.tn_physics_step(simulation, scenario.deltaTime, input, active.length),
      1,
      `step ${step} rejected`,
    );
    drainEvents();
    if (scenario.checkpoints.includes(step)) observed.push({ step, transforms: readTransforms() });
  }
  observed.push({ step: scenario.steps, transforms: readTransforms() });
  wasm.tn_physics_destroy(simulation);

  const maxDelta = assertMatchesTable(observed);
  console.log(`TN_PHYSICS_WEB_PARITY max delta ${maxDelta} over ${observed.length} checkpoints`);
});
