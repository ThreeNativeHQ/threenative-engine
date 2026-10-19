import {
  AnimationClip,
  AnimationUtils,
  type Bone,
  InterpolateDiscrete,
  InterpolateLinear,
  type KeyframeTrack,
  NormalAnimationBlendMode,
  type Object3D,
  PropertyBinding,
  QuaternionKeyframeTrack,
} from "three";
import { animationFinite } from "./animation-blend.js";

export interface IAnimationMask {
  readonly bones: readonly string[];
  readonly descendants?: boolean;
  /** Explicit root ownership; refused when root motion owns that same track. */
  readonly includeRoot?: boolean;
}

export interface IAnimationLayer {
  readonly name: string;
  readonly clip: string;
  readonly mask: IAnimationMask;
  readonly mode: "override" | "additive";
  readonly once?: boolean;
  readonly reference?: { readonly clip: AnimationClip; readonly time: number };
}

export interface IPreparedAnimation {
  readonly samples: readonly {
    readonly duration: number;
    readonly clips: readonly AnimationClip[];
  }[];
  readonly layers: readonly { readonly options: IAnimationLayer; readonly clip: AnimationClip }[];
  readonly clips: readonly AnimationClip[];
}

interface IBindingTarget extends PropertyBinding {
  readonly targetObject?: Object3D;
}

/** Canonical UUID paths keep aliases for one property from becoming competing Three bindings. */
export function canonicalAnimationClip(root: Object3D, source: AnimationClip): AnimationClip {
  if (source.blendMode !== NormalAnimationBlendMode)
    throw new Error(
      `AnimationComposer: '${source.name}' must be a normal clip; additive layers need an explicit reference.`,
    );
  if (source.tracks.length === 0)
    throw new Error(`AnimationComposer: '${source.name}' has no tracks.`);
  if (!(animationFinite(source.duration, `'${source.name}' duration`) > 0))
    throw new Error(`AnimationComposer: '${source.name}' requires positive duration.`);
  const seen = new Set<string>();
  const tracks = source.tracks.map((track) => {
    const parsed = PropertyBinding.parseTrackName(track.name);
    if (
      !["position", "quaternion", "scale"].includes(parsed.propertyName) ||
      parsed.propertyIndex !== undefined
    )
      throw new Error(
        `AnimationComposer: incompatible track '${track.name}'; use bone transforms, exclude face controls.`,
      );
    const binding = new PropertyBinding(root, track.name) as IBindingTarget;
    binding.bind();
    const node = binding.targetObject;
    if (node?.isObject3D !== true)
      throw new Error(`AnimationComposer: '${track.name}' does not bind a rig node.`);
    const expected = parsed.propertyName === "quaternion" ? 4 : 3;
    if (track.ValueTypeName !== (expected === 4 ? "quaternion" : "vector"))
      throw new Error(`AnimationComposer: incompatible track type for '${track.name}'.`);
    if (
      track.getValueSize() !== expected ||
      track.times.length === 0 ||
      track.values.length !== track.times.length * expected
    )
      throw new Error(`AnimationComposer: incompatible values for '${track.name}'.`);
    let last = Number.NEGATIVE_INFINITY;
    for (const time of track.times) {
      if (
        animationFinite(time, `'${track.name}' key time`) <= last ||
        time < 0 ||
        time > source.duration
      )
        throw new Error(
          `AnimationComposer: '${track.name}' key times must increase within the duration.`,
        );
      last = time;
    }
    for (const value of track.values) animationFinite(value, `'${track.name}' value`);
    if (expected === 4) {
      for (let i = 0; i < track.values.length; i += 4) {
        const norm = Math.hypot(
          track.values[i] as number,
          track.values[i + 1] as number,
          track.values[i + 2] as number,
          track.values[i + 3] as number,
        );
        if (Math.abs(norm - 1) > 1e-5)
          throw new Error(`AnimationComposer: '${track.name}' quaternion must be normalized.`);
      }
    }
    const canonical = `${node.uuid}.${parsed.propertyName}`;
    if (seen.has(canonical)) throw new Error(`AnimationComposer: duplicate track '${track.name}'.`);
    seen.add(canonical);
    const copy = track.clone();
    copy.name = canonical;
    return copy;
  });
  return new AnimationClip(source.name, source.duration, tracks);
}

function resolveMask(root: Object3D, mask: IAnimationMask, name: string): Set<string> {
  if (mask.bones.length === 0) throw new Error(`AnimationComposer: '${name}' mask needs bones.`);
  const bones = new Map<string, Bone[]>();
  root.traverse((node) => {
    if ((node as Bone).isBone !== true) return;
    const entries = bones.get(node.name) ?? [];
    entries.push(node as Bone);
    bones.set(node.name, entries);
  });
  const selected = new Set<string>();
  const add = (node: Object3D) => {
    if ((node as Bone).isBone !== true) return;
    if ((node.parent as Bone | null)?.isBone !== true && mask.includeRoot !== true)
      throw new Error(
        `AnimationComposer: '${name}' mask selects root '${node.name}'; select includeRoot explicitly.`,
      );
    selected.add(node.uuid);
  };
  for (const name of mask.bones) {
    const entries = bones.get(name);
    if (entries?.length !== 1)
      throw new Error(
        `AnimationComposer: mask bone '${name}' is missing or ambiguous on this cloned rig.`,
      );
    const bone = entries[0] as Bone;
    if (mask.descendants === true) bone.traverse(add);
    else add(bone);
  }
  return selected;
}

