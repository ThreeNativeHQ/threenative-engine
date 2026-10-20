import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ciede2000,
  classify,
  compareCells,
  decode,
  deriveMasks,
  deriveThresholds,
  iou,
  lab,
  masks,
  parseArgs,
  quantiles,
  runComparison,
} from "../unreal-look/compare.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "unreal-look-"));
  roots.push(root);
  const put = (name: string, content: Buffer | string) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  put(
    "poses.json",
    JSON.stringify({
      resolution: [2, 2],
      suns: [{ name: "sun60" }],
      poses: [{ name: "exterior" }],
    }),
  );
  put("layers.json", JSON.stringify({ layers: [{ name: "L0" }, { name: "L1" }, { name: "L5" }] }));
  put("regions.json", JSON.stringify({ srgb8: { Floor: [128, 128, 128] } }));
  return { root, put };
}
function png(colors: number[][], width = 2): Buffer {
  const image = new PNG({ width, height: colors.length / width });
  colors.forEach((color, i) => {
    image.data.set([...color, 255], i * 4);
  });
  return PNG.sync.write(image);
}
const gray = (v: number) => [v, v, v];
const floor = () => png([gray(128), gray(128), gray(128), gray(128)]);
const display = () => png([gray(10), gray(30), gray(100), gray(200)]);
const base = () => masks(decode(floor()), { Floor: gray(128) });
const cell = () => ({
  layer: "L1",
  cell: "sun60_exterior",
  unreal: decode(display()),
  threenative: decode(display()),
  masks: base(),
  regions: ["Floor"],
});

// Minimal uncompressed scanline EXR, with RGB channels and different rows to catch vertical inversion.
function exr(half = false): Buffer {
  const int = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    return b;
  };
  const float = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return b;
  };
  const str = (v: string) => Buffer.from(`${v}\0`);
  const attribute = (name: string, type: string, data: Buffer) =>
    Buffer.concat([str(name), str(type), int(data.length), data]);
  const channels = Buffer.concat([
    ...["B", "G", "R"].map((name) =>
      Buffer.concat([str(name), int(half ? 1 : 2), Buffer.alloc(4), int(1), int(1)]),
    ),
    Buffer.alloc(1),
  ]);
  const window = Buffer.concat([int(0), int(0), int(1), int(1)]);
  const header = Buffer.concat([
    int(20000630),
    int(2),
    attribute("channels", "chlist", channels),
    attribute("compression", "compression", Buffer.alloc(1)),
    attribute("dataWindow", "box2i", window),
    attribute("displayWindow", "box2i", window),
    attribute("lineOrder", "lineOrder", Buffer.alloc(1)),
    attribute("pixelAspectRatio", "float", float(1)),
    attribute("screenWindowCenter", "v2f", Buffer.alloc(8)),
    attribute("screenWindowWidth", "float", float(1)),
    Buffer.alloc(1),
  ]);
  const chunks = [0, 1].map((y) => {
    const values = Array.from({ length: 6 }, () => {
      if (!half) return float(y ? 4 : 1);
      const b = Buffer.alloc(2);
      b.writeUInt16LE(y ? 0x4400 : 0x3c00);
      return b;
    });
    const bytes = Buffer.concat(values);
    return Buffer.concat([int(y), int(bytes.length), bytes]);
  });
  let offset = header.length + 16;
  const offsets = chunks.map((chunk) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(offset));
    offset += chunk.length;
    return b;
  });
  return Buffer.concat([header, ...offsets, ...chunks]);
}

