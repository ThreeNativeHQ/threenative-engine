/**
 * Records the pinned three's animation answers as C++ tables the native tests compare against
 * (PRD-516 phase 1). Inputs and answers are bit patterns, so the comparisons are exact.
 *
 * - interpolants_reference.inc: every case is a real keyframe track, `createInterpolant()` and a
 *   sequence of `evaluate(t)` calls that seeks forward, backward, past both ends and through NaN
 *   and the infinities.
 * - property_binding_reference.inc: `PropertyBinding.parseTrackName` over three's own test names
 *   and edge cases, and a binding scenario (bind, reparent, leave the root, rebind, a shadowing
 *   name) recorded as each node's transform and each binding's `getValue` after every step. The
 *   native test runs the same scenario, step for step.
 *
 *   pnpm --workspace-root exec tsx packages/three-native/tests/animation/animation-reference.ts
 *   ... -- --check   (fails when a committed table is not what this three produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, pinnedThreeVersion } from "../../src/fixture-format.js";

const OUT_DIR = path.join(REPO_ROOT, "packages/runtime-native/tests/native-engine/animation");

const version = pinnedThreeVersion(REPO_ROOT);
const entry = createRequire(path.join(REPO_ROOT, "packages/core/package.json")).resolve("three");
const three = await import(pathToFileURL(entry).href);
const actual = JSON.parse(
  readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8"),
) as {
  version: string;
};
if (actual.version !== version)
  throw new Error(
    `TN_FIXTURE_THREE_MISMATCH: resolved three ${actual.version}, the pin is ${version}`,
  );

const f32 = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0] as number;
const f64 = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const hex32 = (bits: number) => `0x${bits.toString(16).padStart(8, "0")}u`;
const hex64 = (bits: bigint) => `0x${bits.toString(16).padStart(16, "0")}ull`;

// A deterministic walk over [-0.6, 3.1] that seeks in both directions, then the special values.
let seed = 0x2f6b9a1d;
const walk = Array.from({ length: 48 }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return -0.6 + (seed / 2 ** 32) * 3.7;
});
const SAMPLES = [
  -1,
  0,
  0.1,
  0.3,
  0.29,
  1,
  2.4,
  2.5,
  3,
  1.2,
  0.05,
  -0.5,
  1.69,
  1.7,
  0.31,
  2,
  ...walk,
];
const SPECIAL = [Number.NaN, 1.3, Number.POSITIVE_INFINITY, 0.7, Number.NEGATIVE_INFINITY, 2.2, -0];

const TIMES = [0, 0.3, 1, 1.7, 2.5];
const quaternions = (() => {
  const Q = three.Quaternion;
  const keys = [
    new Q(),
    new Q().setFromAxisAngle(new three.Vector3(0, 1, 0), 1.2),
    // Negative dot with the previous key: the slerp takes the short way round.
    new Q(-0.6, -0.2, -0.1, -0.77).normalize(),
    // Almost the same as the previous key: the normalised-lerp branch (dot >= 0.9995).
    new Q(-0.601, -0.2, -0.1, -0.769).normalize(),
    // Identical to the previous key: the copy branch.
    new Q(-0.601, -0.2, -0.1, -0.769).normalize(),
  ];
  return keys.flatMap((k) => [k.x, k.y, k.z, k.w]);
})();

interface ITrack {
  times: Float32Array;
  values: Float32Array;
  getValueSize(): number;
  createInterpolant(): { evaluate(t: number): Float32Array; settings: unknown };
}

interface ICase {
  name: string;
  track: () => ITrack;
  kind: "Discrete" | "Linear" | "Smooth" | "QuaternionLinear";
  endings?: [number, number];
}

const ENDINGS: Record<number, string> = {
  [three.ZeroCurvatureEnding]: "ZeroCurvature",
  [three.ZeroSlopeEnding]: "ZeroSlope",
  [three.WrapAroundEnding]: "WrapAround",
};
const scalar = (mode: number) => () =>
  new three.NumberKeyframeTrack(".x", TIMES, [1, -2, 0.5, 4, 3], mode);
const vector = (mode: number) => () =>
  new three.VectorKeyframeTrack(
    ".position",
    TIMES,
    [0, 1, 2, 0.25, -1.5, 3.75, 2, 2, -0.125, 1e-3, 7.5, -4, 1 / 3, 2 / 3, 0.1],
    mode,
  );

const cases: ICase[] = [
  { name: "discrete scalar", track: scalar(three.InterpolateDiscrete), kind: "Discrete" },
  { name: "discrete vec3", track: vector(three.InterpolateDiscrete), kind: "Discrete" },
  { name: "linear scalar", track: scalar(three.InterpolateLinear), kind: "Linear" },
  { name: "linear vec3", track: vector(three.InterpolateLinear), kind: "Linear" },
  {
    name: "single key linear",
    track: () => new three.NumberKeyframeTrack(".x", [1], [5]),
    kind: "Linear",
  },
  {
    name: "quaternion linear",
    track: () => new three.QuaternionKeyframeTrack(".quaternion", TIMES, quaternions),
    kind: "QuaternionLinear",
  },
  {
    name: "quaternion discrete",
    track: () =>
      new three.QuaternionKeyframeTrack(
        ".quaternion",
        TIMES,
        quaternions,
        three.InterpolateDiscrete,
      ),
    kind: "Discrete",
  },
];
for (const start of [three.ZeroCurvatureEnding, three.ZeroSlopeEnding, three.WrapAroundEnding])
  for (const end of [three.ZeroCurvatureEnding, three.ZeroSlopeEnding, three.WrapAroundEnding])
    for (const [label, track] of [
      ["scalar", scalar(three.InterpolateSmooth)],
      ["vec3", vector(three.InterpolateSmooth)],
    ] as const)
      cases.push({
        name: `smooth ${label} ${ENDINGS[start]}/${ENDINGS[end]}`,
        track,
        kind: "Smooth",
        endings: [start, end],
      });

const lines = [
  `// Generated by packages/three-native/tests/animation/animation-reference.ts from three@${version}.`,
  "// Do not edit: rerun the generator. Times and values are float32 bits, samples float64 bits,",
  "// results the float32 bits three's Float32Array result buffer held after each evaluate().",
];
const samples = [...SAMPLES, ...SPECIAL];
lines.push(`static const uint64_t kSamples[] = {${samples.map((t) => hex64(f64(t))).join(", ")}};`);
for (const [index, c] of cases.entries()) {
  const track = c.track();
  const interpolant = track.createInterpolant();
  if (c.endings) interpolant.settings = { endingStart: c.endings[0], endingEnd: c.endings[1] };
  const results = samples.flatMap((t) => [...interpolant.evaluate(t)].map(f32));
  lines.push(
    `static const uint32_t kTimes${index}[] = {${[...track.times].map(f32).map(hex32).join(", ")}};`,
    `static const uint32_t kValues${index}[] = {${[...track.values].map(f32).map(hex32).join(", ")}};`,
    `static const uint32_t kResults${index}[] = {${results.map(hex32).join(", ")}};`,
  );
}
lines.push("static const InterpolantCase kCases[] = {");
for (const [index, c] of cases.entries()) {
  const valueSize = c.track().getValueSize();
  const endings = c.endings
    ? `Ending::${ENDINGS[c.endings[0]]}, Ending::${ENDINGS[c.endings[1]]}`
    : "Ending::ZeroCurvature, Ending::ZeroCurvature";
  lines.push(
    `    {"${c.name}", Interpolation::${c.kind}, ${endings}, ${valueSize}, kTimes${index}, std::size(kTimes${index}), kValues${index}, std::size(kValues${index}), kResults${index}},`,
  );
}
lines.push("};", "");

// ---- PropertyBinding
const PARSE_NAMES = [
  // three@0.185.1 test/unit/src/animation/PropertyBinding.tests.js
  ".property",
  "nodeName.property",
  "a.material.opacity",
  "uuid.objectName[objectIndex].propertyName[propertyIndex]",
  "parentName/nodeName.property",
  "parentName/no.de.Name.property",
  "parentName/parentName/nodeName.property[index]",
  ".bone[Armature.DEF_cog].position",
  "scene:helium_balloon_model:helium_balloon_model.position",
  "test.bones[hip].rotation[x]",
  "scene:helium_balloon_model:helium_balloon_model.position[x]",
  // edges
  "arm.L.quaternion",
  "hand.material[1].opacity",
  "node.map.offset",
  "node.materials.color",
  "a.b.c.d",
  "日本.position",
  "a b.position[y]",
  "",
  ".",
  "noProperty",
  "[bad].x",
  "a.b[",
  "a/.x",
  "dir:node.prop[[x]]",
];
const show = (value: string | undefined) => (value === undefined ? "~" : value);
const parseLines = PARSE_NAMES.map((name) => {
  try {
    const p = three.PropertyBinding.parseTrackName(name);
    return `node=${show(p.nodeName)};object=${show(p.objectName)};objectIndex=${show(p.objectIndex)};property=${show(p.propertyName)};propertyIndex=${show(p.propertyIndex)}`;
  } catch {
    return "throws";
  }
});
const cString = (s: string) => JSON.stringify(s);

const bits = (x: number) => f64(x).toString(16).padStart(16, "0");
const SENTINEL = 12345.5;
const TRACKS: Array<[string, number]> = [
  [".position", 3],
  ["hand.position", 3],
  ["arm.L.quaternion", 4],
  ["hand.scale[y]", 1],
  ["armB/hand.visible", 1],
  ["missing.position", 3],
  ["hand.material.opacity", 1],
  ["hand.foo", 1],
];
// What a boolean track writes: three stores the raw number, and a boolean track only gives 0 or 1.
const VISIBLE = [0, 0, 1, 0, 1, 0, 1, 0];
const named = (name: string) => Object.assign(new three.Object3D(), { name });
const root = named("root");
const armA = named("armA");
const armL = named("arm.L");
const armB = named("armB");
const hand = named("hand");
const hand2 = named("hand");
const outside = named("outside");
root.add(armA, armB);
armA.add(armL);
armB.add(hand);
const NODES = [root, armA, armL, armB, hand, hand2, outside];
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};
const bindings = TRACKS.map(([track]) => new three.PropertyBinding(root, track));
const rebind = () => {
  for (const b of bindings) b.unbind();
  for (const b of bindings) b.bind();
};
const setAll = (step: number) =>
  bindings.forEach((b, i) => {
    const size = (TRACKS[i] as [string, number])[1];
    const buffer = new Float64Array(4);
    for (let c = 0; c < size; ++c) buffer[c] = step * 10 + i + c * 0.25;
    if (i === 4) buffer[0] = VISIBLE[step] as number;
    b.setValue(buffer, 0);
  });
const vec = (v: { toArray(): number[] }) => v.toArray().map(bits).join(",");
const observe = (label: string) => {
  const nodes = NODES.map(
    (o) =>
      `${o.name}:p=${vec(o.position)};q=${vec(o.quaternion)};s=${vec(o.scale)};v=${o.visible ? 1 : 0};m=${o.matrixWorldNeedsUpdate ? 1 : 0}`,
  );
  const values = bindings.map((b, i) => {
    const buffer = new Float64Array(4).fill(SENTINEL);
    b.getValue(buffer, 0);
    return `b${i}=${[...buffer.subarray(0, (TRACKS[i] as [string, number])[1])].map(bits).join(",")}`;
  });
  return [label, ...nodes, ...values].join("|");
};
const steps: string[] = [];
for (const b of bindings) b.bind();
setAll(1);
steps.push(observe("bind"));
armA.add(hand);
setAll(2);
steps.push(observe("reparent-within-root"));
outside.add(hand);
setAll(3);
steps.push(observe("leave-root-still-bound"));
rebind();
setAll(4);
steps.push(observe("rebind-outside-root"));
armB.add(hand);
rebind();
setAll(5);
steps.push(observe("return-and-rebind"));
armA.add(hand2);
rebind();
setAll(6);
steps.push(observe("shadowing-name-first-in-depth-order"));
armA.remove(hand2);
setAll(7);
steps.push(observe("removed-node-stays-bound"));
console.warn = quiet.warn;
console.error = quiet.error;

const bindingLines = [
  `// Generated by packages/three-native/tests/animation/animation-reference.ts from three@${version}.`,
  "// Do not edit: rerun the generator. Doubles are their 16 hex digits of bits; ~ is undefined.",
  `static const double kSentinel = ${SENTINEL};`,
  "static const char* const kParse[][2] = {",
  ...PARSE_NAMES.map((name, i) => `    {${cString(name)}, ${cString(parseLines[i] as string)}},`),
  "};",
  "static const char* const kSteps[] = {",
  ...steps.map((step) => `    ${cString(step)},`),
  "};",
  "",
];

// ---- AnimationMixer: clips and a timeline of operations, both data, replayed by the native test
type TrackKind = "vector" | "quaternion" | "number" | "color" | "bool";
interface ITrackSpec {
  name: string;
  kind: TrackKind;
  interpolation: "Discrete" | "Linear" | "Smooth";
  times: number[];
  values: number[];
}
interface IClipSpec {
  name: string;
  duration: number;
  additive: boolean;
  tracks: ITrackSpec[];
}
const axisAngle = (x: number, y: number, z: number, angle: number) => {
  const q = new three.Quaternion().setFromAxisAngle(new three.Vector3(x, y, z).normalize(), angle);
  return [q.x, q.y, q.z, q.w];
};
const CLIPS: IClipSpec[] = [
  {
    name: "idle",
    duration: -1,
    additive: false,
    tracks: [
      {
        name: "hips.position",
        kind: "vector",
        interpolation: "Linear",
        times: [0, 0.5, 1, 1.5, 2],
        values: [0, 1, 0, 0, 1.05, 0.02, 0, 1, 0, 0, 0.97, -0.02, 0, 1, 0],
      },
      {
        name: "spine.quaternion",
        kind: "quaternion",
        interpolation: "Linear",
        times: [0, 0.7, 1.4, 2],
        values: [
          ...axisAngle(1, 0, 0, 0),
          ...axisAngle(1, 0, 0, 0.1),
          ...axisAngle(1, 0.2, 0, -0.08),
          ...axisAngle(1, 0, 0, 0),
        ],
      },
      {
        name: "head.scale",
        kind: "vector",
        interpolation: "Smooth",
        times: [0, 0.4, 1.1, 2],
        values: [1, 1, 1, 1.02, 0.99, 1, 0.97, 1.03, 1, 1, 1, 1],
      },
    ],
  },
  {
    name: "walk",
    duration: 1.2,
    additive: false,
    tracks: [
      {
        name: "hips.position",
        kind: "vector",
        interpolation: "Smooth",
        times: [0, 0.3, 0.6, 0.9, 1.2],
        values: [0, 1, 0, 0.1, 1.08, 0.3, 0, 1, 0.6, -0.1, 1.08, 0.9, 0, 1, 1.2],
      },
      {
        name: "spine.quaternion",
        kind: "quaternion",
        interpolation: "Linear",
        times: [0, 0.6, 1.2],
        values: [
          ...axisAngle(0, 1, 0, 0.2),
          ...axisAngle(0, 1, 0, -0.2),
          ...axisAngle(0, 1, 0, 0.2),
        ],
      },
      {
        name: "prop.position",
        kind: "vector",
        interpolation: "Discrete",
        times: [0, 0.4, 0.8],
        values: [1, 0, 0, 1.5, 0.2, 0, 1, 0.4, 0],
      },
    ],
  },
  {
    name: "wave",
    duration: 0.8,
    additive: false,
    tracks: [
      {
        name: "head.quaternion",
        kind: "quaternion",
        interpolation: "Linear",
        times: [0, 0.4, 0.8],
        values: [
          ...axisAngle(0, 0, 1, -0.3),
          ...axisAngle(0, 0, 1, 0.3),
          ...axisAngle(0, 0, 1, -0.3),
        ],
      },
    ],
  },
  {
    name: "lean",
    duration: -1,
    additive: true,
    tracks: [
      {
        name: "spine.quaternion",
        kind: "quaternion",
        interpolation: "Linear",
        times: [0, 1],
        values: [...axisAngle(0, 0, 1, 0), ...axisAngle(0, 0, 1, 0.25)],
      },
      {
        name: "hips.position",
        kind: "vector",
        interpolation: "Linear",
        times: [0, 1],
        values: [0, 0, 0, 0.2, -0.05, 0],
      },
    ],
  },
  {
    name: "jump",
    duration: -1,
    additive: false,
    tracks: [
      {
        name: "hips.position",
        kind: "vector",
        interpolation: "Smooth",
        times: [0, 0.25, 0.5, 0.75],
        values: [0, 1, 0, 0, 1.6, 0, 0, 1.9, 0, 0, 1, 0],
      },
    ],
  },
  {
    name: "spin",
    duration: -1,
    additive: false,
    tracks: [
      {
        name: "prop.quaternion",
        kind: "quaternion",
        interpolation: "Linear",
        times: [0, 0.3, 0.6],
        values: [...axisAngle(0, 1, 0, 0), ...axisAngle(0, 1, 0, 2), ...axisAngle(0, 1, 0, 4)],
      },
      {
        name: "prop.scale",
        kind: "vector",
        interpolation: "Linear",
        times: [0, 0.6],
        values: [1, 1, 1, 2, 0.5, 1],
      },
    ],
  },
];
// [frame, op, action, a, b, c]: applied before that frame's update. Actions index CLIPS. An
// uncached action is never played again: three 0.185.1's _removeInactiveBinding leaves the
// binding's _cacheIndex set, so that play() throws in _lendBinding.
type Op = [number, string, number, number, number, number];
const OPS: Op[] = [
  [0, "play", 0, 0, 0, 0],
  [60, "play", 1, 0, 0, 0],
  [60, "crossFadeFrom", 1, 0, 0.5, 1],
  [120, "setLoop", 2, 2, Number.POSITIVE_INFINITY, 0],
  [120, "weight", 2, 0.4, 0, 0],
  [120, "play", 2, 0, 0, 0],
  [150, "weight", 3, 0.7, 0, 0],
  [150, "fadeIn", 3, 0.3, 0, 0],
  [150, "play", 3, 0, 0, 0],
  [180, "setLoop", 4, 0, 1, 0],
  [180, "clamp", 4, 1, 0, 0],
  [180, "play", 4, 0, 0, 0],
  [210, "setLoop", 5, 1, 2, 0],
  [210, "timeScale", 5, 1.5, 0, 0],
  [210, "play", 5, 0, 0, 0],
  [240, "halt", 1, 0.5, 0, 0],
  [270, "mixerTimeScale", 0, -0.5, 0, 0],
  [330, "mixerTimeScale", 0, 1, 0, 0],
  [360, "reset", 0, 0, 0, 0],
  [360, "play", 0, 0, 0, 0],
  [360, "fadeIn", 0, 0.25, 0, 0],
  [360, "fadeOut", 1, 0.25, 0, 0],
  [390, "stop", 4, 0, 0, 0],
  [420, "setEffectiveWeight", 2, 0, 0, 0],
  [420, "zeroSlope", 0, 0, 1, 0],
  [450, "stop", 3, 0, 0, 0],
  [450, "startAt", 3, 0.4, 0, 0],
  [450, "play", 3, 0, 0, 0],
  [480, "uncacheAction", 5, 0, 0, 0],
  [500, "mixerSetTime", 0, 3.3, 0, 0],
  [510, "setEffectiveTimeScale", 0, 2, 0, 0],
  [520, "warp", 0, 2, 0.5, 0.4],
  [540, "stop", 1, 0, 0, 0],
  [540, "setDuration", 1, 2, 0, 0],
  [540, "play", 1, 0, 0, 0],
  [555, "syncWith", 2, 1, 0, 0],
  [570, "stopAll", 0, 0, 0, 0],
  [585, "play", 0, 0, 0, 0],
  [585, "crossFadeTo", 0, 2, 0.3, 0],
];
const LOOPS = [three.LoopOnce, three.LoopRepeat, three.LoopPingPong];
const FRAMES = 600;
let dtSeed = 0x1b873593;
const DT = Array.from({ length: FRAMES }, () => {
  dtSeed = (Math.imul(dtSeed, 1664525) + 1013904223) >>> 0;
  return 0.008 + (dtSeed / 2 ** 32) * 0.026;
});

const rig = named("rig");
const hips = named("hips");
const spine = named("spine");
const head = named("head");
const prop = named("prop");
rig.add(hips, prop);
hips.add(spine);
spine.add(head);
const RIG = [rig, hips, spine, head, prop];
const TRACK_TYPES = {
  vector: three.VectorKeyframeTrack,
  quaternion: three.QuaternionKeyframeTrack,
  number: three.NumberKeyframeTrack,
  color: three.ColorKeyframeTrack,
  bool: three.BooleanKeyframeTrack,
};
const TRACK_TYPE_NAMES: Record<TrackKind, string> = {
  vector: "Vector",
  quaternion: "Quaternion",
  number: "Number",
  color: "Color",
  bool: "Bool",
};
const INTERPOLATIONS = {
  Discrete: three.InterpolateDiscrete,
  Linear: three.InterpolateLinear,
  Smooth: three.InterpolateSmooth,
};
const flag = (x: boolean) => (x ? 1 : 0);
const cDoubles = (xs: number[]) =>
  xs.map((x) => `std::bit_cast<double>(${hex64(f64(Number(x)))})`).join(", ");

/**
 * Plays `clipSpecs` on a mixer over `root` through the timeline `ops`, one update per delta, and
 * records `observe()` plus every action's state and the mixer's stats every fifth frame, and every
 * loop and finished event. Returns those and the C++ table lines that let the native test rebuild
 * the same clips, timeline and deltas.
 */
