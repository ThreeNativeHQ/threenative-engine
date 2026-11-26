import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakePickup, environmentElements } from "../src/index.js";

describe("Pickups", () => {
  it("publishes each pickup as a grounded, opaque PBR asset and an Asset Library story", async () => {
    const root = await makeTempDir("tn-pickups-");
    const rows = environmentElements({ kind: "pickup" });
    expect(rows.map(({ id }) => id)).toEqual([
      "pickup-medkit",
      "pickup-potion",
      "pickup-keycard",
      "pickup-shield",
      "pickup-vault-key",
      "pickup-scroll",
      "pickup-repair-tool",
    ]);
    const catalog = (await proceduralEnvironmentSource({ root }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "pickup")).toMatchObject(
      rows.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const { id } of rows) {
      const [result] = await bakePickup({ module: id, out: root });
      if (!result) throw new Error(`No pickup bake for ${id}`);
      const bytes = await readFile(result.path);
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      expect(bytes.readUInt32LE(8)).toBe(bytes.length);
      expect(result.bounds.min[1]).toBeCloseTo(0);
      expect(result.triangles).toBeLessThan(2500);
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
      expect(gltf.materials.length).toBeGreaterThan(1);
      for (const material of gltf.materials) {
        expect(material.alphaMode ?? "OPAQUE").toBe("OPAQUE");
        expect(material.pbrMetallicRoughness).toBeDefined();
      }
    }
  });

  it("lays the four thin props face-up while keeping them grounded", async () => {
    const out = await makeTempDir("tn-pickup-flat-");
    for (const id of ["keycard", "shield", "vault-key", "repair-tool"]) {
      const module = `pickup-${id}`;
      const [standing] = await bakePickup({ module, out });
      const [flat] = await bakePickup({ module, out, pose: "flat", scale: 1.5 });
      if (!standing || !flat) throw new Error(`Missing bake for ${module}`);
      const depth = standing.bounds.max[2] - standing.bounds.min[2];
      const height = standing.bounds.max[1] - standing.bounds.min[1];
      expect(flat.bounds.min[1]).toBeCloseTo(0);
      expect(flat.bounds.max[1]).toBeCloseTo(depth * 1.5);
      expect(flat.bounds.max[2] - flat.bounds.min[2]).toBeCloseTo(height * 1.5);
      expect(flat.path).toMatch(/-s1\.5-flat\.glb$/);
    }
    await expect(bakePickup({ module: "pickup-potion", out, pose: "flat" })).rejects.toThrow(
      /pose/i,
    );
  });

  it("recolors and scales the same model, with deterministic and distinct output names", async () => {
    const out = await makeTempDir("tn-pickup-options-");
    const module = "pickup-medkit";
    const [base] = await bakePickup({ module, out });
    const [custom] = await bakePickup({ module, out, accent: "#ED5166", scale: 2 });
    const [again] = await bakePickup({ module, out: `${out}/repeat`, accent: "#ed5166", scale: 2 });
    if (!base || !custom || !again) throw new Error("Missing pickup bake");
    expect(custom.path).toMatch(/pickup-medkit-1-ed5166-s2\.glb$/);
    expect(custom.bounds.max[1]).toBeCloseTo(base.bounds.max[1] * 2);
    expect(custom.triangles).toBe(base.triangles);
    const bytes = await readFile(custom.path);
    expect(bytes).toEqual(await readFile(again.path));
    const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    const paint = gltf.materials.find(({ name }: { name: string }) => name === "Pickup accent");
    expect(paint.pbrMetallicRoughness.baseColorFactor[0]).toBeGreaterThan(
      paint.pbrMetallicRoughness.baseColorFactor[1],
    );
    await expect(bakePickup({ module, out, scale: 3 })).rejects.toThrow(/scale/i);
    await expect(bakePickup({ module: "../medkit", out })).rejects.toThrow(/unknown module/i);
  });
});
