import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { cookTerrainWorld } from "../src/world/terrain-world.js";

async function prepared() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const texture = doc
    .createTexture()
    .setImage(new Uint8Array([1, 2, 3]))
    .setMimeType("image/png");
  const mesh = doc
    .createMesh()
    .addPrimitive(
      doc
        .createPrimitive()
        .setAttribute("POSITION", positions)
        .setMaterial(doc.createMaterial().setBaseColorTexture(texture)),
    );
  const terrain = doc.createNode("terrain").setMesh(mesh);
  const prop = doc
    .createNode("prop")
    .setMesh(mesh)
    .setTranslation([12, 100, -4])
    .setScale([2, 0.5, 1.5])
    .setExtras({ placementId: "pine:0", assetId: "pine" });
  const water = doc.createNode("water:river").setMesh(mesh);
  const root = doc
    .createNode("terrain-world")
    .setExtras({ terrainRevision: "a".repeat(64) })
    .addChild(terrain)
    .addChild(prop)
    .addChild(water);
  const scene = doc.createScene().addChild(root);
  doc.getRoot().setDefaultScene(scene);
  const encoded = await new NodeIO().writeJSON(doc);
  // Match Three's browser JSON serialization, including embedded resources.
  for (const entry of [...(encoded.json.buffers ?? []), ...(encoded.json.images ?? [])]) {
    if (!entry.uri) continue;
    entry.uri = `data:${"mimeType" in entry ? entry.mimeType : "application/octet-stream"};base64,${Buffer.from(encoded.resources[entry.uri] ?? []).toString("base64")}`;
  }
  return encoded.json as unknown as Record<string, unknown>;
}

describe("portable terrain editor cook", () => {
  it("keeps ordinary placement transforms, water, shared meshes and embedded maps", async () => {
    const { worldGlb } = await cookTerrainWorld({ preparedWorld: await prepared() });
    const json = (await new NodeIO().binaryToJSON(worldGlb)).json;
    expect(json.extensionsRequired ?? []).not.toContain("EXT_mesh_gpu_instancing");
    expect(json.nodes?.find((node) => node.extras?.placementId === "pine:0")?.translation).toEqual([
      12, 100, -4,
    ]);
    expect(json.nodes?.find((node) => node.name === "prop")?.scale).toEqual([2, 0.5, 1.5]);
    expect(json.nodes?.some((node) => node.name === "water:river")).toBe(true);
    expect(json.nodes?.find((node) => node.name === "terrain-world")?.extras?.terrainRevision).toBe(
      "a".repeat(64),
    );
    expect(json.meshes).toHaveLength(1);
    expect(json.images).toHaveLength(1);
    expect(json.images?.[0]?.uri).toBeUndefined();
  });
  it("rejects external resources, empty content and nonportable required extensions", async () => {
    const json = await prepared();
    await expect(
      cookTerrainWorld({
        preparedWorld: { ...json, buffers: [{ uri: "file:///etc/passwd", byteLength: 36 }] },
      }),
    ).rejects.toThrow("embedded");
    await expect(
      cookTerrainWorld({
        preparedWorld: { ...json, images: [{ uri: "http://localhost/private" }] },
      }),
    ).rejects.toThrow("embedded");
    await expect(cookTerrainWorld({ preparedWorld: {} })).rejects.toThrow("nonempty");
    await expect(
      cookTerrainWorld({
        preparedWorld: { ...json, extensionsRequired: ["EXT_mesh_gpu_instancing"] },
      }),
    ).rejects.toThrow("nonportable");
  });
});
