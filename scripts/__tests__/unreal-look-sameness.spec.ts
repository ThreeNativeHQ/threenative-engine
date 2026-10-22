import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ID_LAYER_ANTIALIAS,
  ID_LAYER_QUERY,
  idLayerIsAliased,
} from "../unreal-look/capture-threenative.js";
import { decode, main, masks } from "../unreal-look/compare.js";
import { depthTieNotes, depthTies } from "../unreal-look/depth-ties.js";
import { readScene } from "../unreal-look/gi.js";
import {
  EDGE_FAR_LIMIT,
  EDGE_GAP_LIMIT,
  type ISamenessInput,
  NO_ID_LIMIT,
  classifiedFrame,
  overlapFrame,
  runSameness,
  samenessCell,
  samenessInputs,
  samenessReport,
  samenessTables,
} from "../unreal-look/sameness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "unreal-look-sameness-"));
  roots.push(root);
  return root;
}

const COLORS = { A: [255, 0, 0], B: [0, 255, 0], C: [0, 0, 255] } as const;
/** `.` is background (black), `?` a colour that is no ID, a letter the object of that name. */
function frame(rows: readonly string[], palette: Record<string, readonly number[]> = COLORS): PNG {
  const png = new PNG({ width: rows[0]?.length ?? 0, height: rows.length });
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      const rgb = char === "." ? [0, 0, 0] : char === "?" ? [40, 80, 120] : (palette[char] ?? []);
      png.data.set([...rgb, 255], (y * png.width + x) * 4);
    });
  });
  return png;
}
const masksOf = (rows: readonly string[]) => masks(decode(PNG.sync.write(frame(rows))), COLORS);
/** A 60 x 40 frame of rectangles drawn in order: [object, x, y, width, height]. */
function boxes(...drawn: [string, number, number, number, number][]): string[] {
  const rows = Array.from({ length: 40 }, () => ".".repeat(60).split(""));
  for (const [name, x, y, w, h] of drawn)
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) (rows[j] as string[])[i] = name;
  return rows.map((row) => row.join(""));
}
const here = { scene: "reference", pose: "spheres" };
/**
 * The wall A with a blade B on it. Unreal's blade has a gap of `gap` pixels down its middle where the wall
 * shows through, and ThreeNative's blade is whole: two cut-out edges that land one pixel apart.
 */
const blades = (gap: number) => ({
  unreal: boxes(["A", 10, 5, 40, 30], ["B", 20, 10, 2, 20], ["B", 22 + gap, 10, 2, 20]),
  threenative: boxes(["A", 10, 5, 40, 30], ["B", 20, 10, 4 + gap, 20]),
});

