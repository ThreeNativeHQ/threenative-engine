import {
  LinearInterpolant,
  Matrix4,
  Quaternion,
  Skeleton,
  type SkinnedMesh,
  type Vector3,
} from "three";
import {
  type IAnimationPacketState,
  animationPacketField as field,
  readAnimationPacketState,
} from "./animation-packet-state.js";
import { isSimilarityTransform } from "./projection-skinned.js";

export interface IAnimationPoseKey {
  readonly times: readonly number[];
  readonly values: readonly number[];
}
export interface IAnimationPoseRest {
  readonly local: readonly number[];
  readonly position: readonly number[];
  readonly scale: readonly number[];
}
export interface IAnimationPoseVersion {
  readonly parent: readonly number[];
  readonly rest: readonly IAnimationPoseRest[];
  readonly keys: Readonly<Record<number, IAnimationPoseKey>>;
  readonly duration: number;
  readonly time: number;
  readonly evaluation: number;
  readonly bind: readonly number[];
  readonly bindInverse: readonly number[];
  readonly rootWorld: readonly number[];
  readonly bindInverses: readonly (readonly number[])[];
  readonly world64: readonly (readonly number[])[];
  readonly inverse64: readonly (readonly number[])[];
  readonly root64: readonly number[];
  readonly bind64: readonly number[];
  readonly bindInverse64: readonly number[];
  readonly bindMode: "attached";
}
export interface IAnimationPosePacket {
  readonly raw: true;
  readonly version: IAnimationPoseVersion;
  readonly time: number;
}

const cache = new WeakMap<
  SkinnedMesh,
  {
    readonly sources: readonly object[];
    version: IAnimationPoseVersion;
    readonly interpolants: readonly object[];
  }
>();
const prototype = Object.getPrototypeOf(Float32Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(prototype, "length")?.get;
const typedBuffer = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
const compose = Matrix4.prototype.compose;
const product = Matrix4.prototype.multiplyMatrices;
const methods = ["evaluate", "interpolate_", "copySampleValue_", "intervalChanged_"] as const;
const defaults = methods.map(
  (name) => [name, installedMethod(LinearInterpolant.prototype, name)] as const,
);
const F = Math.fround;
const skeletonUpdate = Object.getOwnPropertyDescriptor(Skeleton.prototype, "update")?.value;

/** True when this skeleton still runs three's own `update`: no own override, stock prototype. */
export function skeletonUpdateIntact(skeleton: object): boolean {
  return (
    Object.getPrototypeOf(skeleton) === Skeleton.prototype &&
    !Object.hasOwn(skeleton, "update") &&
    Skeleton.prototype.update === skeletonUpdate
  );
}

function installedMethod(value: object, name: string): unknown {
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor !== undefined)
      return Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  }
  return undefined;
}

