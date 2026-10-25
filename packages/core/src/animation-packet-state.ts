import { AnimationAction, type AnimationClip, AnimationMixer, type Object3D } from "three";

/** Internal ownership/time observation; clip and rig eligibility remain the batch's responsibility. */
export interface IAnimationPacketState {
  readonly root: Object3D;
  readonly mixer: AnimationMixer;
  readonly action: AnimationAction;
  readonly clip: AnimationClip;
  readonly time: number;
  readonly evaluated: boolean;
  readonly evaluation: number;
}

export const animationPacketReaders = new WeakMap<
  Object3D,
  () => IAnimationPacketState | undefined
>();

/** The trusted playhead as a bare number, for a caller that only needs the time between full reads. */
export const animationPacketTimeReaders = new WeakMap<Object3D, () => number | undefined>();

export function readAnimationPacketState(object: Object3D): IAnimationPacketState | undefined {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    const reader = animationPacketReaders.get(node);
    if (reader !== undefined) return reader();
  }
  return undefined;
}

/** Accessors and replaced methods are ineligible; observing must not invoke author code. */
export function animationPacketField(object: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

const actionMethods = [
  "getClip",
  "getEffectiveWeight",
  "getEffectiveTimeScale",
  "isRunning",
  "isScheduled",
] as const;
const defaults = actionMethods.map(
  (name) =>
    [name, Object.getOwnPropertyDescriptor(AnimationAction.prototype, name)?.value] as const,
);
const mixerMethods = ["getRoot", "_isActiveAction"] as const;
const mixerDefaults = mixerMethods.map(
  (name) => [name, Object.getOwnPropertyDescriptor(AnimationMixer.prototype, name)?.value] as const,
);

function unchangedMethod(object: object, name: string, expected: unknown): boolean {
  if (typeof expected !== "function") return false;
  for (let owner: object | null = object; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor !== undefined)
      return Object.hasOwn(descriptor, "value") && descriptor.value === expected;
  }
  return false;
}

export function animationPacketMethodsPristine(
  action: AnimationAction,
  mixer: AnimationMixer,
): boolean {
  return (
    defaults.every(([name, method]) => unchangedMethod(action, name, method)) &&
    mixerDefaults.every(([name, method]) => unchangedMethod(mixer, name, method))
  );
}

export function animationPacketTime(
  held: number,
  pending: number,
  duration: number,
): number | undefined {
  if (!Number.isFinite(pending) || pending < 0) return undefined;
  if (pending === 0) return held;
  let time = held + pending;
  if (!Number.isFinite(time)) return undefined;
  const seam = Math.round(time / duration) * duration;
  if (Math.abs(time - seam) <= Number.EPSILON * 16 * Math.max(duration, Math.abs(time)))
    time = seam;
  // Same repeating wrap as the proven read-only query and Three's AnimationAction._updateTime.
  return time >= duration || time < 0 ? time - duration * Math.floor(time / duration) : time;
}