describe("sameness gate: one pose", () => {
  const same = ["AAAA....", "AAAA.BB.", "AAAA.BB.", "AAAA...."];
  const wall = boxes(["A", 10, 5, 40, 30], ["B", 2, 2, 6, 6]);
  const row = (rows: string[], object: string) =>
    samenessCell(here, masksOf(wall), masksOf(rows)).rows.find((r) => r.object === object);

  it("scores an object both engines draw alike at overlap 1 and an edge distance of 0", () => {
    const cell = samenessCell(here, masksOf(same), masksOf(same));
    expect(cell.rows.map((r) => [r.object, r.iou, r.gap, r.far, r.pass])).toEqual([
      ["A", 1, 0, 0, true],
      ["B", 1, 0, 0, true],
    ]);
    expect(cell.agree).toBe(1);
    expect(cell.pass).toBe(true);
  });

  it("does not score an object that neither engine draws in this pose", () => {
    const objects = samenessCell(here, masksOf(same), masksOf(same)).rows.map((r) => r.object);
    expect(objects).not.toContain("C");
  });

  it("fails an object only ThreeNative draws, as a row with no overlap", () => {
    const tn = ["AAAA....", "AAAA.BB.", "AAAA.BB.", "AAAA.CC."];
    const cell = samenessCell(here, masksOf(same), masksOf(tn));
    expect(cell.rows.find((r) => r.object === "C")).toMatchObject({
      unrealPx: 0,
      threenativePx: 2,
      iou: 0,
      gap: Number.POSITIVE_INFINITY,
      far: 0,
      thin: 0,
      lost: 0,
      shift: null,
      pass: false,
    });
    expect(cell.pass).toBe(false);
  });

  it("fails an object only Unreal draws", () => {
    const tn = ["AAAA....", "AAAA....", "AAAA....", "AAAA...."];
    const cell = samenessCell(here, masksOf(same), masksOf(tn));
    expect(cell.rows.find((r) => r.object === "B")).toMatchObject({
      unrealPx: 4,
      threenativePx: 0,
      iou: 0,
      pass: false,
    });
  });

  it("passes an edge that differs by one pixel, however low the overlap of a small object falls", () => {
    // ThreeNative's A is one pixel smaller on every side, the way two rasterizers disagree on an edge.
    const smaller = boxes(["A", 11, 6, 38, 28], ["B", 3, 3, 4, 4]);
    expect(row(smaller, "A")).toMatchObject({ gap: 1, far: 0, pass: true });
    expect(row(smaller, "B")).toMatchObject({ gap: 1, far: 0, pass: true });
    expect(row(smaller, "B")?.iou).toBeLessThan(0.5);
  });

  it("fails an object whose edge is three pixels off, though its overlap stays above 0.9", () => {
    const bigger = boxes(["A", 7, 5, 43, 30], ["B", 2, 2, 6, 6]);
    expect(row(bigger, "A")).toMatchObject({ gap: 3, pass: false });
    expect(row(bigger, "A")?.far).toBeGreaterThan(EDGE_FAR_LIMIT);
    expect(row(bigger, "A")?.iou).toBeGreaterThan(0.9);
  });

  it("fails a corner the other engine draws as another object, which a flat overlap threshold misses", () => {
    // A 6 x 6 corner of the 40 x 30 wall is B in ThreeNative: the wall keeps an overlap of 0.97.
    const corner = boxes(["A", 10, 5, 40, 30], ["B", 2, 2, 6, 6], ["B", 10, 5, 6, 6]);
    expect(row(corner, "A")?.iou).toBeGreaterThan(0.96);
    expect(row(corner, "A")).toMatchObject({ pass: false });
    expect(row(corner, "A")?.far).toBeGreaterThan(EDGE_FAR_LIMIT);
  });

  it("allows a few pixels beyond the edge limit and not one more", () => {
    // A strip of the wall three pixels wide and two pixels out: its outer two columns lie beyond the limit.
    const strip = (length: number) =>
      boxes(["A", 10, 5, 40, 30], ["A", 50, 10, 3, length], ["B", 2, 2, 6, 6]);
    const rows = EDGE_FAR_LIMIT / 2;
    expect(row(strip(rows), "A")).toMatchObject({ far: EDGE_FAR_LIMIT, pass: true });
    expect(row(strip(rows + 1), "A")).toMatchObject({ far: EDGE_FAR_LIMIT + 2, pass: false });
  });

  it("fails an object that moved, and reports by how many pixels", () => {
    const moved = boxes(["A", 10, 5, 40, 30], ["B", 8, 2, 6, 6]);
    const b = row(moved, "B");
    expect(b?.pass).toBe(false);
    expect(b?.shift).toEqual([6, 0]);
  });

  it("scores the edge at the limit it is given", () => {
    const smaller = boxes(["A", 11, 6, 38, 28], ["B", 2, 2, 6, 6]);
    const strict = samenessCell(here, masksOf(wall), masksOf(smaller), 0, 0);
    expect(strict.rows.find((r) => r.object === "A")).toMatchObject({ pass: false });
    expect(strict.pass).toBe(false);
  });

  it("counts the pixels the other engine draws in a colour that is no ID, a few allowed and not one more", () => {
    // The first foliage scene: a cut-out card tinted by its texture reads as no object where the edge is dark.
    const card = masksOf(boxes(["A", 10, 10, 20, 20]));
    const darkened = (count: number) =>
      masksOf(
        boxes(["A", 10, 10, 20, 20]).map((r, y) =>
          y === 10 ? `${r.slice(0, 10)}${"?".repeat(count)}${r.slice(10 + count)}` : r,
        ),
      );
    const ok = samenessCell(here, card, darkened(EDGE_FAR_LIMIT)).rows[0];
    expect(ok).toMatchObject({ lost: EDGE_FAR_LIMIT, far: 0, pass: true });
    const bad = samenessCell(here, card, darkened(EDGE_FAR_LIMIT + 1)).rows[0];
    expect(bad).toMatchObject({ lost: EDGE_FAR_LIMIT + 1, far: 0, pass: false });
    // The same in the other engine's frame.
    expect(samenessCell(here, darkened(EDGE_FAR_LIMIT + 1), card).rows[0]).toMatchObject({
      lost: EDGE_FAR_LIMIT + 1,
      pass: false,
    });
  });

  it("fails a card whose thin outer ring reads as no ID, though no thick feature moved", () => {
    const ring = boxes(["A", 10, 10, 20, 20]).map((r, y) =>
      y === 10 || y === 29
        ? `${r.slice(0, 10)}${"?".repeat(20)}${r.slice(30)}`
        : y > 10 && y < 29
          ? `${r.slice(0, 10)}?${r.slice(11, 29)}?${r.slice(30)}`
          : r,
    );
    const cell = samenessCell(here, masksOf(boxes(["A", 10, 10, 20, 20])), masksOf(ring));
    expect(cell.rows[0]).toMatchObject({ lost: 76, far: 0, pass: false });
  });

  it("leaves a pixel of no ID colour out of the score, and fails a frame with far more of them", () => {
    // 20 x 10 frame: one pixel of no ID is 0.5% of it.
    const sharp = Array.from(
      { length: 10 },
      (_, y) => `${y < 5 ? "A" : "B"}`.repeat(10) + ".".repeat(10),
    );
    const soft = [...sharp];
    soft[0] = `?${(soft[0] ?? "").slice(1)}`;
    const edge = samenessCell(here, masksOf(sharp), masksOf(soft));
    expect(edge.rows.map((r) => r.iou)).toEqual([1, 1]);
    expect(edge.pass).toBe(true);
    // Half of the frame in a colour that is no ID: every object still overlaps, but the frame cannot be trusted.
    const wrong = samenessCell(
      here,
      masksOf(sharp),
      masksOf(sharp.map((r) => r.replace(/\./g, "?"))),
    );
    expect(wrong.rows.map((r) => r.iou)).toEqual([1, 1]);
    expect(wrong.unknown.threenative).toBeGreaterThan(NO_ID_LIMIT);
    expect(wrong.pass).toBe(false);
  });

  it("fails closed when neither frame shows an object", () => {
    const empty = masksOf(["....", "...."]);
    expect(() => samenessCell(here, empty, empty)).toThrow(/^TN_UNREAL_LOOK_EMPTY_MASK/);
  });

  it("fails closed on frames of two sizes", () => {
    expect(() => samenessCell(here, masksOf(same), masksOf(["AA", "BB"]))).toThrow(
      /^TN_UNREAL_LOOK_SIZE_MISMATCH/,
    );
  });

  it("marks the disagreement of an object that fails white in the overlap frame", () => {
    const bigger = boxes(["A", 7, 5, 43, 30], ["B", 3, 3, 4, 4]);
    const unreal = masksOf(wall);
    const threenative = masksOf(bigger);
    const cell = samenessCell(here, unreal, threenative);
    const overlap = overlapFrame(unreal, threenative, COLORS, cell.violations);
    const pixel = (x: number, y: number) => [
      ...overlap.data.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 3),
    ];
    expect(pixel(20, 20)).toEqual([85, 0, 0]); // both draw A: a third of its colour
    expect(pixel(8, 20)).toEqual([255, 255, 255]); // Unreal: background, ThreeNative: A, which fails
    expect(pixel(2, 2)).toEqual([128, 128, 128]); // Unreal: B, ThreeNative: background, but B passes
    expect(pixel(40, 38)).toEqual([0, 0, 0]); // both draw background
  });

  it("paints the disagreement between two objects white when the object fails and grey when it passes", () => {
    const unreal = masksOf(wall);
    const smaller = masksOf(boxes(["A", 11, 6, 38, 28], ["B", 2, 2, 6, 6]));
    const passing = samenessCell(here, unreal, smaller);
    const edge = overlapFrame(unreal, smaller, COLORS, passing.violations);
    // Unreal draws A at (10, 20), ThreeNative the background: both are IDs, so the disagreement is painted.
    expect([...edge.data.subarray((20 * 60 + 10) * 4, (20 * 60 + 10) * 4 + 3)]).toEqual([
      128, 128, 128,
    ]);
    const corner = masksOf(boxes(["A", 10, 5, 40, 30], ["B", 2, 2, 6, 6], ["B", 10, 5, 6, 6]));
    const failing = samenessCell(here, unreal, corner);
    const wide = overlapFrame(unreal, corner, COLORS, failing.violations);
    expect([...wide.data.subarray((7 * 60 + 12) * 4, (7 * 60 + 12) * 4 + 3)]).toEqual([
      255, 255, 255,
    ]);
  });
});