function object(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
function member(value: unknown, name: string): unknown {
  return object(value) ? field(value, name) : undefined;
}
function numbers(value: unknown, length: number): readonly number[] | undefined {
  const array = Array.isArray(value);
  if (!array && !(value instanceof Float32Array)) return undefined;
  if (!array && !(typedBuffer?.call(value) instanceof ArrayBuffer)) return undefined;
  // An array's length is a non-configurable data property, and a typed array cannot carry an
  // element accessor, so both read directly; only plain numbers are accepted.
  if ((array ? (value as readonly unknown[]).length : typedLength?.call(value)) !== length)
    return undefined;
  const result: number[] = [];
  for (let i = 0; i < length; i++) {
    const n = (value as ArrayLike<unknown>)[i];
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
    result.push(n);
  }
  return Object.freeze(result);
}
function components(value: unknown, names: readonly string[]): readonly number[] | undefined {
  const result = names.map((name) => member(value, name));
  return result.every((n) => typeof n === "number" && Number.isFinite(n))
    ? Object.freeze(result as number[])
    : undefined;
}
function matrix(value: unknown): readonly number[] | undefined {
  return numbers(member(value, "elements"), 16);
}
function rounded(values: readonly number[]): readonly number[] {
  return Object.freeze(values.map(F));
}
// `same` and `finiteRaw` walk trees this module built and froze, which cannot carry accessors.
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => same((a as never)[key], (b as never)[key]))
  );
}
function sameNumbers(a: readonly number[], b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
function finiteRaw(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(F(value));
  return !object(value) || Object.keys(value).every((key) => finiteRaw((value as never)[key]));
}
function identity(values: readonly number[]): boolean {
  return values.every((v, i) => v === (i % 5 === 0 ? 1 : 0));
}
function pristine(value: unknown): boolean {
  if (!object(value) || Object.getPrototypeOf(value) !== LinearInterpolant.prototype) return false;
  return defaults.every(([name, expected]) => {
    for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
      const d = Object.getOwnPropertyDescriptor(owner, name);
      if (d !== undefined) return Object.hasOwn(d, "value") && d.value === expected;
    }
    return false;
  });
}
function sample(key: IAnimationPoseKey, time: number): number {
  if (time <= (key.times[0] as number)) return key.values[0] as number;
  for (let i = 1; i < 3; i++) {
    const end = key.times[i] as number;
    if (time <= end) {
      const alpha = F(
        (time - (key.times[i - 1] as number)) / F(end - (key.times[i - 1] as number)),
      );
      return F(
        (key.values[i - 1] as number) +
          F(F((key.values[i] as number) - (key.values[i - 1] as number)) * alpha),
      );
    }
  }
  return key.values[2] as number;
}
function validTransform(
  node: object,
  parentWorld: readonly number[],
): (IAnimationPoseRest & { readonly world: readonly number[] }) | undefined {
  const local = matrix(member(node, "matrix"));
  const world = matrix(member(node, "matrixWorld"));
  const position = components(member(node, "position"), ["x", "y", "z"]);
  const scale = components(member(node, "scale"), ["x", "y", "z"]);
  const q = components(member(node, "quaternion"), ["_x", "_y", "_z", "_w"]);
  if (!local || !world || !position || !scale || !q || member(node, "matrixAutoUpdate") !== true)
    return undefined;
  const scratch = new Matrix4();
  compose.call(
    scratch,
    { x: position[0], y: position[1], z: position[2] } as Vector3,
    new Quaternion(q[0], q[1], q[2], q[3]),
    { x: scale[0], y: scale[1], z: scale[2] } as Vector3,
  );
  if (!sameNumbers(local, scratch.elements)) return undefined;
  product.call(scratch, { elements: parentWorld } as Matrix4, { elements: local } as Matrix4);
  return sameNumbers(world, scratch.elements) ? { local, world, position, scale } : undefined;
}

/** Pure read/capture only. Every source component is revalidated, including on held ticks.
 * Caller captures on genuine evaluation/world refresh. Held numeric edits stay deferred until
 * that refresh, as in stock; readAnimationPosePacketTime retains the owned version between them.
 * Undefined means genuine stock fallback; no retirement, callbacks or batch lifecycle live here. */
