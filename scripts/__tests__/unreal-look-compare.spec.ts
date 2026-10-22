import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { tierQuery } from "../unreal-look/capture-gi-threenative.js";
import {
  binnedMedian,
  ciede2000,
  classify,
  compareCells,
  decode,
  deriveMasks,
  deriveThresholds,
  iou,
  lab,
  main,
  masks,
  parseArgs,
  quantiles,
  readLocks,
  runCheck,
  runComparison,
  seedLocks,
  silhouetteIou,
} from "../unreal-look/compare.js";
import { compareGiToUnreal, penumbraRows, readScene, unrealVariant } from "../unreal-look/gi.js";

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
  // A frame whose median is 66 moves 1.5% when a few pixels cross a bin edge (PRD-631: L7 sun60_interior p50 66 vs 67,
  // L8 sun15_interior 93 vs 92), although the mean moved 0.12% and 0.02%. The sub-level median interpolates inside the bin.
  it("reports the whole-frame p50 difference at sub-level resolution beside the whole-level one", () => {
    const { root, put } = fixture();
    const frame = (levels: number[]) => png(levels.map(gray));
    for (const engine of ["unreal", "runB"]) {
      put(`captures/${engine}/ID/ID_exterior.png`, floor());
      put(
        `captures/${engine}/L1/L1_sun60_exterior.png`,
        frame(engine === "unreal" ? [66, 66, 67, 67] : [66, 67, 67, 67]),
      );
      put(`captures/${engine}/L1/L1_sun60_exterior.exr`, exr());
    }
    const report = runComparison({
      referenceDir: root,
      layers: ["L1"],
      unrealVsUnreal: path.join(root, "captures/runB"),
    });
    expect(report.noise[0]?.dP50).toBeCloseTo(1 / 66, 6);
    expect(report.noise[0]?.dP50Binned).toBeCloseTo(1 / 3 / 66.5, 6);
    expect(report.maxNoiseBinned).toBeLessThan(0.01);
    expect(report.maxNoiseBinned).toBeLessThan(report.maxNoise ?? 0);
  });
  it("interpolates the median inside its bin and leaves a single level alone", () => {
    expect(binnedMedian([66, 66, 67, 67])).toBeCloseTo(66.5, 9);
    expect(binnedMedian([66, 67, 67, 67])).toBeCloseTo(66 + 5 / 6, 9);
    expect(binnedMedian([10, 10, 10, 10])).toBe(10);
    expect(() => binnedMedian([])).toThrow(/^TN_UNREAL_LOOK_EMPTY_MASK/);
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
  it("scores a silhouette without penalising an anti-aliased edge the other frame does not have", () => {
    // Five columns: X on the left, Y on the right. The aliased frame cuts at column 3; the
    // multisampled frame blends column 2 (no region) and cuts the rest at the same place.
    const colors = { X: [200, 0, 0], Y: [0, 200, 0] };
    const row = (cells: number[][]) => png(Array.from({ length: 3 }, () => cells).flat(), 5);
    const sharp = masks(decode(row([colors.X, colors.X, colors.X, colors.Y, colors.Y])), colors);
    const soft = masks(
      decode(row([colors.X, colors.X, [100, 100, 0], colors.Y, colors.Y])),
      colors,
    );
    expect(iou(sharp.regions.X as never, soft.regions.X as never)).toBeCloseTo(6 / 9);
    expect(silhouetteIou(sharp, soft, "X")).toBe(1);
    expect(silhouetteIou(sharp, soft, "Y")).toBe(1);
    // A real one-column shift of pure colours still counts.
    const moved = masks(decode(row([colors.X, colors.X, colors.X, colors.X, colors.Y])), colors);
    expect(silhouetteIou(sharp, moved, "X")).toBeCloseTo(9 / 12);
    expect(() => silhouetteIou(sharp, soft, "Missing")).toThrow(/^TN_UNREAL_LOOK_EMPTY_MASK/);
  });
  describe("parity locks", () => {
    const lock = (over: Record<string, unknown> = {}) => ({
      layer: "L1",
      sun: "sun60",
      pose: "exterior",
      region: "Floor",
      metric: "dP50",
      threshold: 100,
      since: "abc1234",
      ...over,
    });
    function locked(locks: unknown[]) {
      const { root, put } = fixture();
      for (const engine of ["unreal", "threenative"]) {
        put(`captures/${engine}/ID/ID_exterior.png`, floor());
        put(
          `captures/${engine}/L1/L1_sun60_exterior.png`,
          engine === "unreal" ? display() : floor(),
        );
        put(`captures/${engine}/L1/L1_sun60_exterior.exr`, exr());
      }
      put("parity-locks.json", JSON.stringify({ locks }));
      return root;
    }
    it("passes a locked cell that holds", () => {
      expect(runCheck({ referenceDir: locked([lock()]) }).failures).toEqual([]);
    });
    it("fails a drifted cell and exits 1", () => {
      const root = locked([lock({ threshold: 0.01 })]);
      const { failures } = runCheck({ referenceDir: root });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/L1 sun60 exterior Floor dP50/);
      main(["--check", "--reference-dir", root]);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });
    it("fails a locked cell the capture does not have", () => {
      const root = locked([lock({ region: "NoSuchRegion" }), lock({ pose: "interior" })]);
      const { failures } = runCheck({ referenceDir: root });
      expect(failures).toHaveLength(2);
      expect(failures.join("\n")).toMatch(/missing/);
    });
    it("fails closed on an empty list, a bad entry and a scene it cannot evaluate", () => {
      for (const locks of [
        [],
        [lock({ metric: "bogus" })],
        [lock({ since: "" })],
        [lock({ scene: "gi:x" })],
      ])
        expect(() => runCheck({ referenceDir: locked(locks) })).toThrow(
          /^TN_UNREAL_LOOK_(BAD_INPUT|MISSING_CELL)/,
        );
    });
    it("keeps the emissive sphere locked at L9 in the sun 60 and sun 15 cells, within the layer's own thresholds", () => {
      // `--write-locks` re-seeds a layer from the cells that hold now, so a broken cell drops its
      // lock without a word. A vignette that scaled the alpha dimmed this sphere to dP50 0.118 and
      // deltaE 6.7 at sun 60 (0.133 and 7.2 at sun 15), and L9 carried no lock on it. This list
      // says what must stay locked.
      const locks = readLocks("tools/unreal-reference/parity-locks.json");
      const limits = JSON.parse(readFileSync("tools/unreal-reference/thresholds.json", "utf8"));
      for (const sun of ["sun60", "sun15"])
        for (const metric of ["deltaE", "dP50"] as const) {
          const found = locks.find(
            (l) =>
              l.layer === "L9" &&
              l.sun === sun &&
              l.pose === "spheres" &&
              l.region === "Sphere_Emissive" &&
              l.metric === metric,
          );
          expect(found, `L9 ${sun} spheres Sphere_Emissive ${metric}`).toBeDefined();
          expect(found?.threshold).toBeLessThanOrEqual(limits.layers.L9[metric]);
        }
    });
    it("re-seeds only the --layer layers and keeps the other locks", () => {
      const root = locked([lock({ layer: "L2", since: "old0000" }), lock({ since: "old0000" })]);
      writeFileSync(
        path.join(root, "thresholds.json"),
        JSON.stringify({ layers: { L1: { dP50: 100 } } }),
      );
      runComparison({ referenceDir: root, layers: ["L1"], writeLocks: "new1234" });
      const after = readLocks(path.join(root, "parity-locks.json"));
      expect(after.filter((l) => l.layer === "L2").map((l) => l.since)).toEqual(["old0000"]);
      expect(after.filter((l) => l.layer === "L1").map((l) => l.since)).toEqual(["new1234"]);
    });
    it("refuses a re-seed that would drop a lock, and drops it only on --drop-locks", () => {
      // The Floor deltaE lock cannot be re-seeded: thresholds.json holds no deltaE limit for L1 here, so
      // the cell would lose its lock without a word. The re-seed names it and stops.
      const root = locked([
        lock({ since: "old0000" }),
        lock({ metric: "deltaE", threshold: 50, since: "old0000" }),
      ]);
      writeFileSync(
        path.join(root, "thresholds.json"),
        JSON.stringify({ layers: { L1: { dP50: 100 } } }),
      );
      const file = path.join(root, "parity-locks.json");
      expect(() =>
        runComparison({ referenceDir: root, layers: ["L1"], writeLocks: "new1234" }),
      ).toThrow(/^TN_UNREAL_LOOK_LOCK_DROPPED.*1 lock.*L1 sun60 exterior Floor deltaE/s);
      expect(readLocks(file).map((l) => `${l.metric} ${l.since}`)).toEqual([
        "dP50 old0000",
        "deltaE old0000",
      ]);
      expect(parseArgs(["--write-locks", "abc", "--drop-locks"])).toEqual({
        writeLocks: "abc",
        dropLocks: true,
      });
      runComparison({
        referenceDir: root,
        layers: ["L1"],
        writeLocks: "new1234",
        dropLocks: true,
      });
      expect(readLocks(file).map((l) => `${l.metric} ${l.since}`)).toEqual(["dP50 new1234"]);
    });
    it("seeds only the cells and metrics that hold", () => {
      const root = locked([lock()]);
      const report = runComparison({ referenceDir: root, layers: ["L1"] });
      const seeded = seedLocks(
        report.rows,
        { layers: { L1: { dP50: 100, deltaE: 0.001 } } },
        "abc1234",
      );
      expect(seeded.map((l) => l.metric)).toEqual(["dP50"]);
      expect(
        seedLocks(report.rows, { layers: { L1: { dP50: 100 } } }, "abc1234", ["deltaE"]),
      ).toEqual([]);
      expect(parseArgs(["--write-locks", "abc", "--lock-metric", "iou,dP50"])).toEqual({
        writeLocks: "abc",
        lockMetrics: ["iou", "dP50"],
      });
      expect(seeded[0]).toMatchObject({
        layer: "L1",
        sun: "sun60",
        pose: "exterior",
        region: "Floor",
        since: "abc1234",
      });
    });
  });
  it("parses repeated and comma-separated filters and rejects missing values", () => {
    expect(
      parseArgs(["--layer", "L0,L1", "--layer", "L5", "--sun", "4", "--metric", "penumbra"]),
    ).toEqual({ layers: ["L0", "L1", "L5"], suns: ["4"], metric: "penumbra" });
    expect(() => parseArgs(["--layer"])).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => parseArgs(["--unknown"])).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
  });

  describe("GI quality tiers (PRD-644)", () => {
    it("pairs each ThreeNative tier with the Unreal level it follows", () => {
      expect(unrealVariant("L7-low")).toBe("L7-Low");
      expect(unrealVariant("L7-medium")).toBe("L7-Medium");
      expect(unrealVariant("L7-high")).toBe("L7-Epic");
      // The level flag compares one capture against another level's frame.
      expect(unrealVariant("L7", 0)).toBe("L7-Low");
      expect(unrealVariant("L7", 1)).toBe("L7-Medium");
      expect(unrealVariant("L7", 3)).toBe("L7-Epic");
    });
    it("draws a GI tier against Epic shadows and a shadow tier against its own", () => {
      // Unreal's GI and shadow levels are separate scalability groups: the L7-Low frame has Epic shadows.
      expect(tierQuery("L7-low")).toBe("&tier=low&shadowTier=high");
      expect(tierQuery("L7-high")).toBe("&tier=high&shadowTier=high");
      expect(tierQuery("L5-Medium")).toBe("&tier=medium");
      expect(tierQuery("L7")).toBe("");
    });
    it("fails closed on a layer or level that is not in the table", () => {
      expect(() => unrealVariant("L7-ultra")).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
      expect(() => unrealVariant("L7", 2)).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT.*unreal level 2/);
    });
    it("measures the shadow edge width of a tier against Unreal's, on the floor mask", () => {
      const { root, put } = fixture();
      const { scene } = readScene("shadow:penumbra-lab");
      const [floor = []] = [scene.regions.Floor];
      // A floor run 160 px wide with one shadow edge: lit left, shadowed right, the step `blur` px wide.
      const frame = (blur: number) =>
        png(
          Array.from({ length: 200 * 40 }, (_, i) => {
            const x = (i % 200) - 100;
            const t = Math.min(1, Math.max(0, x / blur + 0.5));
            return gray(Math.round(220 - 150 * t));
          }),
          200,
        );
      const id = png(
        Array.from({ length: 200 * 40 }, () => floor),
        200,
      );
      for (const pose of scene.poses.map((p) => p.name)) {
        put(`unreal/shadow/penumbra-lab/ID/${pose}.png`, id);
        put(`threenative/shadow/penumbra-lab/ID/${pose}.png`, id);
        put(`unreal/shadow/penumbra-lab/L5-Low/${pose}.png`, frame(2));
        put(`threenative/shadow/penumbra-lab/L5-Low/${pose}.png`, frame(4));
      }
      const rows = penumbraRows("shadow:penumbra-lab", ["L5-Low"], root);
      expect(rows.length).toBe(scene.poses.length);
      for (const row of rows) {
        expect(row.matched).toBeGreaterThan(0);
        // Twice the blur is about twice the width, the ratio the PRD-634 threshold (1.25) holds.
        expect(row.ratio).toBeGreaterThan(1.6);
        expect(row.ratio).toBeLessThan(2.4);
      }
    });
    it("throws TN_UNREAL_LOOK_MISSING_CELL naming the Unreal frame of the level when it is absent", () => {
      const { root, put } = fixture();
      const { scene } = readScene("cornell");
      const [name = "", color = []] = Object.entries(scene.regions)[0] ?? [];
      const id = png([color, color, color, color]);
      for (const engine of ["unreal", "threenative"])
        for (const pose of scene.poses) put(`${engine}/cornell/ID/${pose.name}.png`, id);
      for (const pose of scene.poses)
        put(`threenative/cornell/L7-medium/${pose.name}.png`, floor());
      expect(name).not.toBe("");
      expect(() => compareGiToUnreal("cornell", ["L7-medium"], root)).toThrow(
        /^TN_UNREAL_LOOK_MISSING_CELL.*L7-Medium/,
      );
      for (const pose of scene.poses) put(`unreal/cornell/L7-Medium/${pose.name}.png`, floor());
      const rows = compareGiToUnreal("cornell", ["L7-medium"], root);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.layer))).toEqual(new Set(["L7-medium"]));
    });
  });
});
