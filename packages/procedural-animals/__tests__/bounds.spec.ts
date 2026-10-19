import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { wolfMotion } from "../../../examples/procedural-animals/src/render/wolf-motion.js";
import { createAnimalBounds } from "../src/bounds.js";
import { bakeWolf } from "../src/build.js";
import { createAnimalActor } from "../src/follow.js";
import { parseAnimalBake } from "../src/format.js";
import { createAnimalPose } from "../src/pose.js";
import { geometryFromValidatedBake } from "../src/runtime.js";
import { animalFixture, encodeFixture } from "./fixture.js";
import { deformReference } from "./oracle.js";

describe("independent DQS deformation and animated bounds", () => {
  it.each([Math.fround(3.4028234663852886e38), 2 ** -149, 1])(
    "contains independent deformation at float32 magnitude %s",
    (magnitude) => {
      const bake = parseAnimalBake(encodeFixture());
      const packet = new Float32Array(bake.bones.length * 20);
      for (let o = 0; o < packet.length; o += 20) {
        packet.set(
          [
            0.5,
            0.5,
            0.5,
            0.5,
            magnitude,
            -magnitude,
            magnitude,
            -magnitude,
            1,
            0,
            0,
            magnitude,
            0,
            1,
            0,
            -magnitude,
            0,
            0,
            1,
            magnitude,
          ],
          o,
        );
      }
      const bounds = createAnimalBounds(bake);
      bounds.update(packet);
      expect(Number.isFinite(bounds.sphere.radius)).toBe(true);
      for (let vertex = 0; vertex < bake.nV; vertex++)
        expect(bounds.sphere.containsPoint(deformReference(bake, packet, vertex).position)).toBe(
          true,
        );
    },
  );

  it("retains radius where opposed bone rotations make LBS collapse", () => {
    const packet = new Float32Array(40);
    for (let bone = 0; bone < 2; bone++) {
      const o = bone * 20;
      new Quaternion()
        .setFromAxisAngle(new Vector3(0, 0, 1), ((bone ? -1 : 1) * Math.PI) / 2)
        .toArray(packet, o);
      packet[o + 8] = packet[o + 13] = packet[o + 18] = 1;
    }
    const sample = {
      pos: new Float32Array([1, 0, 0]),
      nrm: new Float32Array([0, 1, 0]),
      skinIndex: new Uint16Array([0, 1, 0, 0]),
      skinWeight: new Float32Array([0.5, 0.5, 0, 0]),
    };
    expect(
      deformReference(sample, packet, 0).position.distanceTo(new Vector3(1, 0, 0)),
    ).toBeLessThan(1e-7);
    const lbs = new Vector3(1, 0, 0)
      .applyQuaternion(new Quaternion().fromArray(packet))
      .add(new Vector3(1, 0, 0).applyQuaternion(new Quaternion().fromArray(packet, 20)))
      .multiplyScalar(0.5);
    expect(lbs.length()).toBeLessThan(1e-7);
  });

  it("contains every crowd vertex through stand/walk/trot/turn/stop/sit/lie and altitude reset", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const animal = createAnimalActor(bake, {
      motion: wolfMotion,
      material: () => new MeshBasicMaterial(),
      ground: (x) => x * 0.1,
    });
    const position = new Vector3();
    const velocity = new Vector3();
    let sampled = 0;
    try {
      for (const phase of ["stand", "walk", "trot", "turn", "stop", "sit", "lie", "reset"]) {
        if (phase === "sit" || phase === "lie") void animal.play(phase);
        if (phase === "reset") {
          position.set(2, 3, -2);
          animal.teleport({ position, velocity, heading: Math.PI / 2 });
        }
        velocity.set(
          phase === "turn" ? 1.5 : 0,
          0,
          phase === "walk" ? 1.2 : phase === "trot" ? 3 : 0,
        );
        for (let tick = 0; tick < 120; tick++) {
          position.addScaledVector(velocity, 1 / 60);
          animal.follow(
            { position, velocity, heading: phase === "turn" ? Math.PI / 2 : 0 },
            1 / 60,
          );
          if (tick % 30 !== 29) continue;
          for (let vertex = 0; vertex < bake.nV; vertex++) {
            const deformed = deformReference(bake, animal.pose.data, vertex);
            expect(animal.bounds.sphere.containsPoint(deformed.position)).toBe(true);
            expect(animal.bounds.box.containsPoint(deformed.position)).toBe(true);
            expect(deformed.normal.length()).toBeCloseTo(1, 4);
            sampled++;
          }
        }
      }
      expect(sampled).toBe(bake.nV * 32);
      expect(animal.mesh.frustumCulled).toBe(true);
    } finally {
      animal.dispose();
    }
  }, 60_000);

  it("publishes no partial pose packet when a later bone becomes invalid", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const pose = createAnimalPose(bake);
    pose.update(new Matrix4());
    const original = pose.data.slice();
    const last = pose.skeleton.bones.at(-1);
    if (!last) throw new Error("missing actual wolf bone");
    last.matrixWorld.elements[12] = Number.NaN;
    expect(() => pose.update(new Matrix4())).toThrow("TN_ANIMAL_POSE");
    expect(pose.data).toEqual(original);
    pose.dispose();
  }, 30_000);
});

