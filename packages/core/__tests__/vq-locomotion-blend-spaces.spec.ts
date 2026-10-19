import { readFileSync } from "node:fs";
import type { AnimationClip, Object3D } from "three";
import { AnimationMixer, Bone, Group, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import {
  FIRST_PERSON_BODY_LOCOMOTION,
  type ILocomotionSettings,
  KAYKIT_DIRECTIONAL,
  THIRD_PERSON_LOCOMOTION,
  createLocomotionDriver,
} from "../../../examples/abyss-framework/src/render/locomotion-driver.js";
import {
  createDirectionWeights,
  createSpeedWeights,
} from "../../../examples/abyss-framework/src/render/locomotion-weights.js";
import { SkeletalMesh3D } from "../src/index.js";

vi.mock("@threenative/core", async () => import("../src/index.js"));

const speeds = [
  { clip: "Idle_Loop", speed: 0 },
  { clip: "Walk_Loop", speed: 1 },
  { clip: "Jog_Fwd_Loop", speed: 3 },
] as const;
const directions = [
  { clip: "a", point: [0, 0] },
  { clip: "b", point: [1, 0] },
  { clip: "c", point: [1, 1] },
  { clip: "d", point: [0, 1] },
] as const;
const triangles = [
  [0, 1, 2],
  [0, 2, 3],
] as const;
const weights = (entries: readonly { weight: number }[]) => entries.map((entry) => entry.weight);

function expectNormalized(entries: readonly { weight: number }[]) {
  expect(entries.every(({ weight }) => Number.isFinite(weight) && weight >= 0)).toBe(true);
  expect(entries.reduce((sum, { weight }) => sum + weight, 0)).toBeCloseTo(1, 6);
}

async function loadMannequin() {
  const bytes = readFileSync(
    new URL("../../create-threenative/template-assets/assets/mannequin.glb", import.meta.url),
  );
  return new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
}

const KAYKIT_ASSETS = new URL("../../../examples/abyss-framework/assets/", import.meta.url);

/** The three unmodified KayKit files, each parsed on its own so no clip is silently renamed. */
async function loadKayKit() {
  return Promise.all(
    ["general", "movement-basic", "movement-advanced"].map(async (name) => {
      const bytes = readFileSync(new URL(`kaykit-rig-medium-${name}.glb`, KAYKIT_ASSETS));
      return new GLTFLoader().parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        "",
      );
    }),
  );
}

/** One Rig_Medium scene with the clips of all three files, merged by their real names. */
function kayKitRig(models: Awaited<ReturnType<typeof loadKayKit>>) {
  const [general, basic, advanced] = models;
  if (general === undefined || basic === undefined || advanced === undefined)
    throw new Error("KayKit locomotion needs all three authored files.");
  // Only the clips this game asked for reach the player: each of the three files carries its own
  // T-Pose, and a repeated clip name is a load failure, not a silent overwrite.
  const required = new Set(clipsOf(KAYKIT_DIRECTIONAL));
  const animations = [...general.animations, ...basic.animations, ...advanced.animations].filter(
    (clip) => required.has(clip.name),
  );
  const names = animations.map((clip) => clip.name);
  expect(names).toHaveLength(required.size);
  expect(new Set(names)).toEqual(required);
  return { animations, scene: general.scene };
}

/** Every clip the driver can ask this settings object for, speed samples first. */
function clipsOf(settings: ILocomotionSettings): readonly string[] {
  const names = settings.speedSamples.map(({ clip }) => clip);
  for (const { clip } of settings.direction?.samples ?? [])
    if (!names.includes(clip)) names.push(clip);
  return names;
}

