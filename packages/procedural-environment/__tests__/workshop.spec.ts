import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { Box3, Mesh, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { proceduralEnvironmentSource } from "../src/asset-library.js";
import { bakeWorkshop, environmentElements } from "../src/index.js";
import { buildWorkshop, workshopAccent } from "../src/workshop.js";

const anchors = {
  workbench: ["worktop", "workbench-drawer-bay", "workbench-stool-bay"],
  stool: ["stool-seat"],
  drawer: ["drawer-1", "drawer-2", "drawer-3", "drawer-content"],
  shelf: ["shelf-wall", "shelf-surface"],
  locker: ["locker-door", "locker-floor", "locker-shelf"],
  bed: ["bed-sleep"],
  station: ["worktop", "stool-seat", "drawer-content"],
  sofa: ["seat-1", "seat-2", "seat-3"],
  armchair: ["armchair-seat"],
  "coffee-table": ["coffee-surface", "coffee-shelf"],
  "media-console": ["console-top", "console-shelf", "console-door-left", "console-door-right"],
  lounge: ["seat-1", "seat-2", "seat-3", "armchair-seat", "coffee-surface"],
  "dining-table": ["dining-top"],
  "dining-chair": ["dining-seat"],
  "dining-bench": ["bench-seat-left", "bench-seat-right"],
  "dining-set": ["dining-top", "dining-seat-1", "dining-seat-2", "dining-seat-3", "dining-seat-4"],
} as const;
const options = { accent: workshopAccent, seed: 1, scale: 1 };
const down = new Vector3(0, -1, 0);

describe("Workshop furniture", () => {
  it("exports all grounded Asset Library pieces with named nodes and embedded compressed scans", async () => {
    const out = await makeTempDir("tn-workshop-");
    const rows = environmentElements({ kind: "workshop" });
    expect(rows.map(({ id }) => id)).toEqual(Object.keys(anchors).map((id) => `workshop-${id}`));
    const catalog = (await proceduralEnvironmentSource({ root: out }).catalog()) as {
      elements: { id: string; kind: string; styleTags: string[] }[];
    };
    expect(catalog.elements.filter(({ kind }) => kind === "workshop")).toMatchObject(
      rows.map(({ id }) => ({ id, styleTags: ["stylized"] })),
    );
    for (const [id, nodes] of Object.entries(anchors)) {
      const [entry] = await bakeWorkshop({ module: `workshop-${id}`, out });
      if (!entry) throw new Error(`Missing GLB for ${id}`);
      const bytes = await readFile(entry.path);
      const length = bytes.readUInt32LE(12);
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      const json = JSON.parse(bytes.subarray(20, 20 + length).toString()) as {
        nodes: { name: string }[];
        extensionsRequired: string[];
        images: { mimeType: string; bufferView: number }[];
        bufferViews: { byteLength: number; byteOffset?: number }[];
      };
      expect(json.nodes.map(({ name }) => name)).toEqual(expect.arrayContaining([...nodes]));
      expect(entry.bounds.min[1]).toBeCloseTo(0, 5);
      expect(entry.triangles).toBeLessThan(6500);
      expect(json.extensionsRequired).toContain("EXT_texture_webp");
      expect(json.images).toHaveLength(2);
      let textureBytes = 0;
      for (const image of json.images) {
        expect(image.mimeType).toBe("image/webp");
        const view = json.bufferViews[image.bufferView];
        if (!view) throw new Error("Missing texture buffer view");
        const start = 28 + length + (view.byteOffset ?? 0);
        const { format, width, height } = await sharp(
          bytes.subarray(start, start + view.byteLength),
        ).metadata();
        expect({ format, width, height }).toEqual({ format: "webp", width: 512, height: 512 });
        textureBytes += view.byteLength;
      }
      expect(textureBytes).toBeLessThan(32 * 1024);
    }
  });

  it.each([1.2, 1.65, 2.4])("seats the stool and drawer inside the %s m workbench", (width) => {
    const furniture = buildWorkshop("station", { ...options, width });
    const worktop = furniture.getObjectByName("worktop");
    if (!worktop) throw new Error("Missing worktop");
    for (const name of ["stool", "drawer-unit"]) {
      const part = furniture.getObjectByName(name);
      if (!part) throw new Error(`Missing ${name}`);
      const box = new Box3().setFromObject(part);
      expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x))).toBeLessThan(width / 2 - 0.09);
      expect(box.max.y).toBeLessThan(worktop.position.y - 0.08);
    }
    const cabinet = furniture.getObjectByName("drawer-unit");
    const stool = furniture.getObjectByName("stool");
    if (!cabinet || !stool) throw new Error("Missing nested furniture");
    expect(new Box3().setFromObject(cabinet).intersectsBox(new Box3().setFromObject(stool))).toBe(
      false,
    );
    const steel = furniture.getObjectByName("Workshop structural steel");
    if (!steel) throw new Error("Missing bench frame");
    const ray = new Raycaster(new Vector3(cabinet.position.x, 0.213, 0), new Vector3(0, 0, -1));
    const brace = ray.intersectObject(steel)[0];
    if (!brace) throw new Error("Missing rear brace");
    expect(new Box3().setFromObject(cabinet).min.z).toBeGreaterThan(brace.point.z);
  });

  it("moves an open drawer's content marker with its usable floor", () => {
    const closed = buildWorkshop("drawer", options);
    const open = buildWorkshop("drawer", { ...options, open: true });
    open.updateMatrixWorld(true);
    expect(open.getObjectByName("drawer-3")?.position.z).toBeGreaterThan(0.2);
    expect(closed.getObjectByName("drawer-3")?.position.z).toBe(0);
    expect(open.getObjectByName("drawer-2")?.position.z).toBe(0);
    const contact = open.getObjectByName("drawer-content")?.getWorldPosition(new Vector3());
    if (!contact) throw new Error("Missing drawer contact");
    const ray = new Raycaster(contact.clone().add(new Vector3(0, 0.2, 0)), down);
    expect(ray.intersectObject(open)[0]?.point.y).toBeCloseTo(contact.y);
  });

  it("covers the tray interiors with the drawer faces in the closed pose", () => {
    const cabinet = buildWorkshop("drawer", options);
    cabinet.updateMatrixWorld(true);
    const ray = new Raycaster(new Vector3(0, 0.279, 1), new Vector3(0, 0, -1));
    const face = ray.intersectObject(cabinet)[0];
    expect(face?.object.name).toBe("Workshop accent inset");
    expect(face?.point.z).toBeGreaterThan(0.25);
  });

  it("opens the locker door without blocking its storage shelf", () => {
    const closed = buildWorkshop("locker", options);
    const open = buildWorkshop("locker", { ...options, open: true });
    closed.updateMatrixWorld(true);
    open.updateMatrixWorld(true);
    const shelf = open.getObjectByName("locker-shelf");
    if (!shelf) throw new Error("Missing locker shelf");
    const ray = new Raycaster(new Vector3(0, shelf.position.y + 0.1, 1), new Vector3(0, 0, -1));
    expect(ray.intersectObject(closed)[0]?.point.z).toBeGreaterThan(0.2);
    expect(ray.intersectObject(open)[0]?.point.z).toBeLessThan(-0.2);
    expect(open.getObjectByName("locker-door")?.rotation.y).toBeLessThan(-Math.PI / 2);
  });

  it("keeps seat spacing and surface height when the sofa adds a cushion", () => {
    const two = buildWorkshop("sofa", { ...options, seats: 2 });
    const three = buildWorkshop("sofa", { ...options, seats: 3 });
    two.updateMatrixWorld(true);
    three.updateMatrixWorld(true);
    expect(two.getObjectByName("seat-3")).toBeUndefined();
    expect(three.getObjectByName("seat-3")).toBeDefined();
    const spacing = (sofa: typeof two) => {
      const first = sofa.getObjectByName("seat-1");
      const second = sofa.getObjectByName("seat-2");
      if (!first || !second) throw new Error("Missing seats");
      for (const contact of [first, second]) {
        const ray = new Raycaster(contact.position.clone().add(new Vector3(0, 0.1, 0)), down);
        expect(ray.intersectObject(sofa)[0]?.point.y).toBeCloseTo(contact.position.y);
      }
      return second.position.x - first.position.x;
    };
    expect(spacing(two)).toBeCloseTo(spacing(three));
    const width = (sofa: typeof two) => new Box3().setFromObject(sofa).getSize(new Vector3()).x;
    expect(width(three) - width(two)).toBeCloseTo(spacing(two));
  });

  it.each([2, 3])("maintains access to the coffee table in the %s-seat arrangement", (seats) => {
    const room = buildWorkshop("lounge", { ...options, seats });
    const bounds = (name: string) => {
      const component = room.getObjectByName(name);
      if (!component) throw new Error(`Missing ${name}`);
      return new Box3().setFromObject(component, true);
    };
    const chair = bounds("lounge-armchair");
    const sofa = bounds("lounge-sofa");
    const table = bounds("lounge-table");
    expect(table.min.z - sofa.max.z).toBeGreaterThan(0.31);
    expect(chair.min.x - table.max.x).toBeGreaterThan(0.25);
    expect(chair.intersectsBox(sofa)).toBe(false);
  });

  it("swings both media cabinet doors clear of their compartments", () => {
    const closed = buildWorkshop("media-console", options);
    const open = buildWorkshop("media-console", { ...options, open: true });
    closed.updateMatrixWorld(true);
    open.updateMatrixWorld(true);
    for (const x of [-0.52, 0.52]) {
      const ray = new Raycaster(new Vector3(x, 0.38, 1), new Vector3(0, 0, -1));
      expect(ray.intersectObject(closed)[0]?.point.z).toBeGreaterThan(0.2);
      expect(ray.intersectObject(open)[0]?.point.z).toBeLessThan(-0.1);
    }
  });

  it("keeps the media console's back panel clear of coplanar supports", () => {
    const console = buildWorkshop("media-console", options);
    console.updateMatrixWorld(true);
    for (const x of [0.305, 0.79]) {
      const ray = new Raycaster(new Vector3(x, 0.345, -1), new Vector3(0, 0, 1));
      const [panel, support] = ray.intersectObject(console);
      if (!panel || !support) throw new Error("Missing back panel or support");
      expect(support.point.z - panel.point.z).toBeGreaterThan(0.01);
    }
  });

  it.each([
    [4, 1.4],
    [6, 1.4],
    [6, 2.4],
  ])("fits %s dining chairs at width %s m with usable seat and knee space", (seats, width) => {
    const set = buildWorkshop("dining-set", { ...options, seats, width });
    set.updateMatrixWorld(true);
    const table = set.getObjectByName("dining-table");
    if (!table) throw new Error("Missing table");
    expect(new Box3().setFromObject(table).getSize(new Vector3()).x).toBeCloseTo(width);
    const chairs = set.children.filter(({ name }) => name.startsWith("dining-chair-"));
    expect(chairs).toHaveLength(seats);
    const boxes: Box3[] = [];
    for (const [i, chair] of chairs.entries()) {
      const seat = chair.getObjectByName(`dining-seat-${i + 1}`);
      if (!seat) throw new Error(`Missing seat ${i + 1}`);
      const position = seat.getWorldPosition(new Vector3());
      const forward = seat.getWorldDirection(new Vector3());
      const reachRay = new Raycaster(position.clone().setY(0.724), forward, 0, 0.25);
      expect(reachRay.intersectObject(table).length).toBeGreaterThan(0);
      const seatRay = new Raycaster(position.clone().setY(0.53), down);
      expect(seatRay.intersectObject(chair)[0]?.point.y).toBeCloseTo(position.y);
      const kneeRay = new Raycaster(position.clone().setY(0.56), forward, 0, 0.5);
      expect(kneeRay.intersectObject(table)).toHaveLength(0);
      const box = new Box3().setFromObject(chair, true);
      expect(boxes.some((other) => box.intersectsBox(other))).toBe(false);
      boxes.push(box);
    }
  });

  it("keeps both bench anchors on the usable surface across widths", () => {
    for (const width of [0.92, 1.65]) {
      const bench = buildWorkshop("dining-bench", { ...options, width });
      bench.updateMatrixWorld(true);
      expect(new Box3().setFromObject(bench).getSize(new Vector3()).x).toBeCloseTo(width);
      for (const name of ["bench-seat-left", "bench-seat-right"]) {
        const seat = bench.getObjectByName(name);
        if (!seat) throw new Error(`Missing ${name}`);
        const ray = new Raycaster(seat.position.clone().setY(0.54), down);
        expect(ray.intersectObject(bench)[0]?.point.y).toBeCloseTo(seat.position.y);
      }
    }
  });

  it("maps wood grain along the dining chair's upright", () => {
    const chair = buildWorkshop("dining-chair", options);
    const wood = chair.getObjectByName("Workshop cherry veneer");
    if (!(wood instanceof Mesh)) throw new Error("Missing chair timber");
    const position = wood.geometry.getAttribute("position");
    const normal = wood.geometry.getAttribute("normal");
    const uv = wood.geometry.getAttribute("uv");
    const grain: number[] = [];
    for (let i = 0; i < position.count; i++) {
      if (
        normal.getZ(i) < -0.999 &&
        Math.abs(position.getX(i) - 0.175) < 0.03 &&
        position.getZ(i) < -0.2
      ) {
        grain.push(uv.getX(i));
      }
    }
    expect(grain.length).toBeGreaterThan(0);
    expect(Math.max(...grain) - Math.min(...grain)).toBeGreaterThan(0.75);
  });

  it("keeps distinct variants and rejects controls for incompatible furniture", async () => {
    const out = await makeTempDir("tn-workshop-controls-");
    const [stock] = await bakeWorkshop({ module: "workshop-workbench", out });
    const [wide] = await bakeWorkshop({ module: "workshop-workbench", out, width: 2.4 });
    expect(wide?.path).not.toBe(stock?.path);
    expect(wide?.bounds.max[0]).toBeCloseTo(1.2);
    const [smallSofa] = await bakeWorkshop({ module: "workshop-sofa", out, seats: 2 });
    expect(smallSofa?.path).toMatch(/-2-seats\.glb$/u);
    const [wideDining] = await bakeWorkshop({
      module: "workshop-dining-set",
      out,
      width: 2.3,
      seats: 6,
    });
    expect(wideDining?.path).toMatch(/-w2\.3-6-seats\.glb$/u);
    if (!wideDining) throw new Error("Missing six-seat dining GLB");
    const bytes = await readFile(wideDining.path);
    const { nodes } = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as {
      nodes: { name: string; mesh?: number; children?: number[] }[];
    };
    const chairs = nodes.filter(({ name }) => name.startsWith("dining-chair-"));
    expect(chairs).toHaveLength(6);
    const meshes = chairs.map(({ children }) =>
      children?.flatMap((child) => nodes[child]?.mesh ?? []),
    );
    expect(meshes[0]).toHaveLength(3);
    for (const chairMeshes of meshes) expect(chairMeshes).toEqual(meshes[0]);
    await expect(bakeWorkshop({ module: "workshop-dining-set", out, seats: 5 })).rejects.toThrow(
      /seats/u,
    );
    await expect(bakeWorkshop({ module: "workshop-stool", out, seats: 2 })).rejects.toThrow(
      /seats/u,
    );
    await expect(bakeWorkshop({ module: "workshop-sofa", out, seats: 2.5 })).rejects.toThrow(
      /seats/u,
    );
    await expect(bakeWorkshop({ module: "workshop-stool", out, width: 1.2 })).rejects.toThrow(
      /width/u,
    );
    await expect(bakeWorkshop({ module: "workshop-shelf", out, open: true })).rejects.toThrow(
      /open/u,
    );
  });
});