it("covers the permitted skin-weight normalization tolerance in the dual envelope", () => {
  const source = animalFixture();
  source.pos.fill(0);
  source.bones = [0, 1, 2].map((i) => ({
    name: `bone-${i}`,
    parent: null,
    headJ: "head",
    tailJ: "tail",
  }));
  for (let v = 0; v < 3; v++) {
    source.skinIndex.set([0, 1, 2, 0], v * 4);
    source.skinWeight.set([0.01, 0.495045, 0.495045, 0], v * 4);
  }
  const bake = parseAnimalBake(encodeFixture(source));
  const packet = new Float32Array(60);
  packet[0] = 1;
  packet[21] = 1;
  packet[41] = -1;
  packet[7] = packet[27] = packet[47] = 1;
  const bounds = createAnimalBounds(bake);
  bounds.update(packet);
  expect(bounds.sphere.containsPoint(deformReference(bake, packet, 0).position)).toBe(true);
});

it("preserves pinned donor motion matrices after repository formatting", async () => {
  const donorRoot = path.dirname(
    createRequire(import.meta.url).resolve("procedural-animals/package.json"),
  );
  const { createQuadrupedMotion } = await import(
    pathToFileURL(path.join(donorRoot, "src/core/motion/quadruped.js")).href
  );
  const { motion } = await import(
    pathToFileURL(path.join(donorRoot, "src/species/wolf/motion.js")).href
  );
  const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
  const options = { material: () => new MeshBasicMaterial(), ground: (x: number) => x * 0.1 };
  const adapted = createAnimalActor(bake, { ...options, motion: wolfMotion });
  const pinned = createAnimalActor(bake, {
    ...options,
    motion: (context) => createQuadrupedMotion({ ...context, species: { motion } }),
  });
  const position = new Vector3();
  const velocity = new Vector3();
  let maximumError = 0;
  try {
    for (let tick = 0; tick < 720; tick++) {
      if (tick === 360) {
        void adapted.play("sit");
        void pinned.play("sit");
      }
      if (tick === 540) {
        void adapted.play("lie");
        void pinned.play("lie");
      }
      velocity.set(tick >= 180 && tick < 300 ? 1 : 0, 0, tick < 180 ? 1.2 : 0);
      position.addScaledVector(velocity, 1 / 60);
      const state = { position, velocity, heading: tick >= 180 && tick < 300 ? Math.PI / 2 : 0 };
      adapted.follow(state, 1 / 60);
      pinned.follow(state, 1 / 60);
      for (let i = 0; i < adapted.pose.data.length; i++)
        maximumError = Math.max(
          maximumError,
          Math.abs((adapted.pose.data[i] ?? 0) - (pinned.pose.data[i] ?? 0)),
        );
    }
    expect(maximumError).toBeLessThanOrEqual(1e-6);
  } finally {
    adapted.dispose();
    pinned.dispose();
  }
}, 30_000);

