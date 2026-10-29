import { type Animation, type AnimationChannel, type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { type ClipEdit, keepFrames, localDelta, mirroredBone } from "./clip-edit.js";
import { type Channel, sampleChannel, samplesOf } from "./sample.js";

const reader = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);

const widthOf = (path: string): number => (path === "rotation" ? 4 : 3);

/** The sampled channel a glTF sampler holds, in the shape `sampleChannel` reads. */
function channelOf(channel: AnimationChannel): Channel | undefined {
  const sampler = channel.getSampler();
  const times = sampler?.getInput()?.getArray();
  const values = sampler?.getOutput()?.getArray();
  if (
    sampler === null ||
    times === null ||
    times === undefined ||
    values === null ||
    values === undefined
  )
    return undefined;
  return { interpolation: sampler.getInterpolation(), times, values };
}

function writeSampler(
  document: Document,
  channel: AnimationChannel,
  times: readonly number[],
  values: readonly number[],
  width: number,
): void {
  const sampler = channel.getSampler();
  if (sampler === null) return;
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const input = document
    .createAccessor(`${channel.getTargetNode()?.getName()}.time`)
    .setType("SCALAR")
    .setArray(new Float32Array(times))
    .setBuffer(buffer);
  const output = document
    .createAccessor(`${channel.getTargetNode()?.getName()}.${channel.getTargetPath()}`)
    .setType(width === 4 ? "VEC4" : "VEC3")
    .setArray(new Float32Array(values))
    .setBuffer(buffer);
  sampler.setInput(input).setOutput(output).setInterpolation("LINEAR");
}

/** Rewrites every channel's timeline. `keep` returns the new time for a key, or undefined to drop
 * it; `closeAt` appends a key whose value is the clip's first, which is what makes a loop close. */
function retime(
  document: Document,
  animation: Animation,
  keep: (time: number) => number | undefined,
  closeAt?: number,
): void {
  for (const channel of animation.listChannels()) {
    const channelData = channelOf(channel);
    if (channelData === undefined) continue;
    const path = channel.getTargetPath() ?? "translation";
    const width = widthOf(path);
    const cubic = channelData.interpolation === "CUBICSPLINE";
    const stride = cubic ? width * 3 : width;
    const { source, times } = keepFrames([...channelData.times], keep);
    if (times.length === 0)
      throw new Error(
        `'${animation.getName()}' keeps no keyframes in that window; the edit would leave an empty clip.`,
      );
    const values: number[] = [];
    for (const index of source) {
      for (let component = 0; component < stride; component += 1)
        values.push(channelData.values[index * stride + component] ?? 0);
    }
    if (closeAt !== undefined) {
      const first = sampleChannel(channelData, width, 0);
      const at = closeAt;
      const insert = times.findIndex((time) => time > at);
      const position = insert === -1 ? times.length : insert;
      times.splice(position, 0, at);
      const triple = cubic
        ? Array.from({ length: 3 * width }, (_, component) =>
            component >= width && component < width * 2 ? (first[component - width] ?? 0) : 0,
          )
        : first;
      values.splice(position * stride, 0, ...triple);
    }
    // Keep the tangent slot shape the sampler already had, so a cubic file stays cubic.
    writeSampler(document, channel, times, values, width);
    if (cubic) channel.getSampler()?.setInterpolation("CUBICSPLINE");
    else if (channelData.interpolation === "STEP") channel.getSampler()?.setInterpolation("STEP");
  }
}

function durationOf(animation: Animation): number {
  let end = 0;
  for (const channel of animation.listChannels())
    end = Math.max(end, channelOf(channel)?.times.at(-1) ?? 0);
  return end;
}

/** Cuts a clip to [start, end] with both edges sampled, so the window is exactly what was asked for
 * even when no key sits on it. */
function trimTo(document: Document, animation: Animation, start: number, end: number): void {
  for (const channel of animation.listChannels()) {
    const data = channelOf(channel);
    if (data === undefined) continue;
    const width = widthOf(channel.getTargetPath() ?? "translation");
    const cubic = data.interpolation === "CUBICSPLINE";
    const stride = cubic ? width * 3 : width;
    const padding = cubic ? width : 0;
    const head = [...sampleChannel(data, width, start), ...(cubic ? new Array(width).fill(0) : [])];
    const tail = [...sampleChannel(data, width, end), ...(cubic ? new Array(width).fill(0) : [])];
    const times = [0];
    const values = [...head];
    for (let index = 0; index < data.times.length; index += 1) {
      const time = data.times[index] ?? 0;
      if (time <= start || time >= end) continue;
      times.push(time - start);
      for (let component = 0; component < stride; component += 1)
        values.push(data.values[index * stride + component] ?? 0);
    }
    times.push(end - start);
    values.push(...tail);
    writeSampler(document, channel, times, values, width);
    if (cubic) channel.getSampler()?.setInterpolation("CUBICSPLINE");
    void padding;
  }
}

function resample(document: Document, animation: Animation, fps: number): void {
  const channels = animation.listChannels();
  let duration = 0;
  for (const channel of channels) {
    const data = channelOf(channel);
    if (data !== undefined) duration = Math.max(duration, data.times.at(-1) ?? 0);
  }
  const frames = Math.max(1, Math.round(duration * fps));
  const times = Array.from({ length: frames + 1 }, (_, index) => Math.min(duration, index / fps));
  for (const channel of channels) {
    const data = channelOf(channel);
    if (data === undefined) continue;
    const width = widthOf(channel.getTargetPath() ?? "translation");
    const values = times.flatMap((time) => sampleChannel(data, width, time));
    writeSampler(document, channel, times, values, width);
  }
}

