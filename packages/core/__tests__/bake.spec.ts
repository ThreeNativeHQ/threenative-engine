import { readFile } from "node:fs/promises";
import path from "node:path";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  addPart,
  createEmissiveMaterial,
  createPbrMaterial,
  exportProceduralGlb,
  prepareDonorWithoutMaterials,
} from "../src/bake.js";

function glbJson(bytes: Buffer): {
  asset: Record<string, unknown>;
  materials: { name: string }[];
  meshes: unknown[];
} {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  return JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
}

describe("@threenative/core/bake", () => {
  it("writes a grounded, merged, procedural-stamped binary glb from Node", async () => {
    const dir = await makeTempDir("tn-bake-");
    const out = path.join(dir, "assets", "lamp.glb");
    const paint = createPbrMaterial(0xcc2222, { metalness: 0.5, name: "paint" });
    const neon = createEmissiveMaterial(0x33ffee, 2, { name: "neon" });
    const root = new Group();
    addPart(root, new BoxGeometry(1, 1, 1), paint, { position: [0, 5.5, 0] });
    addPart(root, new BoxGeometry(1, 1, 1), paint, { position: [2, 6.5, 0] });
    addPart(root, new SphereGeometry(0.5, 8, 6), neon, { position: [0, 7.5, 0] });

    const receipt = await exportProceduralGlb(root, out, { prompt: "test lamp" });

    expect(receipt).toMatchObject({
      drawGroups: 2,
      materials: ["paint", "neon"],
      minY: 0,
      path: out,
    });
    expect(receipt.triangles).toBe(12 + 12 + 80);
    expect(receipt.size[1]).toBeCloseTo(3);
    const json = glbJson(await readFile(out));
    expect(json.asset.extras).toEqual({ tnOrigin: "procedural", tnPrompt: "test lamp" });
    expect(json.meshes).toHaveLength(2);
    expect(json.materials.map(({ name }) => name).sort()).toEqual(["neon", "paint"]);
  });

  it("refuses an empty model and a model outside the bounds", async () => {
    const dir = await makeTempDir("tn-bake-");
    const out = path.join(dir, "x.glb");
    await expect(exportProceduralGlb(new Group(), out, { prompt: "empty" })).rejects.toThrow();
    const root = new Group();
    addPart(root, new BoxGeometry(50, 1, 1), createPbrMaterial(0xffffff));
    await expect(
      exportProceduralGlb(root, out, { prompt: "huge", validateBounds: { max: 10 } }),
    ).rejects.toThrow("outside");
  });

  it("repaints a donor with one material and drops its vertex colours", () => {
    const donor = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.geometry.setAttribute("color", mesh.geometry.getAttribute("position").clone());
    donor.add(mesh);
    const base = createPbrMaterial(0x888888, { name: "base" });
    prepareDonorWithoutMaterials(donor, base);
    expect(mesh.material).toBe(base);
    expect(mesh.geometry.getAttribute("color")).toBeUndefined();
  });
});