function runMixerScenario(
  clipSpecs: IClipSpec[],
  ops: Op[],
  deltas: number[],
  root: InstanceType<typeof three.Object3D>,
  observe: () => string[],
) {
  const clips = clipSpecs.map(
    (c) =>
      new three.AnimationClip(
        c.name,
        c.duration,
        c.tracks.map(
          (s) =>
            new TRACK_TYPES[s.kind](
              s.name,
              s.times,
              s.kind === "bool" ? s.values.map((v) => v === 1) : s.values,
              INTERPOLATIONS[s.interpolation],
            ),
        ),
        c.additive ? three.AdditiveAnimationBlendMode : three.NormalAnimationBlendMode,
      ),
  );
  const mixer = new three.AnimationMixer(root);
  const actions = clips.map((clip) => mixer.clipAction(clip));
  const events: string[] = [];
  let frame = 0;
  for (const type of ["finished", "loop"]) {
    mixer.addEventListener(
      type,
      (e: {
        type: string;
        action: { getClip(): { name: string } };
        direction?: number;
        loopDelta?: number;
      }) => {
        events.push(
          `${frame}:${e.type}:${e.action.getClip().name}:${e.direction ?? 0}:${bits(e.loopDelta ?? 0)}`,
        );
      },
    );
  }
  const applyOp = ([, op, i, a, b, c]: Op) => {
    const action = actions[i];
    switch (op) {
      case "play":
        action.play();
        break;
      case "stop":
        action.stop();
        break;
      case "reset":
        action.reset();
        break;
      case "fadeIn":
        action.fadeIn(a);
        break;
      case "fadeOut":
        action.fadeOut(a);
        break;
      case "crossFadeFrom":
        action.crossFadeFrom(actions[a], b, c === 1);
        break;
      case "crossFadeTo":
        action.crossFadeTo(actions[a], b, c === 1);
        break;
      case "halt":
        action.halt(a);
        break;
      case "warp":
        action.warp(a, b, c);
        break;
      case "setLoop":
        action.setLoop(LOOPS[a], b);
        break;
      case "clamp":
        action.clampWhenFinished = a === 1;
        break;
      case "weight":
        action.weight = a;
        break;
      case "timeScale":
        action.timeScale = a;
        break;
      case "setEffectiveWeight":
        action.setEffectiveWeight(a);
        break;
      case "setEffectiveTimeScale":
        action.setEffectiveTimeScale(a);
        break;
      case "setDuration":
        action.setDuration(a);
        break;
      case "syncWith":
        action.syncWith(actions[a]);
        break;
      case "startAt":
        action.startAt(mixer.time + a);
        break;
      case "zeroSlope":
        action.zeroSlopeAtStart = a === 1;
        action.zeroSlopeAtEnd = b === 1;
        break;
      case "mixerTimeScale":
        mixer.timeScale = a;
        break;
      case "mixerSetTime":
        mixer.setTime(a);
        break;
      case "stopAll":
        mixer.stopAllAction();
        break;
      case "uncacheAction":
        mixer.uncacheAction(clips[i]);
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
  };
  const samples: string[] = [];
  for (frame = 0; frame < deltas.length; ++frame) {
    for (const op of ops) if (op[0] === frame) applyOp(op);
    mixer.update(deltas[frame] as number);
    if (frame % 5 !== 4) continue;
    const states = actions.map(
      (a, i) =>
        `a${i}:t=${bits(a.time)};w=${bits(a.getEffectiveWeight())};ts=${bits(a.getEffectiveTimeScale())};e=${flag(a.enabled)};p=${flag(a.paused)};r=${flag(a.isRunning())};s=${flag(a.isScheduled())}`,
    );
    const s = mixer.stats;
    samples.push(
      [
        `f${frame}`,
        `t=${bits(mixer.time)}`,
        ...observe(),
        ...states,
        `stats=${s.actions.total},${s.actions.inUse},${s.bindings.total},${s.bindings.inUse},${s.controlInterpolants.total},${s.controlInterpolants.inUse}`,
      ].join("|"),
    );
  }
  const lines = [
    `// Generated by packages/three-native/tests/animation/animation-reference.ts from three@${version}.`,
    "// Do not edit: rerun the generator. Doubles are their 16 hex digits of bits.",
    ...clipSpecs.flatMap((c, ci) =>
      c.tracks.flatMap((s, ti) => [
        `static const double kTimes${ci}_${ti}[] = {${cDoubles(s.times)}};`,
        `static const double kValues${ci}_${ti}[] = {${cDoubles(s.values)}};`,
      ]),
    ),
    "static const TrackSpec kTracks[] = {",
    ...clipSpecs.flatMap((c, ci) =>
      c.tracks.map(
        (s, ti) =>
          `    {${ci}, ${cString(s.name)}, TrackType::${TRACK_TYPE_NAMES[s.kind]}, Interpolation::${s.interpolation}, kTimes${ci}_${ti}, std::size(kTimes${ci}_${ti}), kValues${ci}_${ti}, std::size(kValues${ci}_${ti})},`,
      ),
    ),
    "};",
    "static const ClipSpec kClips[] = {",
    ...clipSpecs.map(
      (c) =>
        `    {${cString(c.name)}, std::bit_cast<double>(${hex64(f64(c.duration))}), ${c.additive ? "BlendMode::Additive" : "BlendMode::Normal"}},`,
    ),
    "};",
    "static const OpSpec kOps[] = {",
    ...ops.map(
      ([fr, op, i, a, b, c]) => `    {${fr}, ${cString(op)}, ${i}, ${cDoubles([a, b, c])}},`,
    ),
    "};",
    `static const double kDeltas[] = {${cDoubles(deltas)}};`,
    "static const char* const kSamples[] = {",
    ...samples.map((x) => `    ${cString(x)},`),
    "};",
    "static const char* const kEvents[] = {",
    ...events.map((x) => `    ${cString(x)},`),
    "};",
    "",
  ];
  return lines;
}

const mixerLines = runMixerScenario(CLIPS, OPS, DT, rig, () =>
  RIG.map((o) => `${o.name}:p=${vec(o.position)};q=${vec(o.quaternion)};s=${vec(o.scale)}`),
);

// ---- PRD-517: property tracks on materials, lights, a camera and visibility, same mixer
const stage = named("stage");
const cubeMaterial = new three.MeshStandardMaterial({
  color: 0x3366cc,
  roughness: 0.5,
  transparent: true,
});
const cube = Object.assign(new three.Mesh(new three.BoxGeometry(), cubeMaterial), { name: "cube" });
const ballMaterial = new three.MeshPhongMaterial({ color: 0xffffff, shininess: 30 });
const ball = Object.assign(new three.Mesh(new three.SphereGeometry(), ballMaterial), {
  name: "ball",
});
const sun = Object.assign(new three.DirectionalLight(0xffeedd, 2), { name: "sun" });
const cam = Object.assign(new three.PerspectiveCamera(50, 1.5, 0.1, 100), { name: "cam" });
const empty = named("empty");
// Two morph targets: an entire-array track and an element track bind its morphTargetInfluences.
const blobGeometry = new three.BoxGeometry();
blobGeometry.morphAttributes.position = [
  blobGeometry.attributes.position.clone(),
  blobGeometry.attributes.position.clone(),
];
const blob = Object.assign(new three.Mesh(blobGeometry, new three.MeshStandardMaterial()), {
  name: "blob",
});
stage.add(cube, ball, sun, cam, empty, blob);
const PROPERTY_CLIPS: IClipSpec[] = [
  {
    name: "look",
    duration: -1,
    additive: false,
    tracks: [
      {
        name: "blob.morphTargetInfluences",
        kind: "number",
        interpolation: "Linear",
        times: [0, 0.5, 1],
        values: [0, 0, 1, 0.25, 0.4, 0.9],
      },
      {
        name: "cube.material.color",
        kind: "color",
        interpolation: "Linear",
        times: [0, 0.5, 1],
        values: [0.2, 0.4, 0.8, 0.9, 0.3, 0.1, 0.2, 0.4, 0.8],
      },
      {
        name: "cube.material.opacity",
        kind: "number",
        interpolation: "Linear",
        times: [0, 0.4, 1],
        values: [1, 0.35, 1],
      },
      {
        name: "cube.material.roughness",
        kind: "number",
        interpolation: "Smooth",
        times: [0, 0.3, 0.7, 1],
        values: [0.5, 0.9, 0.2, 0.5],
      },
      {
        name: "ball.material.shininess",
        kind: "number",
        interpolation: "Linear",
        times: [0, 1],
        values: [30, 90],
      },
      {
        name: "ball.material.emissive",
        kind: "color",
        interpolation: "Discrete",
        times: [0, 0.5],
        values: [0, 0, 0, 0.5, 0.1, 0],
      },
      {
        name: "sun.intensity",
        kind: "number",
        interpolation: "Linear",
        times: [0, 0.6, 1.2],
        values: [2, 3.5, 2],
      },
      {
        name: "sun.color",
        kind: "color",
        interpolation: "Linear",
        times: [0, 1.2],
        values: [1, 0.93, 0.87, 0.7, 0.8, 1],
      },
      {
        name: "cam.fov",
        kind: "number",
        interpolation: "Smooth",
        times: [0, 0.4, 0.8, 1.2],
        values: [50, 42, 60, 50],
      },
      {
        name: "empty.visible",
        kind: "bool",
        interpolation: "Discrete",
        times: [0, 0.3, 0.6, 0.9],
        values: [1, 0, 1, 0],
      },
      // Bound nowhere: a Standard material has no sheen, and a light no fov. Writes must vanish.
      {
        name: "cube.material.sheen",
        kind: "number",
        interpolation: "Linear",
        times: [0, 1],
        values: [0, 1],
      },
      { name: "sun.fov", kind: "number", interpolation: "Linear", times: [0, 1], values: [10, 20] },
    ],
  },
  {
    name: "flash",
    duration: 0.8,
    additive: false,
    tracks: [
      {
        name: "cube.material.color",
        kind: "color",
        interpolation: "Linear",
        times: [0, 0.4, 0.8],
        values: [1, 1, 1, 1, 0.2, 0.2, 1, 1, 1],
      },
      {
        name: "sun.intensity",
        kind: "number",
        interpolation: "Linear",
        times: [0, 0.8],
        values: [6, 1],
      },
      {
        name: "empty.visible",
        kind: "bool",
        interpolation: "Discrete",
        times: [0, 0.2, 0.5],
        values: [0, 1, 0],
      },
      {
        name: "cam.zoom",
        kind: "number",
        interpolation: "Linear",
        times: [0, 0.8],
        values: [1, 1.6],
      },
      {
        name: "blob.morphTargetInfluences[1]",
        kind: "number",
        interpolation: "Linear",
        times: [0, 0.8],
        values: [0.1, 0.7],
      },
    ],
  },
  {
    name: "dim",
    duration: -1,
    additive: true,
    tracks: [
      {
        name: "sun.intensity",
        kind: "number",
        interpolation: "Linear",
        times: [0, 1],
        values: [0, -1.5],
      },
      {
        name: "cube.material.opacity",
        kind: "number",
        interpolation: "Linear",
        times: [0, 1],
        values: [0, -0.2],
      },
      {
        name: "empty.visible",
        kind: "bool",
        interpolation: "Discrete",
        times: [0, 0.5],
        values: [1, 0],
      },
    ],
  },
];
const PROPERTY_OPS: Op[] = [
  [0, "play", 0, 0, 0, 0],
  [40, "weight", 1, 0.3, 0, 0],
  [40, "play", 1, 0, 0, 0],
  [90, "crossFadeFrom", 1, 0, 0.5, 0],
  [130, "weight", 2, 0.6, 0, 0],
  [130, "play", 2, 0, 0, 0],
  [170, "play", 0, 0, 0, 0],
  [170, "crossFadeTo", 1, 0, 0.4, 0],
  [210, "stop", 1, 0, 0, 0],
  [250, "stop", 2, 0, 0, 0],
  [280, "stopAll", 0, 0, 0, 0],
];
const propertyLines = runMixerScenario(
  PROPERTY_CLIPS,
  PROPERTY_OPS,
  DT.slice(0, 300),
  stage,
  () => [
    `cube:c=${vec(cubeMaterial.color)};o=${bits(cubeMaterial.opacity)};r=${bits(cubeMaterial.roughness)};v=${cubeMaterial.version}`,
    `ball:sh=${bits(ballMaterial.shininess)};em=${vec(ballMaterial.emissive)};v=${ballMaterial.version}`,
    `sun:i=${bits(sun.intensity)};c=${vec(sun.color)};m=${flag(sun.matrixWorldNeedsUpdate)}`,
    `cam:fov=${bits(cam.fov)};zoom=${bits(cam.zoom)};m=${flag(cam.matrixWorldNeedsUpdate)}`,
    `empty:v=${flag(empty.visible)};m=${flag(empty.matrixWorldNeedsUpdate)}`,
    `blob:mi=${(blob.morphTargetInfluences ?? []).map(bits).join(",")};m=${flag(blob.matrixWorldNeedsUpdate)}`,
  ],
);

const outputs: Array<[string, string]> = [
  ["interpolants_reference.inc", lines.join("\n")],
  ["property_binding_reference.inc", bindingLines.join("\n")],
  ["mixer_reference.inc", mixerLines.join("\n")],
  ["property_tracks_reference.inc", propertyLines.join("\n")],
];
for (const [file, text] of outputs) {
  const out = path.join(OUT_DIR, file);
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== text) {
      console.error(
        `TN_FIXTURE_STALE: ${path.relative(REPO_ROOT, out)} is not what three@${version} produces`,
      );
      process.exit(1);
    }
    console.log(`current: ${file}`);
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${path.relative(REPO_ROOT, out)}`);
  }
}