describe("Unreal reference comparison", () => {
  it("throws TN_UNREAL_LOOK_MISSING_CELL for an absent side", () => {
    const { put } = fixture();
    const source = decode(readFileSync(put("frame.png", display())));
    expect(() => compareCells({ ...cell(), unreal: source, threenative: undefined })).toThrow(
      /^TN_UNREAL_LOOK_MISSING_CELL/,
    );
  });
  it("throws TN_UNREAL_LOOK_SIZE_MISMATCH for paired images or masks", () => {
    const { put } = fixture();
    const small = decode(readFileSync(put("small.png", png([gray(30)], 1))));
    expect(() => compareCells({ ...cell(), threenative: small })).toThrow(
      /^TN_UNREAL_LOOK_SIZE_MISMATCH/,
    );
    expect(() => compareCells({ ...cell(), masks: { ...base(), width: 1 } })).toThrow(
      /^TN_UNREAL_LOOK_SIZE_MISMATCH/,
    );
  });
  it("throws TN_UNREAL_LOOK_EMPTY_MASK for an evaluated empty region or set", () => {
    const { put } = fixture();
    const unclassified = decode(
      readFileSync(put("id.png", png(Array.from({ length: 4 }, () => [40, 80, 120])))),
    );
    expect(() =>
      compareCells({ ...cell(), masks: masks(unclassified, { Floor: gray(128) }) }),
    ).toThrow(/^TN_UNREAL_LOOK_EMPTY_MASK/);
    expect(() => compareCells({ ...cell(), regions: [] })).toThrow(/^TN_UNREAL_LOOK_EMPTY_MASK/);
  });
  it("matches Sharma et al. test pair 1 within 1e-4", () => {
    expect(Math.abs(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425)).toBeLessThan(
      1e-4,
    );
    expect(ciede2000([50, 0, 0], [50, 0, 0])).toBe(0);
  });
  it("computes IoU and rejects an empty mask", () => {
    expect(iou(Uint8Array.from([1, 1, 0, 0]), Uint8Array.from([0, 1, 1, 0]))).toBeCloseTo(1 / 3);
    expect(() => iou(new Uint8Array(4), new Uint8Array(4))).toThrow(/^TN_UNREAL_LOOK_EMPTY_MASK/);
  });
  it("classifies tolerance boundaries, Sky and unclassified edges", () => {
    expect(classify([134, 122, 128], { Floor: gray(128) })).toBe("Floor");
    expect(classify([135, 128, 128], { Floor: gray(128) })).toBeNull();
    expect(classify([6, 0, 6], {})).toBe("Sky");
  });
  it("uses byte-bin display quantiles and per-channel median Lab", () => {
    const row = compareCells(cell())[0];
    expect(row?.unreal).toMatchObject({ p1: 10, p50: 30, p99: 200, pixels: 4, ev50: null });
    expect(row?.deltaE).toBe(0);
    expect(row?.unreal?.lab[0]).toBeCloseTo((lab(gray(30))[0] + lab(gray(100))[0]) / 2);
    expect(quantiles([4, 1, 3, 2])).toEqual([1, 2, 4]);
    const black = decode(png(Array.from({ length: 4 }, () => gray(0))));
    const one = decode(png(Array.from({ length: 4 }, () => gray(1))));
    expect(compareCells({ ...cell(), unreal: black, threenative: one })[0]?.dP50).toBe(1);
  });
  it.each([false, true])("decodes %s half-float EXR into top-left scene-linear pixels", (half) => {
    const linear = decode(exr(half), "exr");
    expect(linear.data[0]).toBe(1);
    expect(linear.data[linear.width * linear.channels]).toBe(4);
    const row = compareCells({ ...cell(), unrealExr: linear })[0];
    expect(row?.unreal).toMatchObject({ ev1: 0, ev50: 0, ev99: 2 });
    expect(row?.threenative?.ev50).toBeNull();
  });
  it("splits Floor using half the L5 p90, including equality as lit", () => {
    const split = deriveMasks(base(), decode(display()));
    expect(Array.from(split.regions.ShadowedFloor ?? [])).toEqual([1, 1, 0, 0]);
    expect(Array.from(split.regions.LitFloor ?? [])).toEqual([0, 0, 1, 1]);
  });
  it("captures stats and masks, then compares offline with the same results", () => {
    const { root, put } = fixture();
    for (const engine of ["unreal", "threenative"]) {
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
      for (const layer of ["L1", "L5"])
        put(`captures/${engine}/${layer}/${layer}_sun60_exterior.png`, display());
    }
    for (const layer of ["L1", "L5"])
      put(`captures/unreal/${layer}/${layer}_sun60_exterior.exr`, exr());
    const online = runComparison({
      referenceDir: root,
      layers: ["L1", "L5"],
      writeMasks: true,
      writeStats: true,
      sheet: true,
      metric: "exposure",
    });
    expect(online.rows).toHaveLength(6);
    expect(online.rows.every((r) => r.deltaE === 0 && r.pass === null)).toBe(true);
    expect(online.exposure[0]?.dEv).toBe(0);
    const sheet = PNG.sync.read(readFileSync(path.join(root, "captures/sheets/L1.png")));
    expect([sheet.width, sheet.height]).toEqual([1280, 360]);
    const offline = runComparison({
      referenceDir: root,
      unreal: path.join(root, "absent"),
      layers: ["L1", "L5"],
    });
    expect(offline.rows.map((r) => r.region)).toEqual(online.rows.map((r) => r.region));
    expect(offline.rows.every((r) => r.dP50 === 0)).toBe(true);
    put("thresholds.json", JSON.stringify({ deltaE: 1, dP50: 0.01 }));
    put("captures/threenative/L1/L1_sun60_exterior.png", floor());
    expect(
      runComparison({ referenceDir: root, layers: ["L1"] }).summary[0]?.failCount,
    ).toBeGreaterThan(0);
  });
  it("writes reference statistics and masks from Unreal alone", () => {
    const { root, put } = fixture();
    put("captures/unreal/ID/ID_exterior.png", floor());
    put("captures/unreal/L1/L1_sun60_exterior.png", display());
    put("captures/unreal/L1/L1_sun60_exterior.exr", exr());
    const report = runComparison({
      referenceDir: root,
      layers: ["L1"],
      writeMasks: true,
      writeStats: true,
    });
    expect(report.rows).toHaveLength(0);
    const reference = JSON.parse(readFileSync(path.join(root, "reference-stats.json"), "utf8"));
    expect(reference.cells.L1_sun60_exterior.Floor.p50).toBe(30);
    expect(PNG.sync.read(readFileSync(path.join(root, "masks/ID_exterior.png"))).width).toBe(2);
  });
  it("includes IoU in each L0 region row without duplicating rows", () => {
    const { root, put } = fixture();
    for (const engine of ["unreal", "threenative"]) {
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
      put(`captures/${engine}/L0/L0_sun60_exterior.png`, display());
    }
    put("captures/unreal/L0/L0_sun60_exterior.exr", exr());
    const report = runComparison({ referenceDir: root, layers: ["L0"] });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ iou: 1, deltaE: 0, dP50: 0 });
  });
  it("fails closed for incomplete cells, missing L5 and malformed input", () => {
    const { root, put } = fixture();
    put("captures/unreal/ID/ID_exterior.png", floor());
    expect(() => runComparison({ referenceDir: root, layers: ["L1"] })).toThrow(
      /^TN_UNREAL_LOOK_MISSING_CELL/,
    );
    expect(() => runComparison({ referenceDir: root, layers: ["L5"] })).toThrow(
      /^TN_UNREAL_LOOK_MISSING_CELL/,
    );
    expect(() => runComparison({ referenceDir: root, layers: ["L10"] })).toThrow(
      /^TN_UNREAL_LOOK_BAD_INPUT/,
    );
    expect(() => runComparison({ referenceDir: root, suns: ["sun99"] })).toThrow(
      /^TN_UNREAL_LOOK_BAD_INPUT/,
    );
    put("poses.json", "{");
    expect(() => runComparison({ referenceDir: root })).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
  });
  it("supports sun-independent ID comparisons without lit frames", () => {
    const { root, put } = fixture();
    for (const engine of ["unreal", "threenative"])
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
    put("thresholds.json", JSON.stringify({ iou: 0.99 }));
    const report = runComparison({ referenceDir: root, layers: ["ID"] });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ iou: 1, pass: true, cell: "exterior" });
  });
  it("measures whole-frame and regional noise in Unreal-vs-Unreal mode", () => {
    const { root, put } = fixture();
    for (const engine of ["unreal", "runB"]) {
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
      put(`captures/${engine}/L1/L1_sun60_exterior.png`, engine === "unreal" ? display() : floor());
      put(`captures/${engine}/L1/L1_sun60_exterior.exr`, exr());
    }
    const report = runComparison({
      referenceDir: root,
      layers: ["L1"],
      unrealVsUnreal: path.join(root, "captures/runB"),
    });
    expect(report.maxNoise).toBeCloseTo(98 / 30);
    expect(report.noise).toHaveLength(1);
    expect(report.rows[0]?.dEv50).toBe(0);
  });
  it("derives per-layer thresholds as the larger of twice the worst noise and the absolute floor", () => {
    const row = (layer: string, deltaE: number, dP50: number, dEv50: number) =>
      ({ layer, cell: "c", region: "Floor", deltaE, dP50, dEv50, iou: null }) as never;
    const derived = deriveThresholds([
      row("L1", 0.2, 0.001, -0.004),
      row("L1", 0.9, 0.002, 0.003),
      row("L7", 2, 0.03, 0.2),
      row("L7", 1.5, 0.01, -0.5),
    ]);
    expect(derived.L1).toEqual({ deltaE: 1.8, dP50: 0.01, dEv: 0.02 });
    expect(derived.L7).toEqual({ deltaE: 4, dP50: 0.06, dEv: 1 });
  });
  it("fails closed when no noise row exists to derive from", () => {
    expect(() => deriveThresholds([])).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
  });
  it("applies a layer's own thresholds over the flat ones", () => {
    const { root, put } = fixture();
    for (const engine of ["unreal", "runB"]) {
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
      put(`captures/${engine}/L1/L1_sun60_exterior.png`, engine === "unreal" ? display() : floor());
    }
    put("captures/unreal/L1/L1_sun60_exterior.exr", exr());
    put("thresholds.json", JSON.stringify({ iou: 0.98, layers: { L1: { dP50: 100 } } }));
    expect(
      runComparison({
        referenceDir: root,
        layers: ["L1"],
        threenative: path.join(root, "captures/runB"),
      }).summary[0],
    ).toMatchObject({ evaluatedCount: 1, failCount: 0 });
    put("thresholds.json", JSON.stringify({ iou: 0.98, layers: { L1: { dP50: 0.01 } } }));
    expect(
      runComparison({
        referenceDir: root,
        layers: ["L1"],
        threenative: path.join(root, "captures/runB"),
      }).summary[0],
    ).toMatchObject({ evaluatedCount: 1, failCount: 1 });
  });
  it("rejects a malformed per-layer threshold", () => {
    const { root, put } = fixture();
    put("captures/unreal/ID/ID_exterior.png", floor());
    put("captures/unreal/L1/L1_sun60_exterior.png", floor());
    put("captures/threenative/L1/L1_sun60_exterior.png", floor());
    put("thresholds.json", JSON.stringify({ layers: { L1: { bogus: 1 } } }));
    expect(() => runComparison({ referenceDir: root, layers: ["L1"] })).toThrow(
      /^TN_UNREAL_LOOK_BAD_INPUT/,
    );
  });
  it("writes thresholds from an Unreal-vs-Unreal run and refuses any other mode", () => {
    const { root, put } = fixture();
    for (const engine of ["unreal", "runB"]) {
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
      put(`captures/${engine}/L1/L1_sun60_exterior.png`, engine === "unreal" ? display() : floor());
      put(`captures/${engine}/L1/L1_sun60_exterior.exr`, exr());
    }
    expect(() =>
      runComparison({ referenceDir: root, layers: ["L1"], writeThresholds: true }),
    ).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
    runComparison({
      referenceDir: root,
      layers: ["L1"],
      unrealVsUnreal: path.join(root, "captures/runB"),
      writeThresholds: true,
    });
    const written = JSON.parse(readFileSync(path.join(root, "thresholds.json"), "utf8"));
    expect(written.iou).toBe(0.98);
    expect(written.layers.L1.dP50).toBeCloseTo((98 / 30) * 2, 1);
  });
  it("parses repeated and comma-separated filters and rejects missing values", () => {
    expect(
      parseArgs(["--layer", "L0,L1", "--layer", "L5", "--sun", "4", "--metric", "penumbra"]),
    ).toEqual({ layers: ["L0", "L1", "L5"], suns: ["4"], metric: "penumbra" });
    expect(() => parseArgs(["--layer"])).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => parseArgs(["--unknown"])).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
  });
});