describe("the ThreeNative ID layer is single-sampled, as Unreal's is", () => {
  it("names the pages that draw an ID layer, and no other", () => {
    for (const query of [
      "?layer=ID",
      "?tnGi=cornell&layer=ID",
      "?tnRef=ID&sun=60,25",
      "?model=x&tnRef=ID",
    ])
      expect(ID_LAYER_QUERY.test(query), query).toBe(true);
    for (const query of [
      "",
      "?layer=L9",
      "?tnRef=L9&sun=60,25",
      "?layers=ID",
      "?layer=IDX",
      "?x=tnRef=ID",
    ])
      expect(ID_LAYER_QUERY.test(query), query).toBe(false);
  });

  it("puts antialias off for those pages in the scaffold's renderer config, once", () => {
    const config = "renderer: {\n    alphaAntialiasing: true,\n  },";
    const patched = idLayerIsAliased(config, "threenative.config.ts");
    expect(patched).toContain(ID_LAYER_ANTIALIAS);
    expect(ID_LAYER_ANTIALIAS).toContain(String(ID_LAYER_QUERY));
    expect(idLayerIsAliased(patched, "threenative.config.ts")).toBe(patched);
    expect(patched.split(ID_LAYER_ANTIALIAS)).toHaveLength(2);
  });

  it("fails closed when the template's renderer config moved", () => {
    expect(() => idLayerIsAliased("renderer: {}", "threenative.config.ts")).toThrow(
      /^TN_UNREAL_LOOK_PATCH/,
    );
  });
});

