import { readFile } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeTavern, bakeWorkshop, environmentElements } from "../src/index.js";
import { buildTavern, tavernAccent } from "../src/tavern.js";

interface IGlb {
  readonly nodes: { name: string }[];
  readonly images: { bufferView: number; mimeType: string }[];
  readonly bufferViews: { byteOffset?: number; byteLength: number }[];
  readonly meshes: { primitives: { attributes: Record<string, number> }[] }[];
}

const anchors = {
  table: ["tavern-tabletop"],
  bench: ["bench-seat-left", "bench-seat-right"],
  counter: ["counter-surface", "counter-shelf", "counter-join-left", "counter-join-right"],
  "dining-set": [
    "tavern-tabletop",
    "north-bench-seat-left",
    "north-bench-seat-right",
    "south-bench-seat-left",
    "south-bench-seat-right",
  ],
  barrel: ["barrel-mouth", "barrel-lid", "barrel-lid-grip"],
  bucket: ["bucket-mouth", "bucket-handle", "bucket-grip"],
  tankard: ["tankard-mouth", "tankard-grip"],
} as const;
const options = { accent: tavernAccent, seed: 1, scale: 1 };
const down = new Vector3(0, -1, 0);

function images(bytes: Buffer, doc: IGlb, jsonLength: number): Buffer[] {
  return doc.images.map((image) => {
    const view = doc.bufferViews[image.bufferView];
    if (!view) throw new Error("Missing image buffer view");
    expect(image.mimeType).toBe("image/webp");
    const offset = 28 + jsonLength + (view.byteOffset ?? 0);
    return bytes.subarray(offset, offset + view.byteLength);
  });
}

async function glb(file: string) {
  const bytes = await readFile(file);
  const length = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + length).toString()) as IGlb;
  return { doc, maps: images(bytes, doc, length) };
}