it("remeasures edited instance geometry and resets a recomputed sphere centre", () => {
  const bake = parseAnimalBake(encodeFixture());
  const actor = createAnimalActor(bake, {
    material: () => new MeshBasicMaterial(),
    ground: () => 0,
    motion: () => ({
      input: { speed: 0, target: null, heading: 0, follow: null },
      update: () => undefined,
      reset: () => undefined,
      play: async () => "done",
      dispose: () => undefined,
    }),
  });
  try {
    actor.mesh.geometry.translate(5, 0, 0);
    const bone = actor.pose.skeleton.bones[0];
    if (!bone) throw new Error("missing control bone");
    bone.matrixWorld.makeRotationZ(Math.PI);
    actor.follow({ position: new Vector3(), velocity: new Vector3(), heading: 0 }, 1 / 60);
    const edited = {
      ...bake,
      pos: actor.mesh.geometry.getAttribute("position").array as Float32Array,
    };
    for (let vertex = 0; vertex < bake.nV; vertex++)
      expect(
        actor.bounds.sphere.containsPoint(
          deformReference(edited, actor.pose.data, vertex).position,
        ),
      ).toBe(true);
    expect(actor.bounds.sphere.center).toEqual(new Vector3());
  } finally {
    actor.dispose();
  }
});

it.each([
  { paused: true, dt: 1 / 60 },
  { paused: false, dt: 0 },
])(
  "refreshes edited bounds while keeping the frozen pose (paused=$paused, dt=$dt)",
  ({ paused, dt }) => {
    const bake = parseAnimalBake(encodeFixture());
    const actor = createAnimalActor(bake, {
      material: () => new MeshBasicMaterial(),
      ground: () => 0,
      motion: () => ({
        input: { speed: 0, target: null, heading: 0, follow: null },
        update: () => undefined,
        reset: () => undefined,
        play: async () => "done",
        dispose: () => undefined,
      }),
    });
    try {
      const state = { position: new Vector3(), velocity: new Vector3(), heading: 0 };
      const bone = actor.pose.skeleton.bones[0];
      if (!bone) throw new Error("missing control bone");
      bone.matrixWorld.makeRotationZ(Math.PI);
      actor.follow(state, 1 / 60);
      const packet = actor.pose.data.slice();
      const version = actor.pose.texture.version;
      actor.paused = paused;
      actor.mesh.geometry.translate(5, 0, 0);
      actor.follow(state, dt);
      const edited = {
        ...bake,
        pos: actor.mesh.geometry.getAttribute("position").array as Float32Array,
      };
      for (let vertex = 0; vertex < bake.nV; vertex++)
        expect(
          actor.bounds.sphere.containsPoint(deformReference(edited, packet, vertex).position),
        ).toBe(true);
      expect(actor.pose.data).toEqual(packet);
      expect(actor.pose.texture.version).toBe(version);
    } finally {
      actor.dispose();
    }
  },
);

it.each(["skinIndex", "skinWeight"])(
  "rejects normalized edited %s before trusting its raw bounds",
  (name) => {
    const bake = parseAnimalBake(encodeFixture());
    const geometry = geometryFromValidatedBake(bake);
    try {
      const bounds = createAnimalBounds(bake, geometry);
      geometry.getAttribute(name).normalized = true;
      expect(() => bounds.update(new Float32Array(bake.bones.length * 20))).toThrow(
        "TN_ANIMAL_BOUNDS",
      );
    } finally {
      geometry.dispose();
    }
  },
);