export function readAnimationPosePacket(rig: SkinnedMesh): IAnimationPosePacket | undefined {
  const state = readAnimationPacketState(rig);
  if (!state || state.root !== rig) return undefined;
  const skeleton = member(rig, "skeleton");
  const bones = member(skeleton, "bones");
  const inverses = member(skeleton, "boneInverses");
  const tracks = member(state.clip, "tracks");
  const interpolants = member(state.action, "_interpolants");
  const bindings = member(state.action, "_propertyBindings");
  if (
    !Array.isArray(bones) ||
    bones.length !== 12 ||
    !Array.isArray(inverses) ||
    inverses.length !== 12 ||
    !Array.isArray(tracks) ||
    tracks.length !== 11 ||
    !Array.isArray(interpolants) ||
    interpolants.length !== 11 ||
    !Array.isArray(bindings) ||
    bindings.length !== 11 ||
    !object(skeleton)
  )
    return undefined;
  if (installedMethod(skeleton, "update") !== skeletonUpdate) return undefined;
  const bind = matrix(member(rig, "bindMatrix"));
  const bindInverse = matrix(member(rig, "bindMatrixInverse"));
  const rootWorld = matrix(member(rig, "matrixWorld"));
  if (
    !bind ||
    !identity(bind) ||
    !bindInverse ||
    !rootWorld ||
    member(rig, "bindMode") !== "attached"
  )
    return undefined;
  const parent = member(rig, "parent");
  const parentWorld =
    parent === null ? new Matrix4().elements : matrix(member(parent, "matrixWorld"));
  if (!parentWorld || !validTransform(rig, parentWorld)) return undefined;
  if (!isSimilarityTransform(rootWorld)) return undefined;
  const scratch = new Matrix4();
  product.call(scratch, { elements: rootWorld } as Matrix4, { elements: bindInverse } as Matrix4);
  if (scratch.elements.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-10))
    return undefined;
  const held = member(state.action, "time");
  const duration = member(state.clip, "duration");
  if (typeof held !== "number" || typeof duration !== "number") return undefined;
  const sources: object[] = [
    state.action,
    state.clip,
    skeleton,
    bones,
    inverses,
    tracks,
    interpolants,
    bindings,
  ];
  sources.push(
    ...[
      member(rig, "matrix"),
      member(rig, "matrixWorld"),
      member(rig, "bindMatrix"),
      member(rig, "bindMatrixInverse"),
      parent,
    ].filter(object),
  );
  const rest: IAnimationPoseRest[] = [];
  const worlds: (readonly number[])[] = [];
  const inverse64: (readonly number[])[] = [];
  const keys: Record<number, IAnimationPoseKey> = {};
  const capturedInterpolants: object[] = [];
  for (let i = 0; i < 12; i++) {
    const bone = member(bones, String(i));
    const inverse = matrix(member(inverses, String(i)));
    if (
      !object(bone) ||
      !inverse ||
      member(bone, "parent") !== (i === 0 ? rig : member(bones, String(i - 1)))
    )
      return undefined;
    const pose = validTransform(bone, i === 0 ? rootWorld : (worlds[i - 1] as readonly number[]));
    if (!pose) return undefined;
    rest.push(
      Object.freeze({
        local: rounded(pose.local),
        position: rounded(pose.position),
        scale: rounded(pose.scale),
      }),
    );
    worlds.push(pose.world);
    inverse64.push(inverse);
    sources.push(
      bone,
      ...[
        member(inverses, String(i)),
        member(bone, "matrix"),
        member(bone, "matrixWorld"),
        member(bone, "position"),
        member(bone, "scale"),
        member(bone, "quaternion"),
        member(bone, "rotation"),
      ].filter(object),
    );
  }
  for (let i = 0; i < 11; i++) {
    const track = member(tracks, String(i));
    const interpolation = member(interpolants, String(i));
    const binding = member(member(bindings, String(i)), "binding");
    const path = member(binding, "parsedPath");
    const bone = member(binding, "node");
    const index = bones.indexOf(bone);
    const positions = member(interpolation, "parameterPositions");
    const values = member(interpolation, "sampleValues");
    if (
      !object(track) ||
      !object(interpolation) ||
      !object(binding) ||
      index < 1 ||
      keys[index] ||
      !pristine(interpolation) ||
      member(interpolation, "valueSize") !== 1 ||
      member(path, "propertyName") !== "rotation" ||
      member(path, "propertyIndex") !== "z" ||
      member(track, "name") !== member(binding, "path") ||
      member(track, "times") !== positions ||
      member(track, "values") !== values
    )
      return undefined;
    const times = numbers(positions, 3);
    const samples = numbers(values, 3);
    if (
      !times ||
      !samples ||
      times[0] !== 0 ||
      times[2] !== duration ||
      !(times[0] < (times[1] as number) && (times[1] as number) < (times[2] as number))
    )
      return undefined;
    const key = Object.freeze({ times, values: samples });
    const z = sample(key, held);
    const b = bones[index];
    const rotation = components(member(b, "rotation"), ["_x", "_y", "_z"]);
    const q = components(member(b, "quaternion"), ["_x", "_y", "_z", "_w"]);
    const expected = [0, 0, Math.sin(z / 2), Math.cos(z / 2)];
    if (
      !rotation ||
      !q ||
      member(member(b, "rotation"), "_order") !== "XYZ" ||
      Math.abs(rotation[0] as number) > 1e-12 ||
      Math.abs(rotation[1] as number) > 1e-12 ||
      Math.abs((rotation[2] as number) - z) > 1e-7 ||
      ![1, -1].some((sign) =>
        q.every((v, j) => Math.abs(v - sign * (expected[j] as number)) < 1e-7),
      )
    )
      return undefined;
    keys[index] = key;
    capturedInterpolants.push(interpolation);
    sources.push(track, interpolation, binding, positions as object, values as object);
  }
  const version: IAnimationPoseVersion = Object.freeze({
    parent: Object.freeze(Array.from({ length: 12 }, (_, i) => i - 1)),
    rest: Object.freeze(rest),
    keys: Object.freeze(keys),
    duration,
    time: held,
    evaluation: state.evaluation,
    bind: rounded(bind),
    bindInverse: rounded(bindInverse),
    rootWorld: rounded(rootWorld),
    bindInverses: Object.freeze(inverse64.map(rounded)),
    world64: Object.freeze(worlds),
    inverse64: Object.freeze(inverse64),
    root64: rootWorld,
    bind64: bind,
    bindInverse64: bindInverse,
    bindMode: "attached",
  });
  if (!finiteRaw(version)) return undefined;
  const previous = cache.get(rig);
  const owned =
    previous &&
    previous.version.duration === version.duration &&
    previous.version.time === version.time &&
    previous.version.evaluation === version.evaluation &&
    previous.sources.length === sources.length &&
    sources.every((value, i) => value === previous.sources[i]) &&
    same(previous.version, version)
      ? previous.version
      : version;
  cache.set(rig, { sources, version: owned, interpolants: capturedInterpolants });
  return Object.freeze({ raw: true, version: owned, time: state.time });
}

