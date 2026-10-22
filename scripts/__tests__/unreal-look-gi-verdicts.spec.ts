import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { type IRow, type IThresholdFile, layerThresholds } from "../unreal-look/compare.js";
import { compareGiToUnreal, readScene, sceneKey } from "../unreal-look/gi.js";

const W = 16;
const H = 16;
const LIMITS: IThresholdFile = {
  iou: 0.98,
  layers: {
    L1: { deltaE: 1, dP50: 0.01 },
    L5: { deltaE: 1, dP50: 0.01 },
    L7: { deltaE: 1, dP50: 0.01 },
  },
};

function png(fill: (x: number, y: number) => [number, number, number]): Buffer {
  const image = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = fill(x, y);
      image.data.set([r, g, b, 255], (y * W + x) * 4);
    }
  return PNG.sync.write(image);
}
const gray = (value: number) => png(() => [value, value, value]);
const tinted = (r: number, g: number, b: number) => png(() => [r, g, b]);

function put(file: string, data: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** The scene's ID frame: one row of the frame per region, painted in the region's ID colour. */
function idFrame(scene: string, shift = 0): Buffer {
  const colors = Object.values(readScene(scene).scene.regions);
  return png((_x, y) => colors[(y + shift) % colors.length] as [number, number, number]);
}

/**
 * A capture root of one scene and one layer. Unreal shows a flat grey of 100 at `variant` in every pose. ThreeNative shows
 * the same grey, except in the poses `frames` names.
 */
function root(scene: string, layer: string, variant: string, frames: Record<string, Buffer>) {
  const base = path.join(mkdtempSync(path.join(os.tmpdir(), "tn-gi-verdict-")), "root");
  const key = sceneKey(scene);
  for (const { name: pose } of readScene(scene).scene.poses) {
    put(path.join(base, "unreal", key, "ID", `${pose}.png`), idFrame(scene));
    put(path.join(base, "unreal", key, variant, `${pose}.png`), gray(100));
    put(path.join(base, "threenative", key, "ID", `${pose}.png`), idFrame(scene));
    put(path.join(base, "threenative", key, layer, `${pose}.png`), frames[pose] ?? gray(100));
  }
  return base;
}

const verdicts = (rows: readonly IRow[], pose: string, scene: string) => [
  ...new Set(rows.filter((r) => r.cell === `${scene}/${pose}`).map((r) => r.pass)),
];

describe("layerThresholds (PRD-631 limits)", () => {
  it("overlays the limits of one layer on the flat ones, and reads no file as no limits", () => {
    const file = { deltaE: 3, layers: { L1: { deltaE: 1, dP50: 0.01 }, L7: { dP50: 0.05 } } };
    expect(layerThresholds(file, "L1")).toEqual({ deltaE: 1, dP50: 0.01 });
    expect(layerThresholds(file, "L7")).toEqual({ deltaE: 3, dP50: 0.05 });
    expect(layerThresholds(file, "L5")).toEqual({ deltaE: 3 });
    expect(layerThresholds(null, "L1")).toBeUndefined();
  });
});

describe("compareGiToUnreal verdicts (PRD-631 limits)", () => {
  const scene = "cornell";

  it("fails a row over its dP50 limit and passes a row inside it", () => {
    // "cornell" equals Unreal's L1; "corner" is 90 percent too bright.
    const base = root(scene, "L1", "L1", { corner: gray(190) });
    const rows = compareGiToUnreal(scene, ["L1"], base, undefined, LIMITS);
    expect(verdicts(rows, "cornell", scene)).toEqual([true]);
    expect(verdicts(rows, "corner", scene)).toEqual([false]);
  });

  it("fails a row over its deltaE limit although its luminance holds", () => {
    // A cast of the same brightness: the p50 differs by less than 1 percent, the colour by more than 1 deltaE.
    const base = root(scene, "L1", "L1", { cornell: tinted(104, 98, 102) });
    const rows = compareGiToUnreal(scene, ["L1"], base, undefined, LIMITS);
    const [row] = rows.filter((r) => r.cell === `${scene}/cornell`);
    expect(row?.dP50).toBeLessThan(0.01);
    expect(row?.deltaE).toBeGreaterThan(1);
    expect(verdicts(rows, "cornell", scene)).toEqual([false]);
  });

  it("reads an ID edge below the IoU limit as a fail", () => {
    const base = root(scene, "L1", "L1", {});
    // Every region moved one row in one pose: the light matches, the edge does not.
    put(path.join(base, "threenative", sceneKey(scene), "ID", "cornell.png"), idFrame(scene, 1));
    const rows = compareGiToUnreal(scene, ["L1"], base, undefined, LIMITS);
    const moved = rows.filter((r) => r.cell === `${scene}/cornell`);
    expect(moved.map((r) => [r.dP50, r.iou, r.pass])).toEqual(moved.map(() => [0, 0, false]));
    expect(verdicts(rows, "corner", scene)).toEqual([true]);
  });

  it("fails closed when no limit applies to the light: no file, no limits, a layer without an entry", () => {
    const base = root(scene, "L1", "L1", {});
    // A flat IoU limit alone leaves the light unchecked, so it does not make a row pass.
    const files = [
      null,
      {},
      { iou: 0.98 },
      { iou: 0.98, layers: { L7: { deltaE: 1, dP50: 0.01 } } },
    ];
    for (const file of files) {
      const rows = compareGiToUnreal(scene, ["L1"], base, undefined, file);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.pass === false)).toBe(true);
    }
  });

  it("judges a quality tier by the limits of its ladder layer", () => {
    // L7-high pairs with Unreal's L7-Epic frame, and thresholds.json keys its limits by L7.
    const base = root(scene, "L7-high", "L7-Epic", { corner: gray(190) });
    const rows = compareGiToUnreal(scene, ["L7-high"], base, undefined, LIMITS);
    expect(verdicts(rows, "cornell", scene)).toEqual([true]);
    expect(verdicts(rows, "corner", scene)).toEqual([false]);
    // A tier whose ladder layer has no entry still fails closed.
    const none = { iou: 0.98, layers: { L1: { deltaE: 1, dP50: 0.01 } } };
    const closed = compareGiToUnreal(scene, ["L7-high"], base, undefined, none);
    expect(closed.every((r) => r.pass === false)).toBe(true);
  });

  it("reads the committed thresholds.json when it is not given one", () => {
    const base = root(scene, "L1", "L1", { corner: gray(190) });
    const rows = compareGiToUnreal(scene, ["L1"], base);
    expect(verdicts(rows, "cornell", scene)).toEqual([true]);
    expect(verdicts(rows, "corner", scene)).toEqual([false]);
  });
});

describe("the shadow family shares the verdict (PRD-649)", () => {
  const scene = "shadow:lamp-room";

  it("fails a shadow row over its limit and passes a matching one", () => {
    const base = root(scene, "L5", "L5", { point: gray(190) });
    const rows = compareGiToUnreal(scene, ["L5"], base, undefined, LIMITS);
    expect(verdicts(rows, "spot", scene)).toEqual([true]);
    expect(verdicts(rows, "point", scene)).toEqual([false]);
    expect(
      compareGiToUnreal(scene, ["L5"], base, undefined, {}).every((r) => r.pass === false),
    ).toBe(true);
  });

  it("judges a shadow tier by the limits of its ladder layer", () => {
    const base = root(scene, "L5-Low", "L5-Low", { point: gray(190) });
    const rows = compareGiToUnreal(scene, ["L5-Low"], base, undefined, LIMITS);
    expect(verdicts(rows, "spot", scene)).toEqual([true]);
    expect(verdicts(rows, "point", scene)).toEqual([false]);
  });
});
