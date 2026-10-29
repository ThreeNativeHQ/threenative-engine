import { type AnchorId, detectedAnchors } from "./landmarks.js";
import { type ClipSamples, type FrameSample, sampleClip } from "./sample.js";

export type DefectKind =
  | "bone-stretch"
  | "foot-skate"
  | "ground-penetration"
  | "jitter"
  | "loop-seam";

export interface Defect {
  readonly bone: string;
  readonly detail: string;
  readonly kind: DefectKind;
  /** Frame indices, inclusive, so an agent can seek to the damage instead of hunting. */
  readonly fromFrame: number;
  readonly fromTime: number;
  readonly limit: number;
  readonly measured: number;
  readonly toFrame: number;
  readonly toTime: number;
}

/** Thresholds in metres. A model that is not in metres passes `scale` — Mixamo and Quaternius GLBs
 * are centimetres, so a game passes 0.01 and the same numbers mean the same thing. */
export interface VerifyThresholds {
  /** How far a planted foot may slide within one contact. AC-5 names 2 cm. */
  readonly skate: number;
  /** How far below the floor a bone may reach. */
  readonly penetration: number;
  /** How close to its lowest point a foot still counts as planted. */
  readonly contact: number;
  /** How many metres the frame before and after must move a bone to count as a spike, after the
   * clip's own median motion is removed. */
  readonly jitter: number;
  /** Angle in degrees between the first and last frame of a loop. AC-5 names 5°. */
  readonly seam: number;
  /** Relative change in a bone's distance to its parent. */
  readonly stretch: number;
}

export const DEFAULT_THRESHOLDS: VerifyThresholds = Object.freeze({
  contact: 0.03,
  jitter: 0.05,
  penetration: 0.01,
  seam: 5,
  skate: 0.02,
  stretch: 0.02,
});

export interface VerifyReport {
  readonly bones: number;
  readonly clip: string;
  readonly defects: readonly Defect[];
  readonly duration: number;
  readonly file: string;
  readonly fps: number;
  readonly frames: number;
  readonly passed: boolean;
  readonly scale: number;
  readonly thresholds: VerifyThresholds;
}

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

const horizontal = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** The angle between two orientations. Both are normalised first: authored quaternions are not
 * always unit length, and an unnormalised one makes `acos` read a 5° drift as 150°. */
