import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Accessor, type Document, type Node, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { AnimationPose, TransformValue } from "../client/recipe.js";
import { copyScene } from "./copy-prop.js";
import { type AnimationLog, DEFAULT_CLIP_KEY, replayOps } from "./log.js";

export interface BakeResult {
  readonly anchor: string;
  readonly attached: string;
  /** Clips the baked GLB holds an attachment track for. */
  readonly clips: string[];
  /** Clips where the recipe releases the prop. The bake still writes the last attached pose; when
   * the prop leaves the hand is a game rule, not an offset this package can decide. */
  readonly detached: string[];
  readonly file: string;
  readonly node: string;
}

const degrees = (value: number): number => (value * Math.PI) / 180;

/** XYZ Euler degrees to a glTF quaternion, in three's `Euler` order and sign. The view edits Euler
 * angles because a human does; glTF stores rotations. Hand-rolled so the server does not carry the
 * renderer, and held against three in the package spec so the two cannot drift. */
export function eulerToQuaternion(
  rotation: readonly [number, number, number],
): [number, number, number, number] {
  const [x, y, z] = [degrees(rotation[0]), degrees(rotation[1]), degrees(rotation[2])];
  const [c1, c2, c3] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2)];
  const [s1, s2, s3] = [Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)];
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function bufferOf(document: Document): ReturnType<Document["createBuffer"]> {
  return document.getRoot().listBuffers()[0] ?? document.createBuffer();
}

function accessor(
  document: Document,
  name: string,
  values: Float32Array,
  type: "SCALAR" | "VEC3" | "VEC4",
): Accessor {
  return document.createAccessor(name).setArray(values).setType(type).setBuffer(bufferOf(document));
}

function transformValues(frame: TransformValue): {
  rotation: [number, number, number, number];
  scale: [number, number, number];
  translation: [number, number, number];
} {
  return {
    rotation: eulerToQuaternion(frame.rotation),
    scale: frame.scale,
    translation: frame.position,
  };
}

/** Writes one animated channel onto `node` for one clip. */
function addChannel(
  document: Document,
  animation: ReturnType<Document["createAnimation"]>,
  node: Node,
  path: "rotation" | "scale" | "translation",
  times: readonly number[],
  values: Float32Array,
): void {
  const input = accessor(
    document,
    `${animation.getName()}.${path}.time`,
    new Float32Array(times),
    "SCALAR",
  );
  const output = accessor(
    document,
    `${animation.getName()}.${path}`,
    values,
    path === "rotation" ? "VEC4" : "VEC3",
  );
  const sampler = document
    .createAnimationSampler()
    .setInput(input)
    .setOutput(output)
    .setInterpolation("LINEAR");
  animation.addSampler(sampler);
  animation.addChannel(
    document.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler),
  );
}

function writeTrack(
  document: Document,
  animation: ReturnType<Document["createAnimation"]>,
  node: Node,
  track: AnimationPose,
): void {
  const frames = [...track.keyframes].sort((left, right) => left.time - right.time);
  const times = frames.map((frame) => frame.time);
  const samples = frames.map((frame) => transformValues(frame.transform));
  const channels: ["rotation" | "scale" | "translation", number][] = [
    ["rotation", 4],
    ["scale", 3],
    ["translation", 3],
  ];
  for (const [channel, width] of channels) {
    const flat = new Float32Array(samples.length * width);
    samples.forEach((sample, index) => flat.set(sample[channel], index * width));
    addChannel(document, animation, node, channel, times, flat);
  }
}

/**
 * Bakes the log's attachment into an ordinary GLB: the prop becomes a child of its bone, with a
 * translation, rotation and scale track per clip. Nothing at runtime needs the offsets, the pose
 * log, or this package.
 */
export interface AttachmentResult {
  readonly anchor: string;
  readonly attached: string;
  readonly clips: string[];
  readonly detached: string[];
  readonly node: string;
}

/** Puts the log's prop on its bone inside `document`, with one track per held clip. Shared by the
 * bake and by a full log render, so the two can never disagree about what attaching means. */
export async function attachInto(document: Document, log: AnimationLog): Promise<AttachmentResult> {
  const posed = replayOps(log);
  const reader = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const attached = await reader().read(posed.attached);
  const anchor = document
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === posed.anchor.node);
  if (anchor === undefined)
    throw new Error(`The host has no bone named '${posed.anchor.node}' to attach to.`);

  const stem = path.parse(posed.attached).name;
  const node = copyScene(document, `attach-${stem}`, attached);
  anchor.addChild(node);

  // Only `$default` seeds the static transform: it is the track the calibrator keeps for clips the
  // log never mentions. Picking any clip's first key would leave the prop somewhere arbitrary.
  const base = posed.poses[DEFAULT_CLIP_KEY];
  const firstFrame = [...(base?.keyframes ?? [])].sort((left, right) => left.time - right.time)[0];
  if (firstFrame !== undefined) {
    const sample = transformValues(firstFrame.transform);
    node.setTranslation(sample.translation).setRotation(sample.rotation).setScale(sample.scale);
  }

  const clips: string[] = [];
  const detached: string[] = [];
  for (const animation of document.getRoot().listAnimations()) {
    const name = animation.getName();
    const track = posed.poses[name];
    if (track === undefined || track.keyframes.length === 0) continue;
    // A released clip gets no attachment track: the prop is no longer the bone's child in the
    // game's mind, and where it goes is physics. Writing the last held offset would claim it stays
    // in the hand, which is the one thing the recipe says it does not do.
    if (track.attachment === "detached") {
      detached.push(name);
      continue;
    }
    clips.push(name);
    writeTrack(document, animation, node, track);
  }
  return {
    anchor: anchor.getName(),
    attached: posed.attached,
    clips,
    detached,
    node: node.getName(),
  };
}

export async function bakeAttachment(log: AnimationLog, outputFile: string): Promise<BakeResult> {
  const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(log.host);
  const attached = await attachInto(document, log);
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(outputFile, document);
  return { ...attached, file: path.resolve(outputFile) };
}