/** One real game consumer: the authored settings, the rig they author, and one driver. */
function consumer(
  settings: ILocomotionSettings,
  model: { scene: Object3D; animations: AnimationClip[] },
  parent?: Object3D,
) {
  const clips = clipsOf(settings);
  const player = new SkeletalMesh3D({
    source: model.scene,
    clips: model.animations,
    requiredClips: clips,
    strideSync: false,
  });
  parent?.add(player.root);
  const bones: Bone[] = [];
  player.root.traverse((node) => {
    if (node instanceof Bone) bones.push(node);
  });
  if (bones.length === 0) throw new Error("Mannequin locomotion requires actual animated bones.");
  const initial = bones.map((bone) => bone.quaternion.clone().normalize());
  const driver = createLocomotionDriver(settings, player);
  const actions = clips.map((clip) => player.mixer.clipAction(player.clip(clip)));
  const run = (speed: number, frames: number) => {
    for (let frame = 0; frame < frames; frame++) {
      driver.update(speed);
      player.update(1 / 60);
    }
  };
  return {
    actions,
    bones,
    clips,
    driver,
    player,
    settings,
    run,
    runDirection: (direction: readonly [number, number], frames: number) => {
      for (let frame = 0; frame < frames; frame++) {
        driver.update(0, direction);
        player.update(1 / 60);
      }
    },
    weights: () =>
      actions.map((action) => (action.isScheduled() ? action.getEffectiveWeight() : 0)),
    phases: () => actions.map((action) => action.time / action.getClip().duration),
    maxAnimatedRadians: () =>
      bones.reduce((largest, bone, index) => {
        const bind = initial[index];
        return bind === undefined
          ? largest
          : Math.max(largest, bone.quaternion.clone().normalize().angleTo(bind));
      }, 0),
    signature: () =>
      Number(
        bones.reduce((sum, bone) => sum + bone.quaternion.x + bone.quaternion.w, 0).toFixed(9),
      ),
  };
}

