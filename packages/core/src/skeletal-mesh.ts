import type { AnimationClip, Object3D } from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { AnimationPlayer } from "./animation.js";
import { rigPreparation } from "./rig-preparation.js";
import { type INormaliseToMetresOptions, normaliseToMetres } from "./scale.js";

export interface ISkeletalMesh3DOptions {
  readonly source: Object3D;
  readonly clips?: readonly AnimationClip[];
  readonly requiredClips?: readonly string[] | Readonly<Record<string, string>>;
  readonly size?: INormaliseToMetresOptions;
  readonly strideRoot?: Object3D;
  readonly strideSync?: boolean;
  readonly updateRate?: "auto" | number;
  readonly gpuPose?: boolean;
}

export class SkeletalMesh3D extends AnimationPlayer {
  constructor(options: ISkeletalMesh3DOptions) {
    if (!options?.source) throw new Error("SkeletalMesh3D requires a source Object3D.");
    const root = cloneSkeleton(options.source);
    const clips = options.clips ?? [];
    super({
      clips,
      requiredClips: options.requiredClips,
      root,
      strideRoot: options.strideRoot ?? root,
      strideSync: options.strideSync,
      updateRate: options.updateRate,
      gpuPose: options.gpuPose,
      preparation: rigPreparation(options.source),
    });
    if (options.size !== undefined) {
      normaliseToMetres(root, mapSizeToClone(options.source, root, options.size));
    }
  }
}

function mapSizeToClone(
  source: Object3D,
  clone: Object3D,
  size: INormaliseToMetresOptions,
): INormaliseToMetresOptions {
  const requestedTop = size.top;
  if (requestedTop === undefined || typeof requestedTop === "string") return size;

  const path: number[] = [];
  let current: Object3D = requestedTop;
  while (current !== source) {
    const parent = current.parent;
    if (parent === null) return size;
    const index = parent.children.indexOf(current);
    if (index < 0) return size;
    path.push(index);
    current = parent;
  }

  let mappedTop = clone;
  for (const index of path.reverse()) {
    const child = mappedTop.children[index];
    if (child === undefined) return size;
    mappedTop = child;
  }
  return { ...size, top: mappedTop };
}
