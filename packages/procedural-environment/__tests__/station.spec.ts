import { readFile } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeStation, environmentElements } from "../src/index.js";
import { buildStation } from "../src/station.js";

describe("station kit", () => {
  it("exposes all station bakes in the shared Asset Library", async () => {
    const root = await makeTempDir("tn-station-catalog-");
    const catalog = (await proceduralEnvironmentSource({ root }).catalog()) as {
      elements: ReturnType<typeof environmentElements>;
      kinds: Record<string, unknown>;
    };
    const rows = environmentElements({ kind: "station" });
    expect(rows.map(({ id }) => id)).toEqual([
      "station-floor",
      "station-wall",
      "station-bulkhead",
      "station-ceiling",
      "station-straight",
      "station-elbow",
      "station-tee",
      "station-cross",
      "station-cargo",
      "station-terminal",
      "station-power-cell",
      "station-layout",
    ]);
    expect(environmentElements({ search: "station corridor" })).toContainEqual(rows[4]);
    expect(catalog.kinds.station).toBeDefined();
    expect(catalog.elements.filter(({ kind }) => kind === "station")).toMatchObject(rows);
  });

  it("writes grounded PBR GLBs with matching 4 m corridor sockets", async () => {
    const out = await makeTempDir("tn-station-bakes-");
    for (const { id } of environmentElements({ kind: "station" })) {
      const [entry] = await bakeStation({ module: id, out, seed: 4 });
      if (!entry) throw new Error(`Missing bake for ${id}`);
      const bytes = await readFile(entry.path);
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      expect(bytes.readUInt32LE(8)).toBe(bytes.length);
      expect(entry.bounds.min[1]).toBeCloseTo(0);
      expect(entry.triangles).toBeGreaterThan(30);
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
      expect(gltf.materials.every((material: object) => "pbrMetallicRoughness" in material)).toBe(
        true,
      );
      if (id === "station-straight") {
        expect(entry.bounds.min[2]).toBe(-2);
        expect(entry.bounds.max[2]).toBe(2);
        expect(gltf.nodes[0].extras.sockets).toEqual(["north", "south"]);
        const [again] = await bakeStation({ module: id, out: `${out}/again`, seed: 4 });
        expect(await readFile(again?.path ?? "")).toEqual(bytes);
      }
    }
  });

  it("rejects unknown modules and unsafe seeds", async () => {
    const out = await makeTempDir("tn-station-invalid-");
    await expect(bakeStation({ module: "../station-wall", out })).rejects.toThrow(
      /unknown module/i,
    );
    await expect(
      bakeStation({ module: "station-wall", seed: Number.POSITIVE_INFINITY, out }),
    ).rejects.toThrow(/seed/i);
    await expect(bakeStation({ module: "station-wall", roof: true, out })).rejects.toThrow(/roof/i);
    await expect(bakeStation({ module: "station-wall", accent: "teal", out })).rejects.toThrow(
      /accent/i,
    );
  });

  it("keeps each corridor within the grid, and opens only the declared sides", () => {
    const directions = {
      north: new Vector3(0, 0, -1),
      east: new Vector3(1, 0, 0),
      south: new Vector3(0, 0, 1),
      west: new Vector3(-1, 0, 0),
    };
    for (const id of ["straight", "elbow", "tee", "cross"] as const) {
      const group = buildStation(id, { seed: 4, accent: "#25b9c8", roof: false });
      const bounds = new Box3().setFromObject(group, true);
      const size = bounds.getSize(new Vector3());
      expect(size.x).toBeCloseTo(4);
      expect(size.z).toBeCloseTo(4);
      const ray = new Raycaster(new Vector3(0, 1.5, 0), undefined, 0, 2.01);
      const open = Object.entries(directions)
        .filter(([, direction]) => {
          ray.ray.direction.copy(direction);
          return ray.intersectObject(group).length === 0;
        })
        .map(([side]) => side);
      expect(open).toEqual(group.userData.sockets);
    }
  });

  it("bakes custom paint and a ceiling without colliding with the default filename", async () => {
    const out = await makeTempDir("tn-station-options-");
    const [plain] = await bakeStation({ module: "station-elbow", out });
    const [custom] = await bakeStation({
      module: "station-elbow",
      accent: "#EE9955",
      roof: true,
      out,
    });
    if (!plain || !custom) throw new Error("Missing station bake");
    expect(custom.path).toMatch(/station-elbow-1-ee9955-roof\.glb$/);
    expect(custom.bounds.max[1]).toBeGreaterThan(plain.bounds.max[1]);
    expect(custom.triangles).toBeGreaterThan(plain.triangles);
    const bytes = await readFile(custom.path);
    const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    const light = gltf.materials.find(
      ({ name }: { name: string }) => name === "Station light strips",
    );
    expect(light.emissiveFactor[0]).toBeGreaterThan(light.emissiveFactor[2]);
  });
});
