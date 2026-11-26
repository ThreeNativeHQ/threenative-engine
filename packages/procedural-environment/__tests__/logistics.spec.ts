import { readFile } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeLogistics, environmentElements } from "../src/index.js";
import { buildLogistics, logisticsAccent } from "../src/logistics.js";

const attachments = {
  pallet: ["pallet-fork-rear", "pallet-fork-front", "pallet-load-left", "pallet-load-right"],
  tote: ["tote-stack"],
  rack: ["rack-shelf-1", "rack-shelf-2", "rack-shelf-3"],
  jack: ["jack-forks", "jack-fork-entry", "jack-handle"],
  container: ["container-deck", "container-door-left", "container-door-right"],
  "loaded-pallet": ["pallet-fork-rear", "pallet-fork-front"],
} as const;
const options = { accent: logisticsAccent, seed: 1, scale: 1 };

describe("Logistics Kit", () => {
  it("bakes all grounded Asset Library entries and preserves named attachment points", async () => {
    const out = await makeTempDir("tn-logistics-");
    const elements = environmentElements({ kind: "logistics" });
    expect(elements.map(({ id }) => id)).toEqual(
      Object.keys(attachments).map((id) => `logistics-${id}`),
    );
    const catalog = (await proceduralEnvironmentSource({ root: out }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "logistics")).toMatchObject(
      elements.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const [module, nodes] of Object.entries(attachments)) {
      const [bake] = await bakeLogistics({ module: `logistics-${module}`, out });
      if (!bake) throw new Error(`Missing bake for ${module}`);
      const bytes = await readFile(bake.path);
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as {
        nodes: { name: string }[];
      };
      expect(json.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining([...nodes]));
      expect(bake.bounds.min[1]).toBeCloseTo(0, 5);
      expect(bake.triangles).toBeLessThan(8000);
    }
  });

  it.each([0.5, 1, 2])("fits both jack forks through both pallet ends at %s scale", (scale) => {
    const pallet = buildLogistics("pallet", { ...options, scale });
    const jack = buildLogistics("jack", { ...options, scale });
    const forks = jack.getObjectByName("jack-forks");
    const entry = jack.getObjectByName("jack-fork-entry");
    if (!forks || !entry) throw new Error("Missing fork assembly");
    jack.updateMatrixWorld(true);
    pallet.updateMatrixWorld(true);
    const local = new Box3().setFromObject(forks, true);
    expect(local.max.y).toBeLessThan(0.116 * scale);
    expect(local.min.y).toBeGreaterThanOrEqual(0);
    expect(local.getSize(new Vector3()).z).toBeGreaterThan(0.95 * scale);
    expect(Math.abs(entry.getWorldPosition(new Vector3()).z - local.min.z)).toBeLessThan(
      0.03 * scale,
    );
    for (const name of ["pallet-fork-rear", "pallet-fork-front"]) {
      const socket = pallet.getObjectByName(name);
      if (!socket) throw new Error(`Missing ${name}`);
      const forward = socket.getWorldDirection(new Vector3());
      const center = socket.getWorldPosition(new Vector3());
      for (const x of [-0.36, -0.2, 0.2, 0.36]) {
        const front = center.clone().add(new Vector3(x * scale, 0.065 * scale, 0));
        const ray = new Raycaster(front, forward, 0, 1.04 * scale);
        expect(ray.intersectObject(pallet)).toEqual([]);
      }
    }
  });

  it("fits the loaded pallet on the shelf and leaves clearance for the shelf above", () => {
    const rack = buildLogistics("rack", { ...options, shelves: 4 });
    const load = buildLogistics("loaded-pallet", options);
    const first = rack.getObjectByName("rack-shelf-1");
    const second = rack.getObjectByName("rack-shelf-2");
    expect(rack.getObjectByName("rack-shelf-4")).toBeDefined();
    if (!first || !second) throw new Error("Missing rack shelves");
    load.position.copy(first.position);
    const box = new Box3().setFromObject(load);
    expect(box.max.y).toBeLessThan(second.position.y - 0.08);
    expect(box.max.x).toBeLessThan(0.68);
    rack.updateMatrixWorld(true);
    const down = new Raycaster(new Vector3(0, first.position.y + 0.08, 0), new Vector3(0, -1, 0));
    expect(down.intersectObject(rack)[0]?.point.y).toBeCloseTo(box.min.y);
  });

  it("connects the jack release lever to the side of the grip", () => {
    const jack = buildLogistics("jack", options);
    jack.updateMatrixWorld(true);
    const handle = jack.getObjectByName("jack-handle");
    if (!handle) throw new Error("Missing handle");
    const origin = handle.localToWorld(new Vector3(0.122, 0.793, 0));
    const ray = new Raycaster(origin, new Vector3(0, 0, -1));
    expect(ray.intersectObject(handle)[0]?.object.name).toBe("Cargo lock and fittings");
  });

  it("opens a clear container entry with independent door hinges", () => {
    const closed = buildLogistics("container", options);
    const open = buildLogistics("container", { ...options, open: true });
    const crate = buildLogistics("loaded-pallet", options);
    const deck = open.getObjectByName("container-deck");
    if (!deck) throw new Error("Missing container deck socket");
    crate.position.copy(deck.position);
    expect(new Box3().setFromObject(crate).min.y).toBeCloseTo(deck.position.y);
    closed.updateMatrixWorld(true);
    open.updateMatrixWorld(true);
    for (const x of [-0.55, 0.55]) {
      const ray = new Raycaster(new Vector3(x, 0.75, 4), new Vector3(0, 0, -1));
      expect(ray.intersectObject(closed)[0]?.point.z).toBeGreaterThan(2.8);
      expect(ray.intersectObject(open)[0]?.point.z).toBeLessThan(-2.8);
    }
    expect(open.getObjectByName("container-door-left")?.rotation.y).toBeLessThan(-1.57);
    expect(open.getObjectByName("container-door-right")?.rotation.y).toBeGreaterThan(1.57);
  });

  it("rejects misplaced or invalid overrides", async () => {
    const out = await makeTempDir("tn-logistics-option-");
    await expect(bakeLogistics({ module: "logistics-rack", shelves: 2.5, out })).rejects.toThrow(
      /shelves/u,
    );
    await expect(bakeLogistics({ module: "logistics-pallet", open: true, out })).rejects.toThrow(
      /open/u,
    );
  });
});