/** Cheap held query: numeric keys/rest/bind remain owned until the next genuine refresh. */
function savedPacketFor(
  rig: SkinnedMesh,
  version: IAnimationPoseVersion,
): { saved: NonNullable<ReturnType<typeof cache.get>>; state: IAnimationPacketState } | undefined {
  const saved = cache.get(rig);
  const state = readAnimationPacketState(rig);
  const skeleton = rig.skeleton as Skeleton | undefined;
  if (
    !saved ||
    saved.version !== version ||
    !state ||
    state.root !== rig ||
    state.action !== saved.sources[0] ||
    state.clip !== saved.sources[1] ||
    state.clip.duration !== version.duration ||
    !skeleton ||
    skeleton !== saved.sources[2] ||
    skeleton.bones !== saved.sources[3] ||
    !skeletonUpdateIntact(skeleton) ||
    (state.action as unknown as { _interpolants?: unknown })._interpolants !== saved.sources[6]
  )
    return undefined;
  return { saved, state };
}

export function readAnimationPosePacketTime(
  rig: SkinnedMesh,
  version: IAnimationPoseVersion,
): IAnimationPosePacket | undefined {
  const found = savedPacketFor(rig, version);
  // Interpolant methods and element identity were validated by the capture; the batch re-reads
  // the whole packet every `revalidate` evaluations, so an in-place edit shows up there.
  return found && Object.freeze({ raw: true, version, time: found.state.time });
}

/**
 * A genuine refresh that reuses the captured packet: the same checks as the held query, and the
 * version is restamped with this evaluation's held time and counter so the CPU fallback and the
 * dedup bookkeeping read the pose this refresh produced. The numeric payload is shared as is.
 */
export function refreshAnimationPosePacket(
  rig: SkinnedMesh,
  version: IAnimationPoseVersion,
): IAnimationPosePacket | undefined {
  const found = savedPacketFor(rig, version);
  if (!found) return undefined;
  const held = (found.state.action as unknown as { time: number }).time;
  if (typeof held !== "number") return undefined;
  const next: IAnimationPoseVersion = Object.freeze({
    ...version,
    time: held,
    evaluation: found.state.evaluation,
  });
  found.saved.version = next;
  return Object.freeze({ raw: true, version: next, time: found.state.time });
}

/** Cached genuine CPU basis for held retirement; no current-time sampling or author calls. */
export function evaluateAnimationPoseFallback(version: IAnimationPoseVersion): Float32Array {
  const out = new Float32Array(192);
  const scratch = new Matrix4();
  for (let b = 0; b < 12; b++) {
    product.call(
      scratch,
      { elements: version.world64[b] } as Matrix4,
      { elements: version.inverse64[b] } as Matrix4,
    );
    out.set(scratch.elements, b * 16);
  }
  return out;
}

function rawProduct(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let value = F(F(a[r] as number) * F(b[c * 4] as number));
      value = F(value + F(F(a[4 + r] as number) * F(b[c * 4 + 1] as number)));
      value = F(value + F(F(a[8 + r] as number) * F(b[c * 4 + 2] as number)));
      out[c * 4 + r] = F(value + F(F(a[12 + r] as number) * F(b[c * 4 + 3] as number)));
    }
  return out;
}

/** Owned displayed RAW matrices, including the shader's root/bindInverse prefix. */
export function evaluateAnimationPosePacket(packet: IAnimationPosePacket): Float32Array {
  const v = packet.version;
  const out = new Float32Array(192);
  const worlds: Float32Array[] = [];
  const prefix = rawProduct(v.rootWorld, v.bindInverse);
  for (let b = 0; b < 12; b++) {
    const rest = v.rest[b] as IAnimationPoseRest;
    const key = v.keys[b];
    let local = Float32Array.from(rest.local);
    if (key) {
      const z = sample(key, packet.time);
      const c = F(Math.cos(z));
      const sn = F(Math.sin(z));
      local = new Float32Array([
        F(c * F(rest.scale[0] as number)),
        F(sn * F(rest.scale[0] as number)),
        0,
        0,
        F(-sn * F(rest.scale[1] as number)),
        F(c * F(rest.scale[1] as number)),
        0,
        0,
        0,
        0,
        F(rest.scale[2] as number),
        0,
        F(rest.position[0] as number),
        F(rest.position[1] as number),
        F(rest.position[2] as number),
        1,
      ]);
    }
    const world = rawProduct(b === 0 ? v.rootWorld : (worlds[b - 1] as Float32Array), local);
    worlds.push(world);
    out.set(rawProduct(prefix, rawProduct(world, v.bindInverses[b] as readonly number[])), b * 16);
  }
  return out;
}
