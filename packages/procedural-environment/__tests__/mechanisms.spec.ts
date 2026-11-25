import { readFile } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeMechanism, environmentElements } from "../src/index.js";
import { buildMechanism, mechanismAccent } from "../src/mechanisms.js";
import { buildStation, stationAccent } from "../src/station.js";

interface IGlb {
  nodes: { name?: string; matrix?: number[]; children?: number[] }[];
  materials: { name: string; emissiveFactor?: number[] }[];
}

async function readGlb(path: string): Promise<IGlb> {
  const bytes = await readFile(path);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as IGlb;
}

describe("Mechanism Kit", () => {
  it("bakes all catalog entries on the ground and exports each named attachment", async () => {
    const out = await makeTempDir("tn-mechanisms-");
    const rows = environmentElements({ kind: "mechanism" });
    const catalog = (await proceduralEnvironmentSource({ root: out }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    const attachments = {
      "mechanism-emitter": ["signal-output"],
      "mechanism-receiver": ["signal-input"],
      "mechanism-reflector": ["signal-reflector"],
      "mechanism-conveyor": ["belt-start", "belt-end"],
      "mechanism-turntable": ["turntable-deck"],
      "mechanism-socket": ["cell-dock"],
    };
    expect(rows.map(({ id }) => id)).toEqual(Object.keys(attachments));
    expect(catalog.elements.filter(({ kind }) => kind === "mechanism")).toMatchObject(
      rows.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const [module, names] of Object.entries(attachments)) {
      const [bake] = await bakeMechanism({ module, out });
      if (!bake) throw new Error(`Missing bake for ${module}`);
      const glb = await readGlb(bake.path);
      expect(glb.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining(names));
      expect(bake.bounds.min[1]).toBeCloseTo(0);
      expect(bake.triangles).toBeLessThan(3500);
    }
  });

  it("exports the same conveyor seam size at both ends and scales authored anchors", async () => {
    const out = await makeTempDir("tn-mechanism-scale-");
    const [bake] = await bakeMechanism({ module: "mechanism-conveyor", scale: 1.5, out });
    if (!bake) throw new Error("Missing conveyor");
    expect(bake.bounds.min[2]).toBeCloseTo(-1.5);
    expect(bake.bounds.max[2]).toBeCloseTo(1.5);
    const glb = await readGlb(bake.path);
    expect(glb.nodes.find(({ name }) => name === "belt-start")?.matrix?.[14]).toBe(-1);
    expect(glb.nodes.find(({ name }) => name === "belt-end")?.matrix?.[14]).toBe(1);
  });

  it("seats the Station power cell inside the dock at matching scale", () => {
    for (const scale of [0.5, 1, 2]) {
      const socket = buildMechanism("socket", {
        seed: 1,
        accent: mechanismAccent,
        active: false,
        scale,
      });
      socket.updateMatrixWorld(true);
      const dock = socket.getObjectByName("cell-dock");
      if (!dock) throw new Error("Missing dock attachment");
      const seat = dock.getWorldPosition(new Vector3());
      const cell = buildStation("power-cell", { seed: 1, roof: false, accent: stationAccent });
      cell.scale.setScalar(scale);
      cell.position.copy(seat);
      const box = new Box3().setFromObject(cell);
      expect(box.min.y).toBeCloseTo(seat.y);
      const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
      for (const x of [box.min.x, box.max.x]) {
        for (const z of [box.min.z, box.max.z]) {
          ray.ray.origin.set(x, box.max.y + 1, z);
          expect(ray.intersectObject(socket)[0]?.point.y).toBeCloseTo(seat.y);
        }
      }
    }
  });

  it("distinguishes lit and unlit bakes without changing dimensions", async () => {
    const out = await makeTempDir("tn-mechanism-states-");
    const module = "mechanism-emitter";
    const [off] = await bakeMechanism({ module, out });
    const [on] = await bakeMechanism({ module, out, active: true });
    if (!on || !off) throw new Error("Missing signal emitter");
    expect(on.bounds).toEqual(off.bounds);
    expect(on.path).toMatch(/-active\.glb$/);
    const lit = (await readGlb(on.path)).materials.find(({ name }) => name === "Mechanism signal");
    expect(lit?.emissiveFactor?.some((channel) => channel > 0)).toBe(true);
    await expect(
      bakeMechanism({ module: "mechanism-conveyor", out, active: true }),
    ).rejects.toThrow(/active/i);
  });
});
