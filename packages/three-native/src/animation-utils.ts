// three's AnimationUtils, ported from three r187 src/animation/AnimationUtils.js (MIT), with
// Quaternion.slerpFlat, Quaternion.multiplyQuaternionsFlat and LinearInterpolant written over plain arrays.
//
// The engine's keyframe tracks answer `times` and `values` as copies, and an AnimationClip holds copies
// of the tracks it is handed. So a write into `track.values[k]` is lost, and three's in-place edits
// cannot work. subclip and makeClipAdditive here build NEW tracks from adjusted arrays through each
// track's own constructor and return a NEW clip of them. Use the returned clip: the input is unchanged.
// The same code runs on three's own classes, where it gives three's values (see its spec).

type Values = ArrayLike<number> & { readonly constructor: unknown };

// three's property name; Record keeps it out of the naming rule.
type ITrack = Readonly<Record<"ValueTypeName", string>> & {
  readonly name: string;
  readonly times: Values;
  readonly values: Values;
  readonly constructor: unknown;
  getValueSize?(): number;
  getInterpolation?(): number;
  createInterpolant?: (() => { evaluate(time: number): ArrayLike<number> }) & {
    isInterpolantFactoryMethodGLTFCubicSpline?: boolean;
  };
};

interface IClip {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly ITrack[];
  readonly blendMode?: number;
  readonly constructor: unknown;
}

type TrackClass = new (
  name: string,
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  interpolation?: number,
) => ITrack;
type ClipClass = new (
  name: string,
  duration: number,
  tracks: ITrack[],
  blendMode?: number,
) => IClip;

const ADDITIVE_ANIMATION_BLEND_MODE = 2501;

// The engine track binds no getValueSize; three's is this same ratio.
const valueSize = (track: ITrack) =>
  track.getValueSize?.() ?? track.values.length / track.times.length;

// The V8 engine's constructors refuse an explicit undefined argument, so an absent optional one is left out.
const defined = (value: number | undefined) => (value === undefined ? [] : [value]);

// A copy of `track` with new keys; the interpolation carries over where the track answers it.
const rebuild = (track: ITrack, times: ArrayLike<number>, values: ArrayLike<number>) =>
  new (track.constructor as TrackClass)(
    track.name,
    times,
    values,
    ...defined(track.getInterpolation?.()),
  );

type ArrayType = Partial<Record<"BYTES_PER_ELEMENT", number>> & (new (array: never) => unknown);

export function convertArray(array: unknown, type: ArrayType): unknown {
  if (!array || (array as { constructor?: unknown }).constructor === type) return array;
  if (typeof type.BYTES_PER_ELEMENT === "number") return new type(array as never);
  return Array.prototype.slice.call(array);
}

export function isTypedArray(object: unknown): boolean {
  return ArrayBuffer.isView(object) && !(object instanceof DataView);
}

export function hasTangents(settings?: { inTangents?: unknown; outTangents?: unknown }): boolean {
  return (
    settings !== undefined &&
    settings.inTangents !== undefined &&
    settings.outTangents !== undefined
  );
}

export function getKeyframeOrder(times: ArrayLike<number>): number[] {
  const result = Array.from({ length: times.length }, (_, i) => i);
  result.sort((i, j) => (times[i] as number) - (times[j] as number));
  return result;
}

export function sortedArray<T extends ArrayLike<number> & { constructor: unknown }>(
  values: T,
  stride: number,
  order: readonly number[],
): T {
  const result = new (values.constructor as new (length: number) => T & number[])(values.length);
  for (let i = 0, dst = 0; dst !== values.length; ++i) {
    const src = (order[i] as number) * stride;
    for (let j = 0; j !== stride; ++j) result[dst++] = values[src + j] as number;
  }
  return result;
}

type Key = Record<string, unknown> & { time: number };

export function flattenJSON(
  jsonKeys: readonly Key[],
  times: number[],
  values: unknown[],
  valuePropertyName: string,
): void {
  let i = 1;
  let key = jsonKeys[0];
  while (key !== undefined && key[valuePropertyName] === undefined) key = jsonKeys[i++];
  if (key === undefined) return;
  const first = key[valuePropertyName];
  if (first === undefined) return;
  do {
    const value = key[valuePropertyName];
    if (value !== undefined) {
      times.push(key.time);
      if (Array.isArray(first)) values.push(...(value as unknown[]));
      else if ((first as { toArray?: unknown }).toArray !== undefined)
        (value as { toArray(array: unknown[], offset: number): void }).toArray(
          values,
          values.length,
        );
      else values.push(value);
    }
    key = jsonKeys[i++];
  } while (key !== undefined);
}

