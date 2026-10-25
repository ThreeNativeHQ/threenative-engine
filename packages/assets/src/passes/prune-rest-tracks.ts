import type { Animation, AnimationChannel, Document, Node } from "@gltf-transform/core";

/**
 * Drops animation tracks that only hold the pose the node already has.
 *
 * A DCC export writes one track per bone per clip, moving or not. A track whose every keyframe
 * equals the node's own translation, rotation or scale drives nothing: three's mixer blends a
 * missing track with the node's saved pose, which is the same value. Each dropped track is a
 * channel, a sampler and an accessor of JSON the player downloads and parses (measured: 50% of the
 * tracks of the combat mannequin, 57% of its file as JSON).
 *
 * Timing is gameplay, so nothing here resamples and nothing shortens a clip: a track is kept when
 * it is the only one that reaches the clip's last keyframe, and a clip keeps at least one track.
 */

const COMPONENTS = { rotation: 4, scale: 3, translation: 3 } as const;
type TrackPath = keyof typeof COMPONENTS;

/** Float32 round-off only. The cook's own quantization is looser; this runs before it. */
export const REST_TOLERANCE = 1e-6;

export interface IRestTrackSummary {
  readonly dropped: number;
  readonly total: number;
}

function restOf(node: Node, path: TrackPath): readonly number[] {
  if (path === "rotation") return node.getRotation();
  return path === "translation" ? node.getTranslation() : node.getScale();
}

function holdsRest(channel: AnimationChannel): boolean {
  const path = channel.getTargetPath() as TrackPath | null;
  const node = channel.getTargetNode();
  const output = channel.getSampler()?.getOutput();
  if (path === null || !(path in COMPONENTS) || node === null || !output) return false;
  const rest = restOf(node, path);
  const element = new Array<number>(COMPONENTS[path]).fill(0);
  for (let key = 0; key < output.getCount(); key += 1) {
    output.getElement(key, element);
    if (element.some((value, c) => Math.abs(value - (rest[c] ?? 0)) > REST_TOLERANCE)) return false;
  }
  return output.getCount() > 0;
}

const lastKey = (channel: AnimationChannel): number => {
  const input = channel.getSampler()?.getInput();
  return input === null || input === undefined ? 0 : (input.getMax([0])[0] ?? 0);
};

function dropChannel(animation: Animation, channel: AnimationChannel): void {
  const sampler = channel.getSampler();
  animation.removeChannel(channel);
  channel.dispose();
  const shared = sampler
    ?.listParents()
    .some((parent) => parent !== animation && parent.propertyType === "AnimationChannel");
  if (sampler === null || sampler === undefined || shared === true) return;
  animation.removeSampler(sampler);
  sampler.dispose();
}

export function pruneRestPoseTracks(document: Document, logicalPath?: string): IRestTrackSummary {
  let dropped = 0;
  let total = 0;
  for (const animation of document.getRoot().listAnimations()) {
    const kept = new Set(animation.listChannels());
    total += kept.size;
    const duration = Math.max(0, ...[...kept].map(lastKey));
    for (const channel of animation.listChannels()) {
      if (kept.size === 1 || !holdsRest(channel)) continue;
      kept.delete(channel);
      if (Math.max(0, ...[...kept].map(lastKey)) < duration) kept.add(channel);
      else {
        dropChannel(animation, channel);
        dropped += 1;
      }
    }
  }
  if (dropped > 0 && logicalPath !== undefined)
    console.log(
      `animation ${logicalPath}: dropped ${String(dropped)} of ${String(total)} tracks that hold the rest pose`,
    );
  return { dropped, total };
}