describe("sameness gate: capture roots", () => {
  /** A pose of the reference scene, drawn by both engines under `root`. */
  function put(root: string, engine: string, name: string, png: PNG) {
    const file = path.join(root, engine, "ID", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, PNG.sync.write(png));
  }
  const input = (pose: string): ISamenessInput => ({
    scene: "reference",
    pose,
    unreal: path.join("ID", `ID_${pose}.png`),
    threenative: path.join("ID", `ID_${pose}.png`),
    colors: COLORS,
    overlap: path.join("ID", `ID_${pose}.png`),
  });
  const good = ["AAAA....", "AAAA.BB.", "AAAA.BB.", "AAAA...."];

  it("fails closed on a missing frame and names it", () => {
    const root = tempRoot();
    put(root, "unreal", "ID_spheres.png", frame(good));
    expect(() => samenessReport([input("spheres")], root)).toThrow(
      /^TN_UNREAL_LOOK_MISSING_CELL: .*threenative\/ID\/ID_spheres\.png$/,
    );
  });

  it("names an object that no pose of the scene shows, and leaves the verdict alone", () => {
    const root = tempRoot();
    for (const engine of ["unreal", "threenative"])
      put(root, engine, "ID_spheres.png", frame(good));
    // `good` shows A and B. C is in the scene and out of every view.
    const report = samenessReport([input("spheres")], root);
    expect(report.unscored).toEqual(["reference/C"]);
    expect(report.cells.every((c) => c.pass)).toBe(true);
  });

  it("scores an object that any pose of the scene shows, and never lists the sky", () => {
    const root = tempRoot();
    const other = ["AAAA....", "AAAA.CC.", "AAAA.CC.", "AAAA...."];
    for (const engine of ["unreal", "threenative"]) {
      put(root, engine, "ID_spheres.png", frame(good));
      put(root, engine, "ID_exterior.png", frame(other));
    }
    const colors = { ...COLORS, Sky: [1, 2, 3] };
    const inputs = ["spheres", "exterior"].map((pose) => ({ ...input(pose), colors }));
    expect(samenessReport(inputs, root).unscored).toEqual([]);
  });

  it("judges each scene on its own poses", () => {
    const root = tempRoot();
    for (const engine of ["unreal", "threenative"]) {
      put(root, engine, "ID_spheres.png", frame(good));
      put(root, engine, "ID_exterior.png", frame(["AAAA....", "AAAA.CC.", "AAAA.CC.", "AAAA...."]));
    }
    // One scene shows A and B, another A and C: each is missing the object the other shows.
    const inputs = [input("spheres"), { ...input("exterior"), scene: "other" }];
    expect(samenessReport(inputs, root).unscored).toEqual(["reference/C", "other/B"]);
  });

  it("fails closed when it selects no pose", () => {
    expect(() => samenessReport([], tempRoot())).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
  });

  it("scores every pose and writes one overlap frame each", () => {
    const root = tempRoot();
    for (const engine of ["unreal", "threenative"]) {
      put(root, engine, "ID_spheres.png", frame(good));
      put(root, engine, "ID_exterior.png", frame(good));
    }
    const report = samenessReport([input("spheres"), input("exterior")], root);
    expect(report.cells.map((c) => c.pose)).toEqual(["spheres", "exterior"]);
    expect(report.rows).toHaveLength(4);
    expect(report.limit).toBe(EDGE_GAP_LIMIT);
    expect(report.allowed).toBe(EDGE_FAR_LIMIT);
    expect(existsSync(path.join(root, "overlap/ID/ID_spheres.png"))).toBe(true);
    expect(existsSync(path.join(root, "overlap/ID/ID_exterior.png"))).toBe(true);
  });

  it("writes each engine's frame redrawn in the exact colours of its objects beside the overlap", () => {
    const root = tempRoot();
    // Unreal's frame is display encoded: a linear 128 arrives as 187. The gate knows it, and the redrawn frame is exact.
    const palette = { A: [128, 0, 255], B: [0, 255, 0] };
    put(root, "unreal", "ID_spheres.png", frame(good, { A: [187, 0, 255], B: [0, 255, 0] }));
    put(root, "threenative", "ID_spheres.png", frame(good, palette));
    const report = samenessReport([{ ...input("spheres"), colors: palette }], root);
    expect(report.cells[0]?.pass).toBe(true);
    for (const engine of ["unreal", "threenative"]) {
      const file = path.join(root, "overlap/ID", `ID_spheres.${engine}.png`);
      const png = PNG.sync.read(readFileSync(file));
      expect([...png.data.subarray(0, 4)], engine).toEqual([128, 0, 255, 255]);
    }
  });

  it("redraws a pixel with no object colour in dark grey and background in black", () => {
    const redrawn = classifiedFrame(masksOf(["A?.."]), COLORS);
    const at = (x: number) => [...redrawn.data.subarray(x * 4, x * 4 + 3)];
    expect([at(0), at(1), at(2)]).toEqual([
      [255, 0, 0],
      [64, 64, 64],
      [0, 0, 0],
    ]);
  });

  it("names the ID layer in every heading of its report and shows every number the verdict reads", () => {
    const root = tempRoot();
    for (const engine of ["unreal", "threenative"])
      put(root, engine, "ID_spheres.png", frame(good));
    const text = samenessTables(samenessReport([input("spheres")], root));
    const headings = text.split("\n").filter((line) => line.startsWith("###"));
    expect(headings).toHaveLength(2);
    for (const heading of headings) expect(heading).toContain("ID layer, both engines");
    expect(text).toContain(
      "| reference | spheres | A | 16 | 16 | 0.0, 0.0 | 1.0000 | 0 | 0 | 0 | 0 | PASS |",
    );
    expect(text).toContain(
      "| reference | spheres | 2 | A | 0 | 0 | 1.0000 | 100.00 | 0.00 / 0.00 | PASS |",
    );
  });

  it("reports the thin pixels in the table, after the pixels that decide the verdict", () => {
    const root = tempRoot();
    const { unreal, threenative } = blades(1);
    put(root, "unreal", "ID_spheres.png", frame(unreal));
    put(root, "threenative", "ID_spheres.png", frame(threenative));
    const text = samenessTables(samenessReport([input("spheres")], root));
    expect(text).toContain("px beyond 1 px | thin px beyond 1 px | no-ID px | verdict |");
    expect(text).toMatch(
      /\| reference \| spheres \| A \| \d+ \| \d+ \| .* \| 0 \| 18 \| 0 \| PASS \|/,
    );
  });

  it("reports the pixels the other engine draws without an ID colour in the table", () => {
    const root = tempRoot();
    put(root, "unreal", "ID_spheres.png", frame(good));
    put(root, "threenative", "ID_spheres.png", frame(["?AAA....", ...good.slice(1)]));
    const text = samenessTables(samenessReport([input("spheres")], root));
    expect(text).toMatch(
      /\| reference \| spheres \| A \| 16 \| 15 \| .* \| 0 \| 0 \| 1 \| PASS \|/,
    );
  });

  it("prints an object one engine lacks with an infinite distance, and ranks it worst in its pose", () => {
    const root = tempRoot();
    put(root, "unreal", "ID_spheres.png", frame(good));
    put(
      root,
      "threenative",
      "ID_spheres.png",
      frame(["AAAA....", "AAAA....", "AAAA....", "AAAA...."]),
    );
    const text = samenessTables(samenessReport([input("spheres")], root));
    expect(text).toContain(
      "| reference | spheres | B | 4 | 0 | — | 0.0000 | ∞ | ∞ | — | — | FAIL |",
    );
    expect(text).toContain(
      "| reference | spheres | 2 | B | ∞ | ∞ | 0.0000 | 87.50 | 0.00 / 0.00 | FAIL |",
    );
  });
});