export function subclip(
  sourceClip: IClip,
  name: string,
  startFrame: number,
  endFrame: number,
  fps = 30,
): IClip {
  const kept: { track: ITrack; times: number[]; values: number[] }[] = [];
  for (const track of sourceClip.tracks) {
    const size = valueSize(track);
    const times: number[] = [];
    const values: number[] = [];
    const sourceTimes = track.times;
    const sourceValues = track.values;
    for (let j = 0; j < sourceTimes.length; ++j) {
      const frame = (sourceTimes[j] as number) * fps;
      if (frame < startFrame || frame >= endFrame) continue;
      times.push(sourceTimes[j] as number);
      for (let k = 0; k < size; ++k) values.push(sourceValues[j * size + k] as number);
    }
    if (times.length > 0) kept.push({ track, times, values });
  }
  // Shift every track so the clip begins at t = 0, then take the duration from the last key.
  const type = (track: ITrack, field: "times" | "values") => track[field].constructor as ArrayType;
  const shifted = kept.map(
    ({ track, times }) => convertArray(times, type(track, "times")) as number[],
  );
  const start = Math.min(...shifted.map((times) => times[0] as number));
  let duration = 0;
  const tracks = kept.map(({ track, values }, i) => {
    const times = shifted[i] as number[];
    for (let j = 0; j < times.length; j++) times[j] = (times[j] as number) - start;
    duration = Math.max(duration, times[times.length - 1] as number);
    return rebuild(track, times, convertArray(values, type(track, "values")) as number[]);
  });
  return new (sourceClip.constructor as ClipClass)(
    name,
    duration,
    tracks,
    ...defined(sourceClip.blendMode),
  );
}

// three's Quaternion.slerpFlat over plain arrays.
function slerpFlat(a: ArrayLike<number>, b: ArrayLike<number>, t: number): number[] {
  let [x0, y0, z0, w0] = [a[0] as number, a[1] as number, a[2] as number, a[3] as number];
  let [x1, y1, z1, w1] = [b[0] as number, b[1] as number, b[2] as number, b[3] as number];
  if (w0 !== w1 || x0 !== x1 || y0 !== y1 || z0 !== z1) {
    let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
    if (dot < 0) {
      [x1, y1, z1, w1, dot] = [-x1, -y1, -z1, -w1, -dot];
    }
    let s = 1 - t;
    let u = t;
    if (dot < 0.9995) {
      const theta = Math.acos(dot);
      const sin = Math.sin(theta);
      s = Math.sin(s * theta) / sin;
      u = Math.sin(u * theta) / sin;
    }
    [x0, y0, z0, w0] = [x0 * s + x1 * u, y0 * s + y1 * u, z0 * s + z1 * u, w0 * s + w1 * u];
    if (dot >= 0.9995) {
      const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
      [x0, y0, z0, w0] = [x0 * f, y0 * f, z0 * f, w0 * f];
    }
  }
  return [x0, y0, z0, w0];
}

// The track's value at `time`, strictly between its first and last keys. three's interpolant when the
// track has one; else three's linear interpolant (slerp for a quaternion).
// ponytail: the engine track binds no createInterpolant or getInterpolation, so a discrete or smooth
// engine track samples linearly here; bind getInterpolation when an additive layer needs those.
function sample(track: ITrack, time: number, size: number): number[] {
  if (track.createInterpolant) return Array.from(track.createInterpolant().evaluate(time));
  const { times, values } = track;
  let i = 1;
  while ((times[i] as number) < time) i++;
  const t0 = times[i - 1] as number;
  const weight = (time - t0) / ((times[i] as number) - t0);
  const v0 = Array.from({ length: size }, (_, k) => values[(i - 1) * size + k] as number);
  const v1 = Array.from({ length: size }, (_, k) => values[i * size + k] as number);
  if (track.ValueTypeName === "quaternion") return slerpFlat(v0, v1, weight);
  return v0.map((value, k) => value * (1 - weight) + (v1[k] as number) * weight);
}

// The glTF cubic-spline layout stores in-tangent, value, out-tangent per key.
const splineOffset = (track: ITrack, size: number) =>
  track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline ? size / 3 : 0;

// The reference track's value at `time`; a quaternion comes back normalized and conjugated.
function referenceValue(track: ITrack, time: number): number[] {
  const size = valueSize(track);
  const offset = splineOffset(track, size);
  const { times } = track;
  const last = times.length - 1;
  let value: number[];
  // Before the first key or after the last one, the reference value is that key.
  if (time <= (times[0] as number)) value = Array.from(track.values).slice(offset, size - offset);
  else if (time >= (times[last] as number)) {
    const start = last * size + offset;
    value = Array.from(track.values).slice(start, start + size - offset);
  } else value = sample(track, time, size);
  if (track.ValueTypeName !== "quaternion") return value;
  // Quaternion.normalize().conjugate().
  const [x, y, z, w] = value as [number, number, number, number];
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (length === 0) return [-0, -0, -0, 1];
  return [-(x / length), -(y / length), -(z / length), w / length];
}

