import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutSpecDefaults } from "../src/passes/glb-spec-defaults.js";
import { modelPass } from "../src/passes/model.js";

/**
 * gltf-transform writes `"normalized":false`, `"byteOffset":0` and `"interpolation":"LINEAR"` on
 * every accessor and sampler. The glTF specification defines each of them as the default, so a
 * reader sees the same file without them. The animated mannequins carry thousands.
 */

const MANNEQUIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../create-threenative/template-assets/assets/mannequin.glb",
);

async function glb(): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (values: number[], type: "SCALAR" | "VEC3") =>
    document.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
  const node = document.createNode("n");
  const animation = document.createAnimation("a");
  const sampler = document
    .createAnimationSampler()
    .setInput(accessor([0, 1], "SCALAR"))
    .setOutput(accessor([0, 0, 0, 1, 1, 1], "VEC3"));
  animation.addSampler(sampler);
  animation.addChannel(
    document
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(node)
      .setTargetPath("translation"),
  );
  document.createScene("s").addChild(node);
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/** The file as gltf-transform's meshopt path writes it: every default spelled out. */
function spelledOut(binary: Buffer): Buffer {
  const length = binary.readUInt32LE(12);
  const json = JSON.parse(binary.subarray(20, 20 + length).toString("utf8"));
  for (const accessor of json.accessors) {
    accessor.normalized ??= false;
    accessor.byteOffset ??= 0;
  }
  for (const animation of json.animations)
    for (const sampler of animation.samplers) sampler.interpolation ??= "LINEAR";
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const rest = binary.subarray(20 + length);
  const head = Buffer.from(binary.subarray(0, 20));
  head.writeUInt32LE(20 + padded.length + rest.length, 8);
  head.writeUInt32LE(padded.length, 12);
  return Buffer.concat([head, padded, rest]);
}

const jsonOf = (binary: Buffer) =>
  JSON.parse(binary.subarray(20, 20 + binary.readUInt32LE(12)).toString("utf8"));

describe("withoutSpecDefaults", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should drop the fields the specification defines as the default", async () => {
    const before = spelledOut(await glb());
    expect(JSON.stringify(jsonOf(before))).toContain('"normalized":false');
    expect(JSON.stringify(jsonOf(before))).toContain('"interpolation":"LINEAR"');
    const after = withoutSpecDefaults(before);
    const text = JSON.stringify(jsonOf(after));
    expect(text).not.toContain('"normalized":false');
    expect(text).not.toContain('"interpolation":"LINEAR"');
    expect(text).not.toContain('"byteOffset":0');
    expect(after.length).toBeLessThan(before.length);
  });

  it("should keep the GLB valid: header length, 4-byte chunks and the binary chunk untouched", async () => {
    const before = spelledOut(await glb());
    const after = withoutSpecDefaults(before);
    expect(after.readUInt32LE(8)).toBe(after.length);
    const jsonLength = after.readUInt32LE(12);
    expect(jsonLength % 4).toBe(0);
    const binary = (glb: Buffer) => glb.subarray(20 + glb.readUInt32LE(12));
    expect(binary(after).equals(binary(before))).toBe(true);
  });

  it("should read back as the same document: same accessors, samplers and values", async () => {
    const io = new NodeIO();
    const [a, b] = [
      await io.readBinary(await glb()),
      await io.readBinary(withoutSpecDefaults(spelledOut(await glb()))),
    ];
    const accessors = (document: Document) =>
      document
        .getRoot()
        .listAccessors()
        .map((x) => [x.getType(), x.getNormalized(), Array.from(x.getArray() ?? [])]);
    expect(accessors(b)).toEqual(accessors(a));
    const modes = (document: Document) =>
      document
        .getRoot()
        .listAnimations()
        .flatMap((x) => x.listSamplers().map((s) => s.getInterpolation()));
    expect(modes(b)).toEqual(modes(a));
  });

  it("should keep a non-default value: normalized true survives", async () => {
    const document = new Document();
    const buffer = document.createBuffer();
    document
      .createAccessor()
      .setBuffer(buffer)
      .setType("VEC3")
      .setNormalized(true)
      .setArray(new Int8Array([1, 2, 3]));
    const out = jsonOf(withoutSpecDefaults(Buffer.from(await new NodeIO().writeBinary(document))));
    expect(out.accessors[0].normalized).toBe(true);
  });
});

describe("the model pass output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should ship no spec-default fields in a real animated model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await modelPass({}).apply(readFileSync(MANNEQUIN), "mannequin.glb");
    if (Buffer.isBuffer(result)) throw new Error("the pass left the mannequin untouched");
    const text = JSON.stringify(jsonOf(result.buffer));
    expect(text).not.toContain('"normalized":false');
    expect(text).not.toContain('"interpolation":"LINEAR"');
  });
});