describe("sameness gate: features thinner than three pixels", () => {
  const rowOf = (gap: number, object: string) => {
    const { unreal, threenative } = blades(gap);
    return samenessCell(here, masksOf(unreal), masksOf(threenative)).rows.find(
      (r) => r.object === object,
    );
  };

  it("counts the pixels of a one pixel crack apart from the verdict: two edges one pixel off can close it", () => {
    // The crack is 20 pixels of the wall, 18 of them beyond the limit from ThreeNative's wall: more than the 10 allowed.
    expect(rowOf(1, "A")).toMatchObject({ far: 0, thin: 18, pass: true });
    expect(rowOf(1, "A")?.gap).toBeLessThanOrEqual(EDGE_GAP_LIMIT);
    expect(rowOf(1, "B")).toMatchObject({ far: 0, thin: 0, pass: true });
  });

  it("scores a two pixel crack the same way: both of its edges can move one pixel", () => {
    expect(rowOf(2, "A")).toMatchObject({ far: 0, thin: 36, pass: true });
  });

  it("still fails a crack three pixels wide, and the blade that fills it", () => {
    // Three columns of the wall that the other engine covers: no 1 px shift of an edge closes them.
    expect(rowOf(3, "A")).toMatchObject({ far: 54, thin: 0, pass: false });
    expect(rowOf(3, "B")).toMatchObject({ pass: false });
    expect(rowOf(3, "B")?.far).toBeGreaterThan(EDGE_FAR_LIMIT);
  });

  it("scores every pixel of an object that is thinner than three pixels everywhere", () => {
    // A one pixel line has no pixel the exemption could apply to: it is scored as before.
    const line = (x: number) => masksOf(boxes(["C", x, 10, 1, 20]));
    const apart = samenessCell(here, line(10), line(20)).rows[0];
    expect(apart).toMatchObject({ gap: 10, far: 40, thin: 0, pass: false });
    expect(samenessCell(here, line(10), line(10)).rows[0]).toMatchObject({
      far: 0,
      thin: 0,
      pass: true,
    });
  });

  it("excuses a thin fringe of an object that also has a thick body", () => {
    // A 12 x 12 leaf with a 1 pixel hair of 14 pixels that only Unreal draws: the hair is not the leaf's body.
    const leaf = boxes(["A", 10, 10, 12, 12]);
    const hairy = boxes(["A", 10, 10, 12, 12], ["A", 22, 15, 14, 1]);
    const cell = samenessCell(here, masksOf(hairy), masksOf(leaf));
    expect(cell.rows[0]).toMatchObject({ far: 0, thin: 13, pass: true });
  });
});

