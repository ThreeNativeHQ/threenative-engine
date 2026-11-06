import { Document } from "@gltf-transform/core";
import { KHRLightsPunctual } from "@gltf-transform/extensions";
import { describe, expect, it } from "vitest";
import { bakeStaticLightmap } from "../src/passes/lightmap-bake.js";

function primitive(
  document: Document,
  name: string,
  positions: readonly number[],
  uv2: readonly number[],
) {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("static-light");
  const vertexCount = positions.length / 3;
  const geometry = document
    .createPrimitive()
    .setIndices(
      document
        .createAccessor(`${name}-indices`)
        .setType("SCALAR")
        .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
        .setBuffer(buffer),
    )
    .setAttribute(
      "POSITION",
      document
        .createAccessor(`${name}-positions`)
        .setType("VEC3")
        .setArray(new Float32Array(positions))
        .setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor(`${name}-normals`)
        .setType("VEC3")
        .setArray(new Float32Array(Array.from({ length: vertexCount }, () => [0, 0, 1]).flat()))
        .setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_1",
      document
        .createAccessor(`${name}-uv2`)
        .setType("VEC2")
        .setArray(new Float32Array(uv2))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial(name));
  return document.createMesh(name).addPrimitive(geometry);
}

function blockerScene(receiverUv: readonly number[]): Document {
  const document = new Document();
  const scene = document.createScene("scene");
  scene.addChild(
    document
      .createNode("receiver")
      .setMesh(
        primitive(document, "receiver", [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], receiverUv),
      ),
  );
  scene.addChild(
    document
      .createNode("blocker")
      .setMesh(
        primitive(
          document,
          "blocker",
          [-1, -1, 1, 0, -1, 1, 0, 1, 1, -1, 1, 1],
          [0, 0, 0, 0, 0, 0, 0, 0],
        ),
      ),
  );
  const extension = document.createExtension(KHRLightsPunctual);
  const light = extension.createLight("sun").setType("directional").setIntensity(1);
  scene.addChild(document.createNode("sun").setExtension("KHR_lights_punctual", light));
  return document;
}

describe("bakeStaticLightmap", () => {
  it("casts blocker occlusion instead of writing a flat fill", async () => {
    const result = await bakeStaticLightmap(blockerScene([0, 0, 1, 0, 1, 1, 0, 1]), 16, 16, 0);
    const left = result.pixels[(8 * 16 + 3) * 4];
    const right = result.pixels[(8 * 16 + 12) * 4];

    expect(result.occludedTexels).toBeGreaterThan(0);
    expect(left).toBe(0);
    expect(right).toBe(255);
  });

  it("dilates populated chart texels into empty borders", async () => {
    const result = await bakeStaticLightmap(
      blockerScene([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]),
      16,
      16,
      2,
    );
    let populated = 0;
    for (let offset = 3; offset < result.pixels.length; offset += 4) {
      if (result.pixels[offset] === 255) populated += 1;
    }

    expect(result.dilatedTexels).toBeGreaterThan(0);
    expect(populated).toBe(result.validTexels + result.dilatedTexels);
  });
});
