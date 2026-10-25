import { NodeIO } from "@gltf-transform/core";
import type { Accessor, Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFixtureDocument } from "../../../test-support/generate-fixture-model.js";
import { modelPass } from "../src/passes/model.js";

/**
 * The animation fidelity floor (PRD-729). A cook may shrink animation bytes only while every
 * keyframe time survives bit for bit (the pass never resamples; timing is gameplay) and every
 * decoded rotation and translation stays inside the error the cook has today.
 */

const KEYS = 96;
const io = () =>
  new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

function denseClip(document: Document) {
  const root = document.getRoot();
  const buffer = root.listBuffers()[0];
  const node = root.listAnimations()[0]?.listChannels()[0]?.getTargetNode();
  if (buffer === undefined || node === undefined) throw new Error("fixture lost its clip");
  const accessor = (name: string, array: Float32Array, type: "SCALAR" | "VEC3" | "VEC4") =>
    document.createAccessor(name).setBuffer(buffer).setType(type).setArray(array);
  const times = new Float32Array(KEYS).map((_, key) => key / 30);
  const rotations = new Float32Array(KEYS * 4);
  const translations = new Float32Array(KEYS * 3);
  for (let key = 0; key < KEYS; key += 1) {
    const half = 0.45 * Math.sin(key / 7) + 0.3 * Math.cos(key / 3);
    rotations.set([0, Math.sin(half), 0, Math.cos(half)], key * 4);
    translations.set([1.7 * Math.sin(key / 9), 1 + 0.4 * Math.cos(key / 7), 0.031 * key], key * 3);
  }
  const clip = document.createAnimation("dense");
  const track = (path: "rotation" | "translation", output: Accessor) => {
    const sampler = document
      .createAnimationSampler(`dense-${path}`)
      .setInput(accessor(`dense-${path}-times`, times, "SCALAR"))
      .setOutput(output)
      .setInterpolation("LINEAR");
    clip.addSampler(sampler);
    clip.addChannel(
      document
        .createAnimationChannel(`dense-${path}`)
        .setSampler(sampler)
        .setTargetNode(node)
        .setTargetPath(path),
    );
  };
  track("rotation", accessor("dense-rotations", rotations, "VEC4"));
  track("translation", accessor("dense-translations", translations, "VEC3"));
  return { times, rotations, translations };
}

/** `getElement` de-normalizes: the raw array of a normalized accessor holds integers. */
function elements(accessor: Accessor | null | undefined, size: number): number[][] {
  expect(accessor?.getCount()).toBe(KEYS);
  return Array.from(
    { length: KEYS },
    (_, key) => accessor?.getElement(key, new Array(size).fill(0)) ?? [],
  );
}

function worstDegrees(accessor: Accessor | null | undefined, source: Float32Array): number {
  return elements(accessor, 4).reduce((worst, decoded, key) => {
    const dot = decoded.reduce((sum, value, c) => sum + value * (source[key * 4 + c] ?? 0), 0);
    return Math.max(worst, (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI);
  }, 0);
}

function worstMetres(accessor: Accessor | null | undefined, source: Float32Array): number {
  return elements(accessor, 3).reduce(
    (worst, decoded, key) =>
      decoded.reduce(
        (inner, value, c) => Math.max(inner, Math.abs(value - (source[key * 3 + c] ?? 0))),
        worst,
      ),
    0,
  );
}

async function cook() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const document = buildFixtureDocument({ textured: false });
  const source = denseClip(document);
  const input = Buffer.from(await new NodeIO().writeBinary(document));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const result = await modelPass().apply(input, "dense.glb");
  if (Buffer.isBuffer(result)) throw new Error("the pass left the model untouched");
  return { source, result: result.buffer };
}

describe("modelPass animation filters", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should keep every keyframe time exact and every decoded value inside the fidelity floor", async () => {
    const { source, result } = await cook();
    const root = (await io().readBinary(result)).getRoot();
    const clip = root.listAnimations().find((animation) => animation.getName() === "dense");
    const sampler = (path: string) =>
      clip
        ?.listChannels()
        .find((channel) => channel.getTargetPath() === path)
        ?.getSampler();
    const rotation = sampler("rotation");
    const translation = sampler("translation");
    expect(Array.from(rotation?.getInput()?.getArray() ?? [])).toEqual(Array.from(source.times));
    expect(Array.from(translation?.getInput()?.getArray() ?? [])).toEqual(Array.from(source.times));
    // The floor is today's cook: 0.041 degrees and 0 m worst. Meshopt's FILTER method measured
    // 0.712 degrees (a 12 mm limb-tip error) and 0.97 mm, so PRD-729 rejected it for 8% of the bytes.
    expect(worstDegrees(rotation?.getOutput(), source.rotations)).toBeLessThan(0.05);
    expect(worstMetres(translation?.getOutput(), source.translations)).toBeLessThan(0.0001);
  });
});