describe("Tavern furniture", () => {
  it("lists each entry with separate realistic style and medieval settings", async () => {
    const root = await makeTempDir("tn-tavern-catalog-");
    const ids = Object.keys(anchors).map((id) => `tavern-${id}`);
    expect(environmentElements({ kind: "tavern" }).map(({ id }) => id)).toEqual(ids);
    const catalog = (await proceduralEnvironmentSource({ root }).catalog()) as {
      elements: { id: string; kind: string }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "tavern")).toMatchObject(
      ids.map((id) => ({ id, styleTags: ["realistic"], settingTags: ["medieval", "fantasy"] })),
    );
  });

  it.each(Object.entries(anchors))(
    "exports grounded %s and reuses the compressed wood maps",
    async (id, names) => {
      const out = await makeTempDir("tn-tavern-bake-");
      const [workshop] = await bakeWorkshop({ module: "workshop-workbench", out });
      const [tavern] = await bakeTavern({ module: `tavern-${id}`, out });
      if (!workshop || !tavern) throw new Error("Missing furniture bake");
      const { doc, maps } = await glb(tavern.path);
      expect(tavern.bounds.min[1]).toBeCloseTo(0, 5);
      expect(doc.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining([...names]));
      expect(
        doc.meshes.some((mesh) => mesh.primitives.some((p) => "COLOR_0" in p.attributes)),
      ).toBe(true);
      expect(maps).toHaveLength(2);
      expect(maps).toEqual((await glb(workshop.path)).maps);
      expect(maps.reduce((total, image) => total + image.length, 0)).toBeLessThan(32 * 1024);
    },
  );

  it.each([1.45, 2.4])("keeps the benches and usable tabletop aligned at %s m", (width) => {
    const set = buildTavern("dining-set", { ...options, width });
    set.updateMatrixWorld(true);
    const tabletop = set.getObjectByName("tavern-table");
    const marker = set.getObjectByName("tavern-tabletop");
    if (!tabletop || !marker) throw new Error("Missing tavern table");
    expect(new Box3().setFromObject(tabletop, true).getSize(new Vector3()).x).toBeCloseTo(width);
    const surface = marker.getWorldPosition(new Vector3());
    const above = new Raycaster(surface.clone().add(new Vector3(0, 0.12, 0)), down);
    expect(above.intersectObject(tabletop)[0]?.point.y).toBeCloseTo(surface.y);
    for (const name of anchors["dining-set"].slice(1)) {
      const seat = set.getObjectByName(name);
      if (!seat) throw new Error(`Missing ${name}`);
      const pos = seat.getWorldPosition(new Vector3());
      const forwards = seat.getWorldDirection(new Vector3());
      expect(forwards.z * pos.z).toBeLessThan(0);
      const chair = new Raycaster(pos.clone().add(new Vector3(0, 0.08, 0)), down);
      expect(chair.intersectObject(set)[0]?.point.y).toBeCloseTo(pos.y);
      const knees = new Raycaster(pos.clone().setY(0.61), forwards, 0, 0.54);
      expect(knees.intersectObject(tabletop)).toHaveLength(0);
    }
  });

  it("joins standard-height counters of different widths and keeps rear shelf access", () => {
    const left = buildTavern("counter", { ...options, width: 1.2 });
    const right = buildTavern("counter", { ...options, width: 2.4 });
    const plug = left.getObjectByName("counter-join-right");
    const socket = right.getObjectByName("counter-join-left");
    const shelf = right.getObjectByName("counter-shelf");
    if (!plug || !socket || !shelf) throw new Error("Missing counter anchors");
    right.position.copy(plug.position.clone().sub(socket.position));
    left.updateMatrixWorld(true);
    right.updateMatrixWorld(true);
    expect(new Box3().setFromObject(left, true).max.x).toBeCloseTo(
      new Box3().setFromObject(right, true).min.x,
    );
    expect(
      plug.getWorldDirection(new Vector3()).dot(socket.getWorldDirection(new Vector3())),
    ).toBeCloseTo(-1);
    const apron = new Raycaster(new Vector3(0, 0.977, 0.41), new Vector3(0, 0, -1), 0, 0.17);
    expect(apron.intersectObject(left)[0]?.point.z ?? 0).toBeGreaterThan(0.23);
    const end = new Raycaster(new Vector3(0.75, 0.977, 0), new Vector3(-1, 0, 0), 0, 0.3);
    expect(end.intersectObject(left)[0]?.point.x ?? 0).toBeGreaterThan(0.5);
    const seam = new Raycaster(
      new Vector3((1.2 - 0.199) * (1 / 7 - 0.5), 0.7, 0.41),
      new Vector3(0, 0, -1),
      0,
      0.22,
    );
    expect(seam.intersectObject(left)[0]?.point.z ?? 0).toBeGreaterThan(0.2);
    const pos = shelf.getWorldPosition(new Vector3());
    const reach = new Raycaster(
      pos.clone().add(new Vector3(0, 0.12, -0.6)),
      new Vector3(0, 0, 1),
      0,
      0.6,
    );
    expect(reach.intersectObject(right)).toHaveLength(0);
  });

  it("rebakes a width override as a distinct GLB and rejects out-of-range widths", async () => {
    const out = await makeTempDir("tn-tavern-width-");
    const [entry] = await bakeTavern({ module: "tavern-table", width: 2.2, out });
    expect(entry?.path).toMatch(/tavern-table-1-w2\.2\.glb$/u);
    await expect(bakeTavern({ module: "tavern-table", width: 1, out })).rejects.toThrow(/width/u);
  });

  it.each([
    ["bucket", 0.24, 0.36],
    ["tankard", 0.088, 0.128],
  ] as const)("keeps the %s mouth clear across its diameter range", (vessel, min, max) => {
    for (const width of [min, max]) {
      const group = buildTavern(vessel, { ...options, width });
      group.updateMatrixWorld(true);
      const mouth = group.getObjectByName(`${vessel}-mouth`);
      const grip = group.getObjectByName(`${vessel}-grip`);
      if (!mouth || !grip) throw new Error(`Missing ${vessel} anchor`);
      const depth = new Raycaster(mouth.position.clone().add(new Vector3(0, 0.001, 0)), down);
      const floor = depth.intersectObject(group)[0]?.point.y ?? 0;
      expect(floor).toBeGreaterThan(0);
      expect(floor).toBeLessThan(mouth.position.y - 0.075);
      const wall = new Raycaster(
        mouth.position.clone().add(new Vector3(0, -0.011, 0)),
        new Vector3(0, 0, 1),
      );
      const edge = wall.intersectObject(group)[0]?.point.z ?? 0;
      expect(edge).toBeGreaterThan(width / 2 - 0.025);
      expect(edge).toBeLessThan(width / 2);
    }
  });

  it("opens the barrel by moving only the lid and identifies the grab point on that lid", async () => {
    const width = 0.68;
    const closed = buildTavern("barrel", { ...options, width });
    const open = buildTavern("barrel", { ...options, width, open: true });
    const mouth = open.getObjectByName("barrel-mouth");
    const lid = open.getObjectByName("barrel-lid");
    if (!mouth || !lid) throw new Error("Missing cooperage nodes");
    expect(closed.getObjectByName("barrel-mouth")?.position.toArray()).toEqual(
      mouth.position.toArray(),
    );
    expect(lid.getObjectByName("barrel-lid-grip")).toBeDefined();
    for (const group of [closed, open]) group.updateMatrixWorld(true);
    const access = new Raycaster(mouth.position.clone().add(new Vector3(0, 0.2, 0)), down);
    expect(access.intersectObject(closed)[0]?.point.y).toBeGreaterThan(mouth.position.y - 0.025);
    expect(access.intersectObject(open)[0]?.point.y).toBeLessThan(mouth.position.y - 0.6);
    expect(new Box3().setFromObject(lid, true).min.y).toBeCloseTo(0);
    const out = await makeTempDir("tn-tavern-lid-");
    const [entry] = await bakeTavern({ module: "tavern-barrel", open: true, out });
    expect(entry?.path).toMatch(/-open\.glb$/u);
    await expect(bakeTavern({ module: "tavern-tankard", open: true, out })).rejects.toThrow(
      /open/u,
    );
  });

  it("carries the bucket grip on the bail as it pivots", () => {
    const bucket = buildTavern("bucket", { ...options, width: 0.3 });
    const bail = bucket.getObjectByName("bucket-handle");
    const grip = bail?.getObjectByName("bucket-grip");
    if (!bail || !grip) throw new Error("Missing bucket bail");
    bail.rotation.x = 0;
    bucket.updateMatrixWorld(true);
    const raised = grip.getWorldPosition(new Vector3());
    const hand = new Raycaster(raised.clone().add(new Vector3(0, 0.05, 0)), down);
    expect(hand.intersectObject(bail)[0]?.point.y ?? 0).toBeGreaterThan(raised.y + 0.007);
    bail.rotation.x = Math.PI / 2;
    const lowered = grip.getWorldPosition(new Vector3());
    expect(lowered.y).toBeCloseTo(bail.position.y);
    expect(lowered.z).toBeCloseTo(raised.y - bail.position.y);
  });
});
