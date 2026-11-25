import { readFile } from "node:fs/promises";
import { type Mesh, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { buildFrontier, frontierAccent } from "../src/frontier.js";
import { bakeFrontier, environmentElements } from "../src/index.js";

describe("Frontier Kit", () => {
  it("exposes its eight independently bakeable stories through the shared library", async () => {
    const root = await makeTempDir("tn-frontier-");
    const rows = environmentElements({ kind: "frontier" });
    expect(rows.map(({ id }) => id)).toEqual([
      "frontier-command",
      "frontier-depot",
      "frontier-processor",
      "frontier-generator",
      "frontier-relay",
      "frontier-ore",
      "frontier-landing-pad",
      "frontier-outpost",
    ]);
    const catalog = (await proceduralEnvironmentSource({ root }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "frontier")).toMatchObject(
      rows.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const { id } of rows) {
      const [asset] = await bakeFrontier({ module: id, out: root });
      if (!asset) throw new Error(`No GLB for ${id}`);
      const data = await readFile(asset.path);
      expect(data.readUInt32LE(0)).toBe(0x46546c67);
      expect(data.readUInt32LE(8)).toBe(data.length);
      expect(asset.bounds.min[1]).toBeCloseTo(0);
      expect(asset.triangles).toBeGreaterThan(24);
    }
  });

  it("seats every crystal into the rocky bed for different seeds", () => {
    const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
    for (const seed of [1, 7, 19, 43]) {
      const ore = buildFrontier("ore", { accent: frontierAccent, seed, scale: 1 });
      const rock = ore.getObjectByName("Frontier slate aggregate") as Mesh;
      const crystal = ore.getObjectByName("Frontier cobalt ore") as Mesh;
      const points = crystal.geometry.getAttribute("position");
      const verticesPerCrystal = points.count / 7;
      for (let start = 0; start < points.count; start += verticesPerCrystal) {
        let bottom = start;
        for (let i = start + 1; i < start + verticesPerCrystal; i++)
          if (points.getY(i) < points.getY(bottom)) bottom = i;
        ray.ray.origin.set(points.getX(bottom), 3, points.getZ(bottom));
        const contact = ray.intersectObject(rock)[0];
        expect(contact?.point.y).toBeGreaterThan(points.getY(bottom) + 0.18);
      }
    }
  });

  it("scales dimensions, recolors paint, and writes deterministic, distinct files", async () => {
    const out = await makeTempDir("tn-frontier-options-");
    const module = "frontier-command";
    const [base] = await bakeFrontier({ module, out });
    const options = { module, accent: "#EA6B36", scale: 1.5 };
    const [custom] = await bakeFrontier({ ...options, out });
    const [again] = await bakeFrontier({ ...options, out: `${out}/repeat` });
    if (!base || !custom || !again) throw new Error("Missing Frontier Kit GLB");
    expect(custom.path).toMatch(/frontier-command-1-ea6b36-s1\.5\.glb$/);
    expect(custom.bounds.max[1]).toBeCloseTo(base.bounds.max[1] * 1.5);
    expect(custom.triangles).toBe(base.triangles);
    const glb = await readFile(custom.path);
    expect(glb).toEqual(await readFile(again.path));
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
    const paint = json.materials.find(
      ({ name }: { name: string }) => name === "Frontier team paint",
    );
    expect(paint.pbrMetallicRoughness.baseColorFactor[0]).toBeGreaterThan(
      paint.pbrMetallicRoughness.baseColorFactor[2],
    );
    await expect(bakeFrontier({ module, scale: 0, out })).rejects.toThrow(/scale/i);
    await expect(bakeFrontier({ module: "../command", out })).rejects.toThrow(/unknown module/i);
  });
});