function angleBetween(a: readonly number[], b: readonly number[]): number {
  const length = (value: readonly number[]): number =>
    Math.hypot(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1) || 1;
  const dot =
    ((a[0] ?? 0) * (b[0] ?? 0) +
      (a[1] ?? 0) * (b[1] ?? 0) +
      (a[2] ?? 0) * (b[2] ?? 0) +
      (a[3] ?? 1) * (b[3] ?? 1)) /
    (length(a) * length(b));
  return (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI;
}

interface Span {
  readonly from: number;
  readonly to: number;
}

/** Contiguous frames, so a defect reports the window it spans rather than one frame per sample. */
function spans(frames: readonly number[], gap = 2): Span[] {
  const result: Span[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const frame of frames) {
    if (start === undefined || previous === undefined || frame - previous > gap) {
      if (start !== undefined && previous !== undefined) result.push({ from: start, to: previous });
      start = frame;
    }
    previous = frame;
  }
  if (start !== undefined && previous !== undefined) result.push({ from: start, to: previous });
  return result;
}

function footSkate(
  samples: ClipSamples,
  feet: readonly string[],
  limit: number,
  contact: number,
): Defect[] {
  const defects: Defect[] = [];
  for (const foot of feet) {
    const heights = samples.frames.map((frame) => frame.positions[foot]?.[1] ?? 0);
    const floor = Math.min(...heights);
    const planted = samples.frames
      .map((frame, index) => ({ index, frame }))
      .filter(({ frame }) => (frame.positions[foot]?.[1] ?? 0) <= floor + contact);
    let anchor: FrameSample | undefined;
    let window: { first: number; last: number; worst: number } | undefined;
    const flush = (): void => {
      if (window === undefined) return;
      if (window.worst > limit) {
        defects.push({
          bone: foot,
          detail: `the planted foot slid ${(window.worst * 1000).toFixed(0)} mm between frames ${window.first} and ${window.last}`,
          fromFrame: window.first,
          fromTime: samples.frames[window.first]?.time ?? 0,
          kind: "foot-skate",
          limit,
          measured: window.worst,
          toFrame: window.last,
          toTime: samples.frames[window.last]?.time ?? 0,
        });
      }
      window = undefined;
      anchor = undefined;
    };
    let previousIndex: number | undefined;
    for (const { index, frame } of planted) {
      if (previousIndex !== undefined && index - previousIndex > 1) flush();
      anchor ??= frame;
      const drift = horizontal(
        frame.positions[foot] ?? [0, 0, 0],
        anchor.positions[foot] ?? [0, 0, 0],
      );
      window ??= { first: index, last: index, worst: 0 };
      window.last = index;
      window.worst = Math.max(window.worst, drift);
      previousIndex = index;
    }
    flush();
  }
  return defects;
}

function groundPenetration(
  samples: ClipSamples,
  bones: readonly string[],
  limit: number,
): Defect[] {
  const defects: Defect[] = [];
  for (const bone of bones) {
    const below = samples.frames
      .map((frame, index) => ({ index, y: frame.positions[bone]?.[1] }))
      .filter(({ y }) => y !== undefined && y < -limit);
    for (const span of spans(below.map(({ index }) => index))) {
      const worst = below
        .filter(({ index }) => index >= span.from && index <= span.to)
        .reduce((low, { y }) => Math.min(low, y ?? 0), 0);
      defects.push({
        bone,
        detail: `reaches ${(Math.abs(worst) * 1000).toFixed(0)} mm below the floor`,
        fromFrame: span.from,
        fromTime: samples.frames[span.from]?.time ?? 0,
        kind: "ground-penetration",
        limit,
        measured: Math.abs(worst),
        toFrame: span.to,
        toTime: samples.frames[span.to]?.time ?? 0,
      });
    }
  }
  return defects;
}

/** One seam is one property of the clip, reported on the bone that is furthest off: a 30° offset at
 * the hips rotates every descendant, and sixty copies of the same defect is noise, not detail. */
function loopSeam(samples: ClipSamples, limit: number): Defect[] {
  const first = samples.frames[0];
  const last = samples.frames.at(-1);
  if (first === undefined || last === undefined || samples.frames.length < 3) return [];
  let worst: { angle: number; bone: string } | undefined;
  let offenders = 0;
  for (const bone of samples.bones) {
    const a = first.rotations[bone];
    const b = last.rotations[bone];
    if (a === undefined || b === undefined) continue;
    const angle = angleBetween(a, b);
    if (angle <= limit) continue;
    offenders += 1;
    if (worst === undefined || angle > worst.angle) worst = { angle, bone };
  }
  if (worst === undefined) return [];
  return [
    {
      bone: worst.bone,
      detail: `the clip ends ${worst.angle.toFixed(1)}° from where it started${offenders > 1 ? `, and ${offenders - 1} more bones with it` : ""}`,
      fromFrame: 0,
      fromTime: first.time,
      kind: "loop-seam",
      limit,
      measured: worst.angle,
      toFrame: samples.frames.length - 1,
      toTime: last.time,
    },
  ];
}

function jitter(samples: ClipSamples, bones: readonly string[], limit: number): Defect[] {
  const defects: Defect[] = [];
  for (const bone of bones) {
    const positions = samples.frames.map((frame) => frame.positions[bone]);
    const spikes: number[] = [];
    const perFrame = new Map<number, number>();
    let worst = 0;
    for (let index = 1; index < positions.length - 1; index += 1) {
      const before = positions[index - 1];
      const now = positions[index];
      const after = positions[index + 1];
      if (before === undefined || now === undefined || after === undefined) continue;
      const bend = distance(
        [
          2 * (now[0] ?? 0) - (before[0] ?? 0),
          2 * (now[1] ?? 0) - (before[1] ?? 0),
          2 * (now[2] ?? 0) - (before[2] ?? 0),
        ],
        [after[0] ?? 0, after[1] ?? 0, after[2] ?? 0],
      );
      if (bend > limit) {
        spikes.push(index);
        perFrame.set(index, Math.max(perFrame.get(index) ?? 0, bend));
        worst = Math.max(worst, bend);
      }
    }
    for (const span of spans(spikes.map((index) => index))) {
      defects.push({
        bone,
        detail: `a frame-direction spike of ${((perFrame.get(span.from) ?? worst) * 1000).toFixed(0)} mm`,
        fromFrame: span.from,
        fromTime: samples.frames[span.from]?.time ?? 0,
        kind: "jitter",
        limit,
        measured: worst,
        toFrame: span.to,
        toTime: samples.frames[span.to]?.time ?? 0,
      });
    }
  }
  return defects;
}

/** A skeleton whose bones change length is a bad retarget or a bad bind, and no amount of eye on a
 * contact sheet catches it. Measured against each bone's actual parent, which is the pair a rig edit
 * changes; nearest neighbours read a weapon bone moving past a hand as a 29% stretch on the root. */
function boneStretch(samples: ClipSamples, limit: number): Defect[] {
  const rest = samples.frames[0];
  if (rest === undefined) return [];
  const defects: Defect[] = [];
  for (const [bone, parent] of Object.entries(samples.parentsOf)) {
    const base = distance(rest.positions[bone] ?? [0, 0, 0], rest.positions[parent] ?? [0, 0, 0]);
    if (base <= 1e-6) continue;
    const changes = samples.frames
      .map((frame, index) => ({
        index,
        ratio: Math.abs(
          distance(frame.positions[bone] ?? [0, 0, 0], frame.positions[parent] ?? [0, 0, 0]) /
            base -
            1,
        ),
      }))
      .filter(({ ratio }) => ratio > limit);
    if (changes.length === 0) continue;
    const worst = changes.reduce((high, { ratio }) => Math.max(high, ratio), 0);
    for (const span of spans(changes.map(({ index }) => index))) {
      defects.push({
        bone,
        detail: `distance to its parent '${parent}' changes by ${(worst * 100).toFixed(1)}%`,
        fromFrame: span.from,
        fromTime: samples.frames[span.from]?.time ?? 0,
        kind: "bone-stretch",
        limit,
        measured: worst,
        toFrame: span.to,
        toTime: samples.frames[span.to]?.time ?? 0,
      });
    }
  }
  return defects;
}

const FOOT_LANDMARKS: ReadonlySet<AnchorId> = new Set(["left-foot", "right-foot"]);

/**
 * Measures a clip for the defects a still frame cannot show: a foot sliding through its contact, a
 * bone reaching under the floor, a loop that does not close, a one-frame spike, a skeleton whose
 * bones change length. Each defect names the bone and the frames it spans, so the caller can seek
 * straight to it.
 */
export async function verifyClip(
  file: string,
  clip: string,
  options: { fps?: number; scale?: number; thresholds?: Partial<VerifyThresholds> } = {},
): Promise<VerifyReport> {
  const scale = options.scale ?? 1;
  const thresholds: VerifyThresholds = {
    contact: (options.thresholds?.contact ?? DEFAULT_THRESHOLDS.contact) / scale,
    jitter: (options.thresholds?.jitter ?? DEFAULT_THRESHOLDS.jitter) / scale,
    penetration: (options.thresholds?.penetration ?? DEFAULT_THRESHOLDS.penetration) / scale,
    seam: options.thresholds?.seam ?? DEFAULT_THRESHOLDS.seam,
    skate: (options.thresholds?.skate ?? DEFAULT_THRESHOLDS.skate) / scale,
    stretch: options.thresholds?.stretch ?? DEFAULT_THRESHOLDS.stretch,
  };
  const samples = await sampleClip(file, clip, options.fps ?? 30);
  const feet = detectedAnchors(samples.bones)
    .filter((anchor) => FOOT_LANDMARKS.has(anchor.id))
    .map((anchor) => anchor.node);
  const defects = [
    ...footSkate(samples, feet, thresholds.skate, thresholds.contact),
    ...groundPenetration(samples, samples.bones, thresholds.penetration),
    ...loopSeam(samples, thresholds.seam),
    ...jitter(samples, samples.bones, thresholds.jitter),
    ...boneStretch(samples, thresholds.stretch),
  ];
  return {
    bones: samples.bones.length,
    clip,
    defects,
    duration: samples.duration,
    file,
    fps: samples.fps,
    frames: samples.frames.length,
    passed: defects.length === 0,
    scale,
    thresholds,
  };
}