describe("sameness gate: which poses it reads", () => {
  it("selects the reference scene and every registered scene by default", () => {
    const inputs = samenessInputs();
    const scenes = new Set(inputs.map((i) => i.scene));
    expect([...scenes]).toEqual(
      expect.arrayContaining([
        "reference",
        "cornell",
        "sunlit-room",
        "shadow:penumbra-lab",
        "shadow:lamp-room",
        "shadow:foliage",
      ]),
    );
    expect(inputs.filter((i) => i.scene === "reference").map((i) => i.pose)).toEqual([
      "exterior",
      "spheres",
      "interior",
      "backlit",
    ]);
  });

  it("names a calibration scene's frames after its scene.json poses and regions", () => {
    const inputs = samenessInputs("gi:cornell");
    const { scene } = readScene("cornell");
    expect(inputs.map((i) => i.pose)).toEqual(scene.poses.map((p) => p.name));
    expect(inputs[0]).toMatchObject({
      scene: "cornell",
      unreal: path.join("cornell", "ID", "cornell.png"),
      colors: scene.regions,
    });
    expect(samenessInputs("shadow:lamp-room")[0]).toMatchObject({
      scene: "shadow:lamp-room",
      threenative: path.join("shadow", "lamp-room", "ID", "spot.png"),
    });
  });

  it("selects the reference scene alone", () => {
    expect(samenessInputs("reference")[1]).toMatchObject({
      unreal: path.join("ID", "ID_spheres.png"),
      threenative: path.join("ID", "ID_spheres.png"),
    });
  });

  it("fails closed on a scene or family it does not know", () => {
    expect(() => samenessInputs("gi:nowhere")).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => samenessInputs("films")).toThrow(/^TN_UNREAL_LOOK_BAD_INPUT/);
    expect(() => samenessInputs("gi,shadow:lamp-room,films:a")).toThrow(
      /^TN_UNREAL_LOOK_BAD_INPUT/,
    );
  });
});

describe("sameness gate: the command", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /** The cornell scene as both engines draw it: every pose, every object. */
  function cornell(
    root: string,
    threenative: (rows: string[]) => string[] = (rows) => rows,
    unreal: (rows: string[]) => string[] = (rows) => rows,
  ) {
    const { scene } = readScene("cornell");
    const names = Object.keys(scene.regions);
    // One row of vertical bands, an object each: the same in both engines unless `threenative` changes it.
    const bands = [names.map((_, i) => String.fromCharCode(65 + i).repeat(4)).join("")];
    const palette = Object.fromEntries(
      names.map((name, i) => [String.fromCharCode(65 + i), scene.regions[name] ?? []]),
    );
    for (const engine of ["unreal", "threenative"])
      for (const pose of scene.poses) {
        const rows = engine === "unreal" ? unreal(bands) : threenative(bands);
        const file = path.join(root, engine, "cornell", "ID", `${pose.name}.png`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, PNG.sync.write(frame(rows, palette)));
      }
    return names;
  }

  it("passes when both engines draw the scene alike, and fails when one object is missing", () => {
    const root = tempRoot();
    cornell(root);
    expect(runSameness(["--scene", "gi:cornell", "--captures", root])).toBe(0);
    const broken = tempRoot();
    // ThreeNative draws no last object: its band is background.
    cornell(broken, (rows) => rows.map((row) => `${row.slice(0, -4)}....`));
    expect(runSameness(["--scene", "gi:cornell", "--captures", broken])).toBe(1);
  });

  it("prints the objects no pose shows, and still passes", () => {
    const root = tempRoot();
    // Both engines draw the last band as background: nothing in the scene shows the last object.
    const blank = (rows: string[]) => rows.map((row) => `${row.slice(0, -4)}....`);
    const names = cornell(root, blank, blank);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    expect(runSameness(["--scene", "gi:cornell", "--captures", root])).toBe(0);
    expect(lines.join("\n")).toContain(
      `Not in view of any pose, so not scored: cornell/${names[names.length - 1]}.`,
    );
  });

  it("prints no such line when every object is in view", () => {
    const root = tempRoot();
    cornell(root);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    expect(runSameness(["--scene", "gi:cornell", "--captures", root])).toBe(0);
    expect(lines.join("\n")).not.toContain("Not in view of any pose");
  });

  it("is reachable from pnpm unreal-look:compare --sameness", () => {
    const root = tempRoot();
    cornell(root);
    const before = process.exitCode;
    main(["--sameness", "--scene", "gi:cornell", "--captures", root]);
    expect(process.exitCode).toBe(0);
    process.exitCode = before;
    expect(readFileSync(path.join(root, "overlap/cornell/ID/cornell.png")).length).toBeGreaterThan(
      0,
    );
  });
});