describe("game-owned speed evaluation", () => {
  it("interpolates sorted intervals and explicitly clamps both endpoints", () => {
    const evaluate = createSpeedWeights(speeds);
    expect(weights(evaluate(-1))).toEqual([1, 0, 0]);
    expect(weights(evaluate(0.5))).toEqual([0.5, 0.5, 0]);
    expect(weights(evaluate(1))).toEqual([0, 1, 0]);
    expect(weights(evaluate(2))).toEqual([0, 0.5, 0.5]);
    expect(weights(evaluate(4))).toEqual([0, 0, 1]);
    const trace = Array.from({ length: 81 }, (_, index) => index / 20 - 0.5);
    const replay = trace.map(evaluate);
    expect(trace.map(evaluate)).toEqual(replay);
    replay.forEach(expectNormalized);
  });

  it("supports a single authored fallback sample", () => {
    expect(createSpeedWeights([speeds[0]])(5)).toEqual([{ clip: "Idle_Loop", weight: 1 }]);
  });

  it("rejects empty, unsorted, duplicate and non-finite authored samples", () => {
    for (const samples of [
      [],
      [speeds[1], speeds[0]],
      [speeds[0], { clip: "other", speed: 0 }],
      [speeds[0], { clip: "Idle_Loop", speed: 1 }],
      [{ clip: "", speed: 0 }],
      [{ clip: "idle", speed: Number.NaN }],
      [{ clip: "idle", speed: Number.POSITIVE_INFINITY }],
    ])
      expect(() => createSpeedWeights(samples)).toThrow();
    const evaluate = createSpeedWeights(speeds);
    expect(() => evaluate(Number.NaN)).toThrow();
    expect(() => evaluate(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("freezes authored samples so later game edits cannot change an existing evaluator", () => {
    const samples = [
      { clip: "idle", speed: 0 },
      { clip: "walk", speed: 1 },
    ];
    const evaluate = createSpeedWeights(samples);
    const changed = samples[1];
    if (changed === undefined) throw new Error("Missing authored sample.");
    changed.speed = 4;
    expect(weights(evaluate(0.5))).toEqual([0.5, 0.5]);
  });
});

describe("game-owned declared directional domain", () => {
  it("uses barycentric weights at vertices, interiors and shared boundaries", () => {
    const evaluate = createDirectionWeights(directions, triangles);
    expect(weights(evaluate([1, 0]))).toEqual([0, 1, 0, 0]);
    expect(weights(evaluate([0.75, 0.25]))).toEqual([0.25, 0.5, 0.25, 0]);
    expect(weights(evaluate([0.25, 0.75]))).toEqual([0.25, 0, 0.25, 0.5]);
    expect(weights(evaluate([0.5, 0.5]))).toEqual([0.5, 0, 0.5, 0]);
  });

  it("projects outside points onto the nearest declared boundary, never extrapolates", () => {
    const evaluate = createDirectionWeights(directions, triangles);
    expect(weights(evaluate([2, 0.5]))).toEqual([0, 0.5, 0.5, 0]);
    expect(weights(evaluate([-1, -1]))).toEqual([1, 0, 0, 0]);
    expect(weights(evaluate([0.5, 2]))).toEqual([0, 0, 0.5, 0.5]);
    for (let x = -2; x <= 2; x += 0.125) {
      const point = [x, 0.3] as const;
      expect(evaluate(point)).toEqual(evaluate(point));
      expectNormalized(evaluate(point));
    }
  });

  it("rejects duplicate, degenerate, invalid and overlapping domains", () => {
    expect(() => createDirectionWeights([], [])).toThrow();
    expect(() => createDirectionWeights(directions, [])).toThrow();
    expect(() => createDirectionWeights(directions, [[0, 1, 9]])).toThrow();
    expect(() => createDirectionWeights(directions, [[0, 1, 1]])).toThrow();
    expect(() =>
      createDirectionWeights(directions, [
        [0, 1, 2],
        [0, 1, 3],
      ]),
    ).toThrow();
    expect(() =>
      createDirectionWeights(directions, [
        [0, 1, 2],
        [2, 1, 0],
      ]),
    ).toThrow();
    expect(() =>
      createDirectionWeights(
        [
          { clip: "a", point: [0, 0] },
          { clip: "b", point: [1, 0] },
          { clip: "c", point: [2, 0] },
        ],
        [[0, 1, 2]],
      ),
    ).toThrow();
    expect(() =>
      createDirectionWeights(
        [directions[0], { clip: "b", point: [0, 0] }, directions[2]],
        [[0, 1, 2]],
      ),
    ).toThrow();
    expect(() =>
      createDirectionWeights(
        [directions[0], { clip: "a", point: [1, 0] }, directions[2]],
        [[0, 1, 2]],
      ),
    ).toThrow();
    expect(() =>
      createDirectionWeights(
        [directions[0], directions[1], { clip: "c", point: [Number.NaN, 1] }],
        [[0, 1, 2]],
      ),
    ).toThrow();
    const evaluate = createDirectionWeights(directions, triangles);
    expect(() => evaluate([Number.POSITIVE_INFINITY, 0])).toThrow();
  });

  it("rejects malformed JSON coordinates and triangle tuples before evaluation", () => {
    for (const point of ["[0]", "[0,0,99]", "[null,0]"]) {
      const samples = JSON.parse(
        `[ {"clip":"a","point":${point}}, {"clip":"b","point":[1,0]}, {"clip":"c","point":[0,1]} ]`,
      );
      expect(() => createDirectionWeights(samples, [[0, 1, 2]])).toThrow();
    }
    for (const triangles of ["[[0,1]]", "[[0,1,2,99]]", "[[0,null,2]]"]) {
      expect(() => createDirectionWeights(directions.slice(0, 3), JSON.parse(triangles))).toThrow();
    }
  });

  it("rejects a contained triangle regardless of declaration order", () => {
    const samples = [
      { clip: "a", point: [0, 0] },
      { clip: "b", point: [4, 0] },
      { clip: "c", point: [0, 4] },
      { clip: "d", point: [1, 1] },
      { clip: "e", point: [2, 1] },
      { clip: "f", point: [1, 2] },
    ] as const;
    expect(() =>
      createDirectionWeights(samples, [
        [0, 1, 2],
        [3, 4, 5],
      ]),
    ).toThrow();
    expect(() =>
      createDirectionWeights(samples, [
        [3, 4, 5],
        [0, 1, 2],
      ]),
    ).toThrow();
  });

  it("accepts either authored triangle winding and snapshots the domain", () => {
    const samples = directions.map(({ clip, point }) => ({
      clip,
      point: [...point] as [number, number],
    }));
    const evaluate = createDirectionWeights(samples, [
      [2, 1, 0],
      [3, 2, 0],
    ]);
    const changed = samples[1];
    if (changed === undefined) throw new Error("Missing authored sample.");
    changed.point[0] = 100;
    expect(weights(evaluate([0.75, 0.25]))).toEqual([0.25, 0.5, 0.25, 0]);
  });
});

it("feeds actual mannequin speed weights through the repaired authoritative player", async () => {
  const model = await loadMannequin();
  const player = new SkeletalMesh3D({
    source: model.scene,
    clips: model.animations,
    requiredClips: speeds.map(({ clip }) => clip),
    strideSync: false,
  });
  const bones: Bone[] = [];
  player.root.traverse((node) => {
    if (node instanceof Bone) bones.push(node);
  });
  expect(bones.length).toBeGreaterThan(60);
  const evaluate = createSpeedWeights(speeds);
  player.playWeighted(evaluate(0));
  for (const speed of [0.5, 1, 2, 3, 1, 0.5, 0]) {
    const actions = speeds.map(({ clip }) => player.mixer.clipAction(player.clip(clip)));
    const liveTimes = actions.map((action) =>
      action.isScheduled() && action.getEffectiveWeight() > 0 ? action.time : undefined,
    );
    player.update(0);
    const pose = bones.map((bone) => ({
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone().normalize(),
    }));
    player.playWeighted(evaluate(speed), { transition: 0.25 });
    player.update(0);
    bones.forEach((bone, index) => {
      const before = pose[index];
      if (before === undefined) throw new Error("Missing sampled bone.");
      expect(bone.position.distanceTo(before.position)).toBeLessThan(1e-6);
      expect(bone.quaternion.clone().normalize().angleTo(before.quaternion)).toBeLessThan(1e-6);
    });
    actions.forEach((action, index) => {
      if (liveTimes[index] !== undefined) expect(action.time).toBe(liveTimes[index]);
    });
    for (let frame = 0; frame < 4; frame++) {
      player.playWeighted(evaluate(speed), { transition: 0.25 });
      player.update(0.0625);
      expectNormalized(
        actions.map((action) => ({
          weight: action.isScheduled() ? action.getEffectiveWeight() : 0,
        })),
      );
      expect(actions.every((action) => Number.isFinite(action.time))).toBe(true);
    }
    weights(evaluate(speed)).forEach((weight, index) =>
      expect(actions[index]?.isScheduled() ? actions[index]?.getEffectiveWeight() : 0).toBeCloseTo(
        weight,
        6,
      ),
    );
  }
  expect(player.mixer.stats.actions.inUse).toBe(1);
  player.dispose();
  expect(player.mixer.stats.actions.total).toBe(0);
});

const CONSUMERS = [THIRD_PERSON_LOCOMOTION, FIRST_PERSON_BODY_LOCOMOTION] as const;
const SWEEP = [0, 0.6, 1.6, 3, 5.5, 6, 0] as const;

/** The authored domain, read once so a settings edit cannot quietly change the evaluator under it. */
function kaykitDirection() {
  const direction = KAYKIT_DIRECTIONAL.direction;
  if (direction === undefined)
    throw new Error("KAYKIT_DIRECTIONAL must author a directional domain.");
  return direction;
}

function kaykitEvaluator() {
  const { samples, triangles } = kaykitDirection();
  return createDirectionWeights(samples, triangles);
}

function dominant(entries: readonly { clip: string; weight: number }[]) {
  const best = entries.reduce((top, entry) => (entry.weight > top.weight ? entry : top));
  if (!Number.isFinite(best.weight)) throw new Error("Directional weights were not finite.");
  return best;
}

/** The five authored sample points in declaration order, x right and y forward. */
const KAYKIT_POINTS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
] as const;

describe("the authored KayKit directional domain on real clips", () => {
  it("puts every real clip on its own authored point, at full weight and named for that direction", () => {
    const evaluate = kaykitEvaluator();
    const expected = [
      "Idle_A",
      "Running_A",
      "Running_Strafe_Right",
      "Walking_Backwards",
      "Running_Strafe_Left",
    ];
    for (const [index, point] of KAYKIT_POINTS.entries()) {
      const entries = evaluate(point);
      expectNormalized(entries);
      const best = dominant(entries);
      expect(best.clip).toBe(expected[index]);
      expect(best.weight).toBe(1);
    }
  });

  it("blends the two real clips a diagonal shares and no third", () => {
    const evaluate = kaykitEvaluator();
    expect(weights(evaluate([0.5, 0.5]))).toEqual([0, 0.5, 0.5, 0, 0]);
    expect(weights(evaluate([-0.5, -0.5]))).toEqual([0, 0, 0, 0.5, 0.5]);
    expect(weights(evaluate([0.5, -0.5]))).toEqual([0, 0, 0.5, 0.5, 0]);
    expect(weights(evaluate([-0.5, 0.5]))).toEqual([0, 0.5, 0, 0, 0.5]);
    for (const point of [
      [0.5, 0.5],
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
    ] as const)
      expect(evaluate(point).map(({ weight }) => weight)).toEqual(
        evaluate(point).map(({ weight }) => weight),
      );
  });

  it("projects an out-of-domain request onto the nearest real clip, never past it", () => {
    const evaluate = kaykitEvaluator();
    expect(dominant(evaluate([2, 0]))).toEqual({ clip: "Running_Strafe_Right", weight: 1 });
    expect(dominant(evaluate([0, 2]))).toEqual({ clip: "Running_A", weight: 1 });
    expect(dominant(evaluate([-2, 0]))).toEqual({ clip: "Running_Strafe_Left", weight: 1 });
    expect(dominant(evaluate([0, -2]))).toEqual({ clip: "Walking_Backwards", weight: 1 });
    expect(weights(evaluate([1.4, 1.4]))).toEqual([0, 0.5, 0.5, 0, 0]);
    for (let x = -2; x <= 2; x += 0.125) {
      const point = [x, 0.35] as const;
      expect(evaluate(point)).toEqual(evaluate(point));
      expectNormalized(evaluate(point));
    }
  });

  it("keeps every declared triangle of the four real quadrant fans usable and non-overlapping", () => {
    const { triangles } = kaykitDirection();
    expect(triangles).toEqual([
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 1],
    ]);
    const evaluate = kaykitEvaluator();
    for (const [index, point] of KAYKIT_POINTS.entries()) {
      const weight = dominant(evaluate(point)).weight;
      expect(weight).toBe(1);
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it("replays a rapid right/left/forward/back reversal on the real clips to the same pose", async () => {
    const model = kayKitRig(await loadKayKit());
    const REVERSALS = [
      [[1, 0], 20],
      [[-1, 0], 1],
      [[1, 0], 1],
      [[0, 1], 1],
      [[0, -1], 1],
      [[0, 1], 1],
      [[-1, 0], 1],
      [[0, 0], 12],
    ] as const;
    const trace = () => {
      const rig = consumer(KAYKIT_DIRECTIONAL, model, new Group());
      const rows: unknown[] = [];
      for (const [direction, ticks] of REVERSALS) {
        rig.runDirection(direction, ticks);
        rows.push({
          active: rig.player.mixer.stats.actions.inUse,
          phases: rig.phases(),
          pose: rig.signature(),
          weights: rig.weights(),
        });
      }
      rig.player.dispose();
      return rows;
    };
    const first = trace();
    expect(first).toEqual(trace());
    // A one-tick reversal cannot cross a 0.2 s weight ramp, so the old direction is still dominant:
    // that lag is the gait, and a snap would mean the driver ignored the transition it was given.
    const rig = consumer(KAYKIT_DIRECTIONAL, model, new Group());
    rig.runDirection([1, 0], 20);
    const held = rig.weights();
    rig.runDirection([-1, 0], 1);
    const reversed = rig.weights();
    const clipOf = (values: readonly number[]) =>
      rig.clips[values.indexOf(Math.max(...values))] ?? "";
    expect(clipOf(held)).toBe("Running_Strafe_Right");
    expect(clipOf(reversed)).toBe("Running_Strafe_Right");
    expect(reversed.reduce((total, weight) => total + weight, 0)).toBeCloseTo(1, 6);
    rig.player.dispose();
  });
});

/** Sampled from the real Rig_Medium: the forward-most foot.l phase, and how far that foot travels. */
async function measuredGaitPhases() {
  const { animations, scene } = kayKitRig(await loadKayKit());
  const STEPS = 1000;
  const measured: Record<string, { phase: number; toeTravel: number }> = {};
  for (const name of [
    "Idle_A",
    "Running_A",
    "Walking_A",
    "Running_Strafe_Right",
    "Running_Strafe_Left",
    "Walking_Backwards",
  ]) {
    const clip = animations.find((candidate) => candidate.name === name);
    if (clip === undefined) throw new Error(`KayKit locomotion needs the authored clip '${name}'.`);
    const root = scene.clone(true);
    const bones = new Map<string, Bone>();
    root.traverse((node) => {
      if (node instanceof Bone) bones.set(node.name, node);
    });
    const hips = bones.get("hips");
    const toes = bones.get("toesl");
    const ankles = bones.get("footl");
    if (hips === undefined || toes === undefined || ankles === undefined)
      throw new Error("Rig_Medium needs hips, footl and toesl to measure a gait.");
    const mixer = new AnimationMixer(root);
    mixer.clipAction(clip).play();
    const at = new Vector3();
    const forward = new Vector3();
    let peak = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let peakAt = 0;
    for (let step = 0; step < STEPS; step++) {
      mixer.setTime((step / STEPS) * clip.duration);
      root.updateMatrixWorld(true);
      toes.getWorldPosition(at);
      hips.worldToLocal(at);
      // The first sample fixes which way this rig's foot points, so the marker never assumes it.
      if (step === 0) {
        ankles.getWorldPosition(forward);
        hips.worldToLocal(forward);
        expect(at.z - forward.z).toBeGreaterThan(0);
      }
      if (at.z > peak) {
        peak = at.z;
        peakAt = step / STEPS;
      }
      if (at.z < low) low = at.z;
    }
    measured[name] = { phase: peakAt, toeTravel: peak - low };
  }
  return measured;
}

const phaseGap = (a: number, b: number) => {
  const difference = Math.abs(a - b);
  return Math.min(difference, 1 - difference);
};

describe("the measured KayKit gait, which is the only reason phaseSync may be on", () => {
  it("lines every directional clip's forward-most foot up with Running_A inside the stated tolerance", async () => {
    const measured = await measuredGaitPhases();
    const reference = measured.Running_A;
    if (reference === undefined) throw new Error("Running_A is the phase reference clip.");
    for (const name of [
      "Walking_A",
      "Running_Strafe_Right",
      "Running_Strafe_Left",
      "Walking_Backwards",
    ]) {
      const mark = measured[name];
      if (mark === undefined) throw new Error(`Missing measured gait for '${name}'.`);
      expect(mark.toeTravel).toBeGreaterThan(0.3);
      expect(phaseGap(mark.phase, reference.phase)).toBeLessThanOrEqual(0.05);
    }
    // The idle has no stride to join: its own foot travel is noise, which is why the tolerance is
    // claimed for the clips that step and not for the one that stands.
    expect(measured.Idle_A?.toeTravel ?? 1).toBeLessThan(0.01);
    expect(KAYKIT_DIRECTIONAL.phaseSync).toBe(true);
  });
});

describe("two game-owned consumers on the real mannequin", () => {
  it("holds weights summing to one within 1e-6 and animates real bones over the speed domain", async () => {
    const model = await loadMannequin();
    for (const settings of CONSUMERS) {
      const rig = consumer(settings, model, new Group());
      expect(rig.bones.length).toBeGreaterThan(60);
      let animated = 0;
      for (const speed of SWEEP) {
        rig.run(speed, 20);
        const sum = rig.weights().reduce((total, weight) => total + weight, 0);
        expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
        expect(rig.player.mixer.stats.actions.inUse).toBeLessThanOrEqual(rig.actions.length);
        createSpeedWeights(rig.settings.speedSamples)(speed).forEach(({ weight }, index) =>
          expect(rig.weights()[index]).toBeCloseTo(weight, 6),
        );
        animated = Math.max(animated, rig.maxAnimatedRadians());
      }
      expect(animated).toBeGreaterThan(0.05);
      rig.player.dispose();
    }
  });

  it("joins an entering clip to the dominant phase when sync is on and stays independent when it is off", async () => {
    const model = await loadMannequin();
    const synced = consumer(THIRD_PERSON_LOCOMOTION, model);
    const independent = consumer(FIRST_PERSON_BODY_LOCOMOTION, model, new Group());
    for (const rig of [synced, independent]) {
      const walk = rig.settings.speedSamples[1];
      const jog = rig.settings.speedSamples[2];
      if (walk === undefined || jog === undefined)
        throw new Error("Both consumers author a walk and a jog sample.");
      rig.run(walk.speed, 20);
      const walkPhase = rig.phases()[1] ?? 0;
      expect(walkPhase).toBeGreaterThan(0.05);
      rig.driver.update((walk.speed + jog.speed) / 2);
      rig.player.update(0);
      const jogPhase = rig.phases()[2] ?? Number.NaN;
      const gap = Math.abs(jogPhase - walkPhase);
      if (rig.settings.phaseSync === false) expect(gap).toBeGreaterThan(0.05);
      else expect(gap).toBeLessThan(1e-6);
      rig.player.dispose();
    }
  });

  it("fails closed on a direction when the game authored no directional clips", async () => {
    const model = await loadMannequin();
    const rig = consumer(THIRD_PERSON_LOCOMOTION, model);
    rig.run(0, 1);
    const held = rig.weights();
    expect(() => rig.driver.update(1.2, [0, 1])).toThrow();
    expect(rig.weights()).toEqual(held);
    rig.player.dispose();
  });

  it("evaluates a game-authored forward direction domain on real clips", async () => {
    const model = await loadMannequin();
    const rig = consumer(
      {
        ...THIRD_PERSON_LOCOMOTION,
        direction: {
          samples: [
            { clip: "Idle_Loop", point: [0, 0] },
            { clip: "Walk_Loop", point: [1, 0] },
            { clip: "Jog_Fwd_Loop", point: [1, 1] },
          ],
          triangles: [[0, 1, 2]],
        },
      },
      model,
    );
    rig.driver.update(0, [1, 1]);
    rig.player.update(0);
    expect(rig.weights().map((weight) => Number(weight.toFixed(6)))).toEqual([0, 0, 1, 0]);
    rig.driver.update(0, [0.5, 0.5]);
    for (let frame = 0; frame < 20; frame++) rig.player.update(1 / 60);
    expect(rig.weights().map((weight) => Number(weight.toFixed(6)))).toEqual([0.5, 0, 0.5, 0]);
    rig.player.dispose();
  });

  it("replays an identical trace on fresh consumers to the same weights, phases and bone pose", async () => {
    const model = await loadMannequin();
    const trace = (settings: ILocomotionSettings) => {
      const rig = consumer(settings, model, new Group());
      const rows: unknown[] = [];
      for (const speed of [0, 1.2, 2.4, 5.5, 0.8, 0]) {
        rig.run(speed, 12);
        rows.push({
          active: rig.player.mixer.stats.actions.inUse,
          phases: rig.phases(),
          pose: rig.signature(),
          weights: rig.weights(),
        });
      }
      rig.player.dispose();
      return rows;
    };
    expect(trace(THIRD_PERSON_LOCOMOTION)).toEqual(trace(THIRD_PERSON_LOCOMOTION));
    expect(trace(FIRST_PERSON_BODY_LOCOMOTION)).toEqual(trace(FIRST_PERSON_BODY_LOCOMOTION));
  });

  it("bounds active actions and releases every action on disposal", async () => {
    const model = await loadMannequin();
    for (const settings of CONSUMERS) {
      const rig = consumer(settings, model, new Group());
      for (const speed of [4, 2, 0.5, 0]) {
        rig.run(speed, 20);
        expect(rig.player.mixer.stats.actions.inUse).toBeLessThanOrEqual(2);
      }
      expect(rig.player.mixer.stats.actions.inUse).toBe(1);
      rig.player.dispose();
      expect(rig.player.mixer.stats.actions.total).toBe(0);
    }
  });
});
