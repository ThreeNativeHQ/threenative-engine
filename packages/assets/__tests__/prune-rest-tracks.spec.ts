import { Document } from "@gltf-transform/core";
import type { Animation, Node } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { pruneRestPoseTracks } from "../src/passes/prune-rest-tracks.js";

/**
 * A track that holds the pose its node already has drives nothing, so the cook drops it. Timing
 * is gameplay: a clip never gets shorter and never loses its last track.
 */

function scene() {
  const document = new Document();
  const buffer = document.createBuffer();
  const node = document
    .createNode("bone")
    .setTranslation([1, 2, 3])
    .setRotation([0, 0, 0, 1])
    .setScale([1, 1, 1]);
  const accessor = (values: number[], type: "SCALAR" | "VEC3" | "VEC4") =>
    document.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
  const track = (
    animation: Animation,
    target: Node,
    path: "rotation" | "scale" | "translation",
    times: number[],
    values: number[],
  ) => {
    const size = path === "rotation" ? "VEC4" : "VEC3";
    const sampler = document
      .createAnimationSampler()
      .setInput(accessor(times, "SCALAR"))
      .setOutput(accessor(values, size));
    animation.addSampler(sampler);
    const channel = document
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(target)
      .setTargetPath(path);
    animation.addChannel(channel);
    return channel;
  };
  return { document, node, track, animation: () => document.createAnimation("clip") };
}

const paths = (animation: Animation) =>
  animation.listChannels().map((channel) => channel.getTargetPath());

describe("pruneRestPoseTracks", () => {
  it("should drop a constant track at rest and keep moving and off-rest tracks", () => {
    const { document, node, track, animation } = scene();
    const clip = animation();
    track(clip, node, "translation", [0, 1], [1, 2, 3, 1, 2, 3]); // holds rest
    track(clip, node, "scale", [0, 1], [2, 2, 2, 2, 2, 2]); // constant, not rest
    track(clip, node, "rotation", [0, 1], [0, 0, 0, 1, 0, 0.5, 0, 0.5]); // moves
    const summary = pruneRestPoseTracks(document);
    expect(summary).toEqual({ dropped: 1, total: 3 });
    expect(paths(clip)).toEqual(["scale", "rotation"]);
    expect(clip.listSamplers()).toHaveLength(2);
  });

  it("should never shorten a clip: the only track reaching the last keyframe stays", () => {
    const { document, node, track, animation } = scene();
    const clip = animation();
    track(clip, node, "rotation", [0, 1], [0, 0, 0, 1, 0, 0.5, 0, 0.5]); // ends at 1 s
    track(clip, node, "translation", [0, 2], [1, 2, 3, 1, 2, 3]); // rest, but ends at 2 s
    expect(pruneRestPoseTracks(document).dropped).toBe(0);
    expect(paths(clip)).toEqual(["rotation", "translation"]);
  });

  it("should keep one track of a clip that holds the rest pose throughout", () => {
    const { document, node, track, animation } = scene();
    const clip = animation();
    track(clip, node, "translation", [0, 1], [1, 2, 3, 1, 2, 3]);
    track(clip, node, "scale", [0, 1], [1, 1, 1, 1, 1, 1]);
    expect(pruneRestPoseTracks(document).dropped).toBe(1);
    expect(clip.listChannels()).toHaveLength(1);
  });

  it("should keep a sampler another channel still reads", () => {
    const { document, node, track, animation } = scene();
    const clip = animation();
    track(clip, node, "rotation", [0, 1], [0, 0, 0, 1, 0, 0.5, 0, 0.5]);
    const held = track(clip, node, "translation", [0, 1], [1, 2, 3, 1, 2, 3]);
    const sampler = held.getSampler();
    if (sampler === null) throw new Error("fixture lost its sampler");
    const other = document
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(document.createNode("other").setTranslation([9, 9, 9]))
      .setTargetPath("translation");
    clip.addChannel(other);
    pruneRestPoseTracks(document);
    expect(clip.listSamplers()).toContain(sampler);
    expect(paths(clip)).toEqual(["rotation", "translation"]);
  });

  it("should report nothing and change nothing when every track moves", () => {
    const { document, node, track, animation } = scene();
    const clip = animation();
    track(clip, node, "translation", [0, 1], [1, 2, 3, 4, 5, 6]);
    expect(pruneRestPoseTracks(document)).toEqual({ dropped: 0, total: 1 });
  });
});
