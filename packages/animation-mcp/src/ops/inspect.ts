import { stat } from "node:fs/promises";
import { type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { type AnchorInfo, detectedAnchors } from "./landmarks.js";

export interface ClipReport {
  readonly channels: number;
  readonly duration: number;
  /** How far the root bone travelled horizontally over the clip, in the host's own units. */
  readonly horizontalTravel: number;
  readonly inPlace: boolean;
  readonly name: string;
}

export interface InspectReport {
  readonly bones: readonly string[];
  readonly bytes: number;
  readonly clips: readonly ClipReport[];
  readonly extensionsUsed: readonly string[];
  readonly file: string;
  readonly generator: string;
  readonly inPlace: boolean;
  readonly landmarks: readonly AnchorInfo[];
  readonly meshes: number;
  readonly rootBone: string | null;
  readonly skins: number;
  readonly warnings: readonly string[];
}

/** A clip whose root bone travels further than this is root motion, not an in-place cycle. It is
 * one centimetre because Mixamo, Quaternius and glTF metres all clear it, and because a planted
 * foot that slides further than that is the defect `animation_verify` reports. */
export const ROOT_MOTION_THRESHOLD = 0.01;

const reader = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Root motion is measured on the bone a game would move the character by: the first joint of the
 * first skin, which is the glTF skeleton root, else a node named like a pelvis. */
function rootBoneOf(document: Document): string | null {
  const joints = document
    .getRoot()
    .listSkins()
    .flatMap((skin) => skin.listJoints());
  const first = joints[0];
  if (first !== undefined) return first.getName();
  const named = document
    .getRoot()
    .listNodes()
    .find((node) => /hips|pelvis|root/iu.test(node.getName()));
  return named?.getName() ?? null;
}

function bounds(values: Float32Array): { max: number; min: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { max, min };
}

/** Pairs the translation samples of `rootBone` with their times, so a report can say which frames
 * moved the character rather than only that it moved. */
function rootTravel(document: Document, rootBone: string | null): Map<string, number> {
  const travel = new Map<string, number>();
  if (rootBone === null) return travel;
  for (const animation of document.getRoot().listAnimations()) {
    let farthest = 0;
    for (const channel of animation.listChannels()) {
      if (channel.getTargetNode()?.getName() !== rootBone) continue;
      if (channel.getTargetPath() !== "translation") continue;
      const values = channel.getSampler()?.getOutput()?.getArray();
      if (values === null || values === undefined || values.length < 6) continue;
      const origin = [values[0] ?? 0, values[2] ?? 0];
      for (let index = 0; index + 2 < values.length; index += 3) {
        const dx = (values[index] ?? 0) - origin[0];
        const dz = (values[index + 2] ?? 0) - (origin[1] ?? 0);
        farthest = Math.max(farthest, Math.hypot(dx, dz));
      }
    }
    travel.set(animation.getName(), farthest);
  }
  return travel;
}

export async function inspectModel(file: string): Promise<InspectReport> {
  const bytes = (await stat(file)).size;
  const document = await reader().read(file);
  const root = document.getRoot();
  const warnings: string[] = [];
  const skins = root.listSkins();
  const joints = skins.flatMap((skin) => skin.listJoints().map((joint) => joint.getName()));
  const nodes = root.listNodes().map((node) => node.getName());
  const bones = joints.length > 0 ? joints : nodes.filter((name) => name.length > 0);
  if (skins.length === 0) warnings.push("No skin: the model is not rigged.");
  if (root.listAnimations().length === 0) warnings.push("No animation clip: nothing to verify.");

  const rootBone = rootBoneOf(document);
  const travel = rootTravel(document, rootBone);
  const clips = root
    .listAnimations()
    .map((animation) => {
      let end = 0;
      for (const sampler of animation.listSamplers()) {
        const input = sampler.getInput()?.getArray();
        if (input !== undefined) end = Math.max(end, bounds(input).max);
      }
      const horizontalTravel = Math.round((travel.get(animation.getName()) ?? 0) * 10_000) / 10_000;
      return {
        channels: animation.listChannels().length,
        duration: Math.round(end * 10_000) / 10_000,
        horizontalTravel,
        inPlace: horizontalTravel <= ROOT_MOTION_THRESHOLD,
        name: animation.getName(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    bones,
    bytes,
    clips,
    extensionsUsed: [...root.listExtensionsUsed().map((extension) => extension.extensionName)].sort(
      (left, right) => left.localeCompare(right),
    ),
    file,
    generator: root.getAsset().generator ?? "",
    // The landmarks a rig answers to, by name only. A report never invents a position: the caller
    // that needs one asks the view, which measures.
    inPlace: clips.every((clip) => clip.inPlace),
    landmarks: detectedAnchors(bones),
    meshes: root.listMeshes().length,
    rootBone,
    skins: skins.length,
    warnings,
  };
}