describe("sameness gate: the committed Unreal frames", () => {
  const sceneInput = (committed?: string): ISamenessInput => ({
    scene: "cornell",
    pose: "cornell",
    unreal: path.join("cornell", "ID", "cornell.png"),
    threenative: path.join("cornell", "ID", "cornell.png"),
    colors: COLORS,
    overlap: path.join("cornell", "ID", "cornell.png"),
    ...(committed === undefined ? {} : { committed }),
  });
  function frameAt(file: string, png: PNG) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, PNG.sync.write(png));
  }
  const good = ["AAAA....", "AAAA.BB.", "AAAA.BB.", "AAAA...."];
  const lacksB = ["AAAA....", "AAAA....", "AAAA....", "AAAA...."];

  it("scores the committed frame when the root holds no Unreal capture of the scene", () => {
    const root = tempRoot();
    const committed = path.join(tempRoot(), "id", "cornell.png");
    frameAt(committed, frame(good));
    frameAt(path.join(root, "threenative", "cornell", "ID", "cornell.png"), frame(good));
    const report = samenessReport([sceneInput(committed)], root);
    expect(report.cells.map((c) => c.pass)).toEqual([true]);
    expect(report.committed).toEqual(["cornell"]);
  });

  it("scores a captured frame before the committed one", () => {
    const root = tempRoot();
    const committed = path.join(tempRoot(), "id", "cornell.png");
    frameAt(committed, frame(good));
    frameAt(path.join(root, "unreal", "cornell", "ID", "cornell.png"), frame(lacksB));
    frameAt(path.join(root, "threenative", "cornell", "ID", "cornell.png"), frame(good));
    const report = samenessReport([sceneInput(committed)], root);
    expect(report.cells.map((c) => c.pass)).toEqual([false]);
    expect(report.committed).toEqual([]);
  });

  it("fails closed on a pose a capture folder lacks, and on a committed frame that is missing", () => {
    const root = tempRoot();
    const committed = path.join(tempRoot(), "id", "cornell.png");
    frameAt(committed, frame(good));
    frameAt(path.join(root, "threenative", "cornell", "ID", "cornell.png"), frame(good));
    frameAt(path.join(root, "unreal", "cornell", "ID", "other.png"), frame(good));
    expect(() => samenessReport([sceneInput(committed)], root)).toThrow(
      /^TN_UNREAL_LOOK_MISSING_CELL: .*unreal\/cornell\/ID\/cornell\.png$/,
    );
    const bare = tempRoot();
    frameAt(path.join(bare, "threenative", "cornell", "ID", "cornell.png"), frame(good));
    expect(() => samenessReport([sceneInput(path.join(tempRoot(), "none.png"))], bare)).toThrow(
      /^TN_UNREAL_LOOK_MISSING_CELL: .*none\.png$/,
    );
  });

  it("marks the committed frames of the GI scenes that have them, and none of the reference scene", () => {
    const inputs = samenessInputs("gi:cornell");
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) {
      expect(i.committed, i.pose).toMatch(/gi\/cornell\/id\/.+\.png$/);
      expect(existsSync(i.committed as string), i.pose).toBe(true);
    }
    for (const i of samenessInputs("reference")) expect(i.committed).toBeUndefined();
  });

  it("runs the command on ThreeNative frames alone, and says whose Unreal frames it used", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = tempRoot();
    // The committed Unreal frames drawn as the other engine: identical, so every pose passes.
    for (const input of samenessInputs("gi:cornell"))
      frameAt(
        path.join(root, "threenative", input.threenative),
        PNG.sync.read(readFileSync(input.committed as string)),
      );
    expect(runSameness(["--scene", "gi:cornell", "--captures", root])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Unreal frames of cornell: the committed ones",
    );
    log.mockRestore();
  });
});