function maskedClip(clip: AnimationClip, mask: ReadonlySet<string>, name: string): AnimationClip {
  const tracks = clip.tracks.filter((track) =>
    mask.has(track.name.slice(0, track.name.lastIndexOf("."))),
  );
  if (tracks.length === 0)
    throw new Error(`AnimationComposer: '${name}' mask matches no clip tracks.`);
  return new AnimationClip(name, clip.duration, tracks);
}

/** VQ-05's one layer preparation owner; no source clip, pose or mixer mutation. */
export function prepareAnimationLayers(
  root: Object3D,
  sources: readonly AnimationClip[],
  samples: readonly string[],
  layers: readonly IAnimationLayer[],
  consumedRoot?: Object3D,
): IPreparedAnimation {
  const clips = new Map<string, AnimationClip>();
  for (const source of sources) {
    if (clips.has(source.name))
      throw new Error(`AnimationComposer: duplicate clip '${source.name}'.`);
    clips.set(source.name, source);
  }
  const get = (name: string) => {
    const clip = clips.get(name);
    if (clip === undefined) throw new Error(`AnimationComposer: missing clip '${name}'.`);
    return canonicalAnimationClip(root, clip);
  };
  if (samples.length === 0 || new Set(samples).size !== samples.length)
    throw new Error("AnimationComposer: samples must be nonempty and unique.");
  if (
    layers.filter((layer) => layer.mode === "override").length > 1 ||
    layers.filter((layer) => layer.mode === "additive").length > 2
  )
    throw new Error("AnimationComposer: capacity is one override and two additive layers.");
  const names = new Set<string>();
  const preparedLayers = layers.map((options) => {
    if (!["override", "additive"].includes(options.mode))
      throw new Error(`AnimationComposer: '${options.name}' has invalid mode.`);
    if (options.name.length === 0 || names.has(options.name))
      throw new Error("AnimationComposer: layer names must be nonempty and unique.");
    names.add(options.name);
    const mask = resolveMask(root, options.mask, options.name);
    if (consumedRoot !== undefined && mask.has(consumedRoot.uuid))
      throw new Error("AnimationComposer: root-motion and layer root ownership conflict.");
    const clip = maskedClip(get(options.clip), mask, `layer:${options.name}`);
    if (options.mode === "additive") {
      if (options.reference === undefined)
        throw new Error(
          `AnimationComposer: additive '${options.name}' requires an explicit reference pose.`,
        );
      const time = animationFinite(options.reference.time, `'${options.name}' reference time`);
      const reference = canonicalAnimationClip(root, options.reference.clip);
      if (time < 0 || time > reference.duration)
        throw new Error(`AnimationComposer: '${options.name}' reference time is outside its clip.`);
      for (const track of clip.tracks) {
        const ref = reference.tracks.find((candidate) => candidate.name === track.name);
        if (
          ref === undefined ||
          ref.ValueTypeName !== track.ValueTypeName ||
          ref.getValueSize() !== track.getValueSize()
        )
          throw new Error(`AnimationComposer: reference pose lacks compatible '${track.name}'.`);
      }
      AnimationUtils.makeClipAdditive(clip, time * 30, reference, 30);
    }
    return { options, clip };
  });
  const override = preparedLayers.find((layer) => layer.options.mode === "override");
  const overridden = new Set(override?.clip.tracks.map((track) => track.name));
  const preparedSamples = samples.map((name) => {
    const clip = get(name);
    if (consumedRoot !== undefined) {
      for (const track of clip.tracks) {
        if (!track.name.startsWith(`${consumedRoot.uuid}.`)) continue;
        const property = track.name.slice(track.name.lastIndexOf(".") + 1);
        if (property !== "position" && property !== "quaternion") continue;
        const reference =
          property === "position"
            ? consumedRoot.position.toArray()
            : consumedRoot.quaternion.toArray();
        for (let offset = 0; offset < track.values.length; offset += reference.length)
          track.values.set(reference, offset);
      }
    }
    const groups: AnimationClip[] = [];
    for (const masked of [false, true]) {
      const tracks: KeyframeTrack[] = clip.tracks.filter(
        (track) => overridden.has(track.name) === masked,
      );
      if (tracks.length > 0)
        groups.push(
          new AnimationClip(`sample:${name}:${masked ? "masked" : "base"}`, clip.duration, tracks),
        );
    }
    return { duration: clip.duration, clips: groups };
  });
  const all = [
    ...preparedSamples.flatMap((sample) => sample.clips),
    ...preparedLayers.map((layer) => layer.clip),
  ];
  if (all.length > 8)
    throw new Error(
      `AnimationComposer: requires ${all.length} actions; capacity is eight. Reduce samples or layers.`,
    );
  // Pose snapshots only: root-motion validation keeps its authored linear interpolants.
  // Constant stock quaternion keys need no SLERP; retain every key, track and owned buffer.
  for (const clip of all)
    for (const track of clip.tracks)
      if (
        Object.getPrototypeOf(track) === QuaternionKeyframeTrack.prototype &&
        track.getInterpolation() === InterpolateLinear &&
        track.values.every((value, index) => value === track.values[index % 4])
      )
        track.setInterpolation(InterpolateDiscrete);
  return { samples: preparedSamples, layers: preparedLayers, clips: all };
}