// Subtracts `reference` from every key of `values`; a quaternion key becomes reference * key, where
// the reference is already conjugated.
function subtract(track: ITrack, values: number[], reference: number[]): void {
  const size = valueSize(track);
  const offset = splineOffset(track, size);
  const [x0, y0, z0, w0] = reference as [number, number, number, number];
  for (let j = 0; j < track.times.length; ++j) {
    const at = j * size + offset;
    if (track.ValueTypeName === "quaternion") {
      // Quaternion.multiplyQuaternionsFlat(values, at, reference, 0, values, at).
      const [x1, y1, z1, w1] = values.slice(at, at + 4) as [number, number, number, number];
      values[at] = x0 * w1 + w0 * x1 + y0 * z1 - z0 * y1;
      values[at + 1] = y0 * w1 + w0 * y1 + z0 * x1 - x0 * z1;
      values[at + 2] = z0 * w1 + w0 * z1 + x0 * y1 - y0 * x1;
      values[at + 3] = w0 * w1 - x0 * x1 - y0 * y1 - z0 * z1;
    } else
      for (let k = 0; k < size - offset * 2; ++k)
        values[at + k] = (values[at + k] as number) - (reference[k] as number);
  }
}

export function makeClipAdditive(
  targetClip: IClip,
  referenceFrame = 0,
  referenceClip: IClip = targetClip,
  fps = 30,
): IClip {
  const referenceTime = referenceFrame / (fps <= 0 ? 30 : fps);
  const targetTracks = targetClip.tracks;
  // Each changed target track's working values, rebuilt into a new track at the end.
  const edited = new Map<ITrack, number[]>();
  for (const referenceTrack of referenceClip.tracks) {
    const type = referenceTrack.ValueTypeName;
    // Skip non-numeric tracks.
    if (type === "bool" || type === "string") continue;
    const targetTrack = targetTracks.find(
      (track) => track.name === referenceTrack.name && track.ValueTypeName === type,
    );
    if (targetTrack === undefined) continue;
    const values = edited.get(targetTrack) ?? Array.from(targetTrack.values);
    subtract(targetTrack, values, referenceValue(referenceTrack, referenceTime));
    edited.set(targetTrack, values);
  }
  const tracks = targetTracks.map((track) => {
    const values = edited.get(track);
    if (values === undefined) return track;
    return rebuild(
      track,
      track.times,
      convertArray(values, track.values.constructor as ArrayType) as number[],
    );
  });
  return new (targetClip.constructor as ClipClass)(
    targetClip.name,
    targetClip.duration,
    tracks,
    ADDITIVE_ANIMATION_BLEND_MODE,
  );
}

const INTERPOLATE_DISCRETE = 2300;
/** three's property name, spelled through a constant so the naming rule does not read it as a game field. */
const VALUE_TYPE_NAME = "ValueTypeName";

/**
 * three's `track.createInterpolant(result)` on the engine's track classes, which do not bind it (core's root
 * motion samples with it). The interpolant reads a snapshot of the keys, holds the first and last key outside
 * them as three's Interpolant does, and writes each value into `result`.
 * ponytail: a smooth track evaluates linearly; port CubicInterpolant when a game samples one.
 */
export function defineCreateInterpolant(classes: Readonly<Record<string, unknown>>): void {
  for (const name of ["NumberKeyframeTrack", "VectorKeyframeTrack", "QuaternionKeyframeTrack"]) {
    const prototype = (classes[name] as { prototype?: object } | undefined)?.prototype;
    if (prototype === undefined || "createInterpolant" in prototype) continue;
    Object.defineProperty(prototype, "createInterpolant", {
      configurable: true,
      writable: true,
      value(this: ITrack, result?: Float32Array) {
        const size = valueSize(this);
        const times = Float32Array.from(this.times);
        const keys = Object.assign(
          { [VALUE_TYPE_NAME]: this.ValueTypeName },
          {
            name: this.name,
            times,
            values: Float32Array.from(this.values),
            constructor: undefined,
          },
        ) as ITrack;
        const discrete = this.getInterpolation?.() === INTERPOLATE_DISCRETE;
        const resultBuffer = result ?? new Float32Array(size);
        const last = times.length - 1;
        const keyValue = (key: number) =>
          (keys.values as Float32Array).subarray(key * size, key * size + size);
        return {
          resultBuffer,
          evaluate(time: number) {
            if (time <= (times[0] as number)) resultBuffer.set(keyValue(0));
            else if (time >= (times[last] as number)) resultBuffer.set(keyValue(last));
            else if (discrete) {
              let i = 1;
              while ((times[i] as number) <= time) i++;
              resultBuffer.set(keyValue(i - 1));
            } else resultBuffer.set(sample(keys, time, size));
            return resultBuffer;
          },
        };
      },
    });
  }
}

/** three's static `AnimationUtils` namespace. */
export const AnimationUtils = {
  convertArray,
  isTypedArray,
  hasTangents,
  getKeyframeOrder,
  sortedArray,
  flattenJSON,
  subclip,
  makeClipAdditive,
} as const;