describe("depth ties: slabs that share a face a camera can see", () => {
  const slab = (name: string, position: number[], size: number[], extra = {}) =>
    ({ name, position, size, rotationYDeg: 0, ...extra }) as never;
  // The cornell box before PRD-646 fixed it: the side wall was as tall as the floor and the ceiling
  // together, so its front face at z = 0 overlapped the front face of each of them.
  const slabs = (wallHeight: number) => [
    slab("Floor", [0, -0.1, -2.85], [5.9, 0.2, 5.7]),
    slab("Wall_Red", [-2.85, 2.75, -2.85], [0.2, wallHeight, 5.7]),
  ];
  const camera = { name: "cornell", position: [0, 2.75, 6] as [number, number, number] };
  const scene = (meshes: unknown[], poses = [camera]) => ({ meshes, poses }) as never;

  it("names the four corner squares of the old cornell box", () => {
    expect(depthTies(scene(slabs(5.9)))).toEqual([
      "Floor / Wall_Red share the z+ face at 0.000 m (0.040 m2), seen from cornell",
    ]);
  });

  it("finds none when the wall ends at the ceiling", () => {
    expect(depthTies(scene(slabs(5.5)))).toEqual([]);
  });

  it("ignores a face that no pose camera is on the side of", () => {
    // The camera is inside the box: the outer faces of floor and wall are coplanar and never seen.
    const inside = { name: "inside", position: [0, 1, -2] as [number, number, number] };
    expect(depthTies(scene(slabs(5.5), [inside]))).toEqual([]);
    expect(depthTies(scene(slabs(5.9), [inside]))).toEqual([]);
  });

  it("skips a turned mesh, a tilted mesh and a model instance", () => {
    const [floor, wall] = slabs(5.9) as unknown as Record<string, unknown>[];
    for (const odd of [
      { rotationYDeg: 17 },
      { rotationXDeg: 15 },
      { size: undefined, asset: "pine01" },
    ])
      expect(depthTies(scene([floor, { ...wall, ...odd }]))).toEqual([]);
  });

  it("measures a slab turned a quarter about the vertical by its turned footprint", () => {
    const [floor, wall] = slabs(5.9) as unknown as { size: number[]; position: number[] }[];
    const [w, h, d] = wall?.size ?? [];
    expect(
      depthTies(
        scene([
          floor,
          { ...wall, size: [d, h, w], rotationYDeg: 90 },
          slab("Far", [9, 9, 9], [1, 1, 1]),
        ]),
      ),
    ).toHaveLength(1);
  });

  it("prefixes each tie with its scene, and skips a scene without one", () => {
    const read = (name: string) => scene(slabs(name === "cornell" ? 5.9 : 5.5));
    expect(depthTieNotes(["cornell", "sunlit-room"], read)).toEqual([
      "possible cause, cornell: Floor / Wall_Red share the z+ face at 0.000 m (0.040 m2), seen from cornell",
    ]);
  });

  it("prints the ties of a failing scene under the tables, and nothing for a passing one", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cornell = scene(slabs(5.9));
    const root = tempRoot();
    const names = ["cornell", "corner"];
    for (const engine of ["unreal", "threenative"])
      for (const pose of names) {
        const file = path.join(root, engine, "cornell", "ID", `${pose}.png`);
        mkdirSync(path.dirname(file), { recursive: true });
        // ThreeNative draws object B nowhere: the pose fails.
        writeFileSync(
          file,
          PNG.sync.write(
            frame(engine === "unreal" ? ["AB"] : ["A."], { A: [255, 0, 0], B: [0, 255, 0] }),
          ),
        );
      }
    runSameness(["--scene", "gi:cornell", "--captures", root], () => cornell);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "possible cause, cornell: Floor / Wall_Red share the z+ face at 0.000 m (0.040 m2)",
    );
    log.mockClear();
    runSameness(["--scene", "gi:cornell", "--captures", root], () => scene(slabs(5.5)));
    expect(log.mock.calls.flat().join("\n")).not.toContain("possible cause");
    log.mockRestore();
  });

  it("finds no tie in the committed scenes whose slabs a camera sees whole", () => {
    // lamp-room keeps four 0.1 m squares at its open front. The gate passes there, so it is left as it is.
    for (const name of ["gi:cornell", "gi:sunlit-room", "shadow:penumbra-lab"])
      expect(depthTies(readScene(name).scene), name).toEqual([]);
  });
});