/** Mirrors about the YZ plane: the clip drives the opposite bone, positions flip x, rotations flip
 * y and z. A bone with no side is left where it was. */
function mirror(document: Document, animation: Animation): void {
  const nodes = new Map(
    document
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node] as const),
  );
  for (const channel of animation.listChannels()) {
    const target = channel.getTargetNode();
    const data = channelOf(channel);
    if (target === null || data === undefined) continue;
    const path = channel.getTargetPath() ?? "translation";
    const width = widthOf(path);
    const values: number[] = [];
    for (let index = 0; index + width <= data.values.length; index += width) {
      const value = Array.from(
        { length: width },
        (_, component) => data.values[index + component] ?? 0,
      );
      if (path === "translation") value[0] = -(value[0] ?? 0);
      if (path === "rotation") {
        value[1] = -(value[1] ?? 0);
        value[2] = -(value[2] ?? 0);
      }
      values.push(...value);
    }
    writeSampler(document, channel, [...data.times], values, width);
    const opposite = mirroredBone(target.getName());
    const partner = opposite === undefined ? undefined : nodes.get(opposite);
    if (partner !== undefined) channel.setTargetNode(partner);
  }
}

/** Holds each planted foot where its contact started, by adding the world-space correction to the
 * bone's own translation in parent space. ponytail: the ankle moves, the knee does not — an IK pass
 * that redistributes the correction up the leg is the upgrade if a locked foot ever reads stiff. */
function footLock(
  document: Document,
  animation: Animation,
  edit: Extract<ClipEdit, { kind: "foot-lock" }>,
): void {
  const samples = samplesOf(document, animation.getName());
  const feet =
    edit.feet.length > 0 ? edit.feet : samples.bones.filter((bone) => /foot/iu.test(bone));
  if (feet.length === 0) throw new Error("No foot bones to lock: name them with 'feet'.");
  for (const foot of feet) {
    const heights = samples.frames.map((frame) => frame.positions[foot]?.[1] ?? 0);
    const floor = Math.min(...heights);
    const channel = animation
      .listChannels()
      .find(
        (candidate) =>
          candidate.getTargetNode()?.getName() === foot &&
          candidate.getTargetPath() === "translation",
      );
    if (channel === undefined) continue;
    const data = channelOf(channel);
    if (data === undefined) continue;
    const times: number[] = [];
    const values: number[] = [];
    let anchor: readonly number[] | undefined;
    let planted = false;
    samples.frames.forEach((frame, index) => {
      const position = frame.positions[foot];
      if (position === undefined) return;
      const isDown = (position[1] ?? 0) <= floor + edit.contact;
      if (!isDown) {
        planted = false;
        anchor = undefined;
      } else {
        anchor ??= position;
        planted = true;
      }
      const delta =
        planted && anchor !== undefined
          ? [(anchor[0] ?? 0) - (position[0] ?? 0), 0, (anchor[2] ?? 0) - (position[2] ?? 0)]
          : [0, 0, 0];
      const local = localDelta(delta, frame.parents[foot] ?? [0, 0, 0, 1]);
      times.push(frame.time);
      values.push(
        ...[
          (sampleChannel(data, 3, frame.time)[0] ?? 0) + local[0],
          (sampleChannel(data, 3, frame.time)[1] ?? 0) + local[1],
          (sampleChannel(data, 3, frame.time)[2] ?? 0) + local[2],
        ],
      );
    });
    writeSampler(document, channel, times, values, 3);
  }
}

/** Applies one edit to one clip, in place. Pure over the document: the same document and the same
 * edit always produce the same bytes, which is what lets a replay be checked. */
export function applyEdit(document: Document, animation: Animation, edit: ClipEdit): void {
  switch (edit.kind) {
    case "trim": {
      if (edit.end <= edit.start) throw new Error("trim needs an end after its start.");
      const duration = durationOf(animation);
      if (edit.start >= duration || edit.end > duration + 1e-6)
        throw new Error(
          `trim asks for ${edit.start}–${edit.end}s but '${animation.getName()}' is ${duration}s long.`,
        );
      trimTo(document, animation, edit.start, edit.end);
      return;
    }
    case "retime":
      if (!(edit.speed > 0)) throw new Error("retime needs a speed above zero.");
      retime(document, animation, (time) => time / edit.speed);
      return;
    case "loop-point":
      retime(document, animation, (time) => (time <= edit.time ? time : undefined), edit.time);
      return;
    case "resample":
      if (!(edit.fps > 0)) throw new Error("resample needs an fps above zero.");
      resample(document, animation, edit.fps);
      return;
    case "mirror":
      mirror(document, animation);
      return;
    case "foot-lock":
      footLock(document, animation, edit);
      return;
  }
}

/** Applies edits for one clip, in the order the log recorded them. */
export function applyEdits(document: Document, clip: string, edits: readonly ClipEdit[]): void {
  const animations = document
    .getRoot()
    .listAnimations()
    .filter((animation) => animation.getName() === clip);
  if (animations.length === 0) throw new Error(`The GLB has no clip '${clip}' to edit.`);
  for (const edit of edits)
    for (const animation of animations) applyEdit(document, animation, edit);
}

export async function writeDocument(document: Document, file: string): Promise<void> {
  await reader().write(file, document);
}

export async function readDocument(file: string): Promise<Document> {
  return reader().read(file);
}
