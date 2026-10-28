import { type Node, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Matrix4, Quaternion, Vector3 } from "three";

/** A posed frame: every tracked bone's world transform, in the model's own units. */
export interface FrameSample {
  readonly positions: Readonly<Record<string, [number, number, number]>>;
  readonly rotations: Readonly<Record<string, [number, number, number, number]>>;
  readonly time: number;
}

export interface ClipSamples {
  readonly bones: readonly string[];
  readonly duration: number;
  readonly fps: number;
  readonly frames: readonly FrameSample[];
}

interface Channel {
  readonly interpolation: string;
  readonly times: Float32Array;
  readonly values: Float32Array;
}

type Channels = ReadonlyMap<string, ReadonlyMap<string, Channel>>;

const reader = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** CUBICSPLINE stores in-tangent, value and out-tangent per key; the value component is sampled and
 * the tangents ignored, which is exact at every keyframe and straight between two. Verify reads a
 * dense grid of frames, so the approximation can neither invent nor hide a defect. */
function sampleChannel(channel: Channel, width: number, time: number): number[] {
  const { times, values } = channel;
  const keys = times.length;
  const cubic = channel.interpolation === "CUBICSPLINE";
  const stride = cubic ? width * 3 : width;
  const at = (index: number, component: number): number =>
    values[index * stride + (cubic ? width : 0) + component] ?? 0;
  const first = times[0] ?? 0;
  const last = times[keys - 1] ?? first;
  const read = (index: number): number[] =>
    Array.from({ length: width }, (_, component) => at(index, component));
  if (keys === 0) return new Array<number>(width).fill(0);
  if (time <= first) return read(0);
  if (time >= last) return read(keys - 1);

  let right = 1;
  while (right < keys && (times[right] ?? 0) < time) right += 1;
  const left = right - 1;
  const start = times[left] ?? 0;
  const end = times[right] ?? start;
  const from = read(left);
  if (channel.interpolation === "STEP" || end - start <= 1e-9) return from;
  const alpha = (time - start) / (end - start);
  const to = read(right);
  return from.map((value, component) => value + ((to[component] ?? 0) - value) * alpha);
}

function trsAt(node: Node, channels: Channels, time: number) {
  const own = channels.get(node.getName());
  const translation = [...node.getTranslation()];
  const rotation = [...node.getRotation()];
  const scale = [...node.getScale()];
  const translationChannel = own?.get("translation");
  if (translationChannel !== undefined)
    translation.splice(0, 3, ...sampleChannel(translationChannel, 3, time));
  const rotationChannel = own?.get("rotation");
  if (rotationChannel !== undefined)
    rotation.splice(0, 4, ...sampleChannel(rotationChannel, 4, time));
  const scaleChannel = own?.get("scale");
  if (scaleChannel !== undefined) scale.splice(0, 3, ...sampleChannel(scaleChannel, 3, time));
  return {
    matrix: new Matrix4().compose(
      new Vector3(translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0),
      new Quaternion(rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1),
      new Vector3(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1),
    ),
    translation,
  };
}

function longestKey(node: Node, channels: Channels): number {
  let end = 0;
  for (const channel of channels.get(node.getName())?.values() ?? [])
    end = Math.max(end, channel.times.at(-1) ?? 0);
  for (const child of node.listChildren()) end = Math.max(end, longestKey(child, channels));
  return end;
}

/**
 * Poses a clip frame by frame and reports every bone's world transform, with no renderer: glTF
 * animation targets node TRS, so sampling it and composing the hierarchy is skinning without the
 * skin. No GPU, no texture, no browser — which is what lets verify run in the same process as the
 * agent that asked for it.
 */
export async function sampleClip(file: string, clip: string, fps = 30): Promise<ClipSamples> {
  const document = await reader().read(file);
  const animation = document
    .getRoot()
    .listAnimations()
    .find((candidate) => candidate.getName() === clip);
  if (animation === undefined) {
    const available = document
      .getRoot()
      .listAnimations()
      .map((candidate) => candidate.getName());
    throw new Error(
      `The GLB has no clip '${clip}'. It carries: ${available.length === 0 ? "none" : available.join(", ")}.`,
    );
  }

  const channels = new Map<string, Map<string, Channel>>();
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode();
    const sampler = channel.getSampler();
    const path = channel.getTargetPath();
    if (node === null || sampler === null || path === null) continue;
    const times = sampler.getInput()?.getArray();
    const values = sampler.getOutput()?.getArray();
    if (times === null || times === undefined || values === null || values === undefined) continue;
    const perNode = channels.get(node.getName()) ?? new Map<string, Channel>();
    perNode.set(path, {
      interpolation: sampler.getInterpolation(),
      times: times as Float32Array,
      values: values as Float32Array,
    });
    channels.set(node.getName(), perNode);
  }

  const roots = document
    .getRoot()
    .listScenes()
    .flatMap((scene) => scene.listChildren());
  const duration = roots.reduce((end, root) => Math.max(end, longestKey(root, channels)), 0);
  const joints = document
    .getRoot()
    .listSkins()
    .flatMap((skin) => skin.listJoints())
    .map((joint) => joint.getName());
  // Every named node when the file has no skin: a verification tool that only saw the skin's joints
  // would report a clean clip for a skeleton whose feet are not skinned.
  const tracked = new Set(
    joints.length > 0
      ? joints
      : document
          .getRoot()
          .listNodes()
          .map((node) => node.getName())
          .filter((name) => name.length > 0),
  );
  const bones = [...tracked];

  const frameCount = Math.max(1, Math.round(duration * fps));
  const frames: FrameSample[] = [];
  for (let index = 0; index <= frameCount; index += 1) {
    const time = Math.min(duration, index / fps);
    const positions: Record<string, [number, number, number]> = {};
    const rotations: Record<string, [number, number, number, number]> = {};
    const visit = (node: Node, parent: Matrix4): void => {
      const world = parent.clone().multiply(trsAt(node, channels, time).matrix);
      const name = node.getName();
      if (tracked.has(name)) {
        const position = new Vector3().setFromMatrixPosition(world);
        const rotation = new Quaternion().setFromRotationMatrix(world);
        positions[name] = [position.x, position.y, position.z];
        rotations[name] = [rotation.x, rotation.y, rotation.z, rotation.w];
      }
      for (const child of node.listChildren()) visit(child, world);
    };
    for (const root of roots) visit(root, new Matrix4());
    frames.push({ positions, rotations, time });
  }

  return { bones, duration, fps, frames };
}
