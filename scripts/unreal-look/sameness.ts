/**
 * PRD-646 sameness gate: do both engines draw the same scene?
 *
 *   pnpm unreal-look:compare --sameness [--scene reference|gi|shadow|gi:<name>|shadow:<name>,...]
 *                                       [--captures <root>]
 *
 * Both engines render the ID layer of every pose: each object in its own flat colour (regions.json for
 * the reference scene, scene.json `regions` for a calibration scene), the frames the capture
 * commands already write (`--layers ID`). The gate reads them from <root>/{unreal,threenative}/ and scores
 * every object in every pose: the silhouette overlap (IoU, reported) and the edge distance (the verdict).
 * The edge distance counts the pixels of the object that lie more than 1 px from the other engine's
 * drawing of it. Two rasterizers that draw the same geometry differ by one pixel at an edge (AC-1:
 * region-ID edges within 1 px), and by a few pixels where two surfaces meet at a grazing angle. A wall at
 * another height, a corner two engines resolve differently and an object in another place differ by
 * hundreds. IoU cannot tell these apart: a correct 45 px sphere scores 0.91 to 0.97 on that one pixel,
 * while a 22 px corner of a 57000 px floor scores 0.977.
 *
 * It fails closed: a missing frame, frames of two sizes, a pose that shows no object, an object only one
 * engine draws, and a frame with more pixels of no ID colour than the limit all fail. A frame per pose
 * goes to <root>/overlap/ with the disagreements marked, for the sheet of a mismatch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { type IImage, type IMasks, decode, iou, known, masks } from "./compare.js";
import { familyOf, readScene, registry, sceneKey, sceneNames } from "./gi.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");
/**
 * How far, in pixels, a pixel of an object may lie from the other engine's drawing of it (Chebyshev
 * distance: a diagonal neighbour is one pixel). PRD-646 AC-1 asks for "region-ID edges within 1 px of
 * Unreal's": every ring of rasterizer noise is one pixel wide.
 */
export const EDGE_GAP_LIMIT = 1;
/**
 * How many pixels of one object may lie farther than `EDGE_GAP_LIMIT` from the other engine's drawing of
 * it. Where two surfaces meet at a grazing angle (a sphere on a floor) one pixel of rounding moves the
 * wedge between them by a few pixels. Measured: 0 on every object of the reference scene's exterior pose,
 * of sunlit-room, penumbra-lab and lamp-room, and 1 to 5 in the reference scene's spheres pose (the
 * floor the most). The defects found have 24 or more: the leaf cards and grass of the first foliage scene
 * 24 to 106, the four floor corners that cornell drew under the wall in one engine and over it in the
 * other 1012. Twice the worst of the first group, the idiom of `deriveThresholds`.
 */
export const EDGE_FAR_LIMIT = 10;
/**
 * The most pixels of a frame that may carry no ID colour. Both engines draw the ID layer aliased, so a
 * pixel with no object colour appears only where an object's texture strays from its ID colour: none
 * in any frame measured but the foliage cards (0.35% to 0.58%). Three times the worst, rounded: a wrongly
 * coloured object of a few per cent of the frame would stay out of the overlap score, and this catches it.
 */
export const NO_ID_LIMIT = 0.02;

type Mask = Uint8Array;

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}

/** One pose of one scene: where its two ID frames live and the colour of each object in them. */
export interface ISamenessInput {
  /** `reference`, a GI scene's bare name, or `shadow:<name>`. */
  scene: string;
  pose: string;
  /** Frame paths under the capture root, per engine. */
  unreal: string;
  threenative: string;
  colors: Record<string, readonly number[]>;
  /** The overlap frame this pose writes under the capture root. */
  overlap: string;
}
export interface ISamenessRow {
  scene: string;
  pose: string;
  object: string;
  unrealPx: number;
  threenativePx: number;
  /** Reported, never the verdict: it is size dependent. */
  iou: number;
  /** The farthest any pixel of the object lies from the other engine's drawing of it; Infinity when one engine does not draw it. */
  gap: number;
  /** The pixels of the object that lie farther than `EDGE_GAP_LIMIT` from the other engine's drawing of it. */
  far: number;
  /** ThreeNative centroid minus Unreal's, in pixels; null when one engine does not draw the object. */
  shift: [number, number] | null;
  pass: boolean;
}
export interface ISamenessCell {
  rows: ISamenessRow[];
  /** The share of each frame's pixels that carry no object colour: a colour that is no ID. */
  unknown: { unreal: number; threenative: number };
  /** The share of the pixels that both frames give an object colour, where they give the same one. */
  agree: number;
  /** The pixels of every failing object that the two frames draw differently: what the overlap frame marks. */
  violations: Mask;
  pass: boolean;
}

function centroid(mask: Mask, width: number): { count: number; x: number; y: number } {
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      count += 1;
      sx += i % width;
      sy += Math.floor(i / width);
    }
  return { count, x: sx / count, y: sy / count };
}

function unknownShare(frame: IMasks): number {
  const seen = known(frame);
  let unknown = 0;
  for (let i = 0; i < seen.length; i++) if (!seen[i]) unknown += 1;
  return unknown / seen.length;
}

interface IBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** The smallest box around the set pixels of both masks; null when neither has one. */
function boxOf(a: Mask, b: Mask, width: number): IBox | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = x0;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < a.length; i++)
    if (a[i] || b[i]) {
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The Chebyshev distance from each pixel of `box` to the nearest set pixel of `mask`: two passes, exact. */
function distanceTo(mask: Mask, box: IBox, width: number): Int32Array {
  const { x0, y0, w, h } = box;
  const far = w + h;
  const d = new Int32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) d[y * w + x] = mask[(y0 + y) * width + x0 + x] ? 0 : far;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i] as number;
      if (x > 0) v = Math.min(v, (d[i - 1] as number) + 1);
      if (y > 0) {
        v = Math.min(v, (d[i - w] as number) + 1);
        if (x > 0) v = Math.min(v, (d[i - w - 1] as number) + 1);
        if (x < w - 1) v = Math.min(v, (d[i - w + 1] as number) + 1);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i] as number;
      if (x < w - 1) v = Math.min(v, (d[i + 1] as number) + 1);
      if (y < h - 1) {
        v = Math.min(v, (d[i + w] as number) + 1);
        if (x < w - 1) v = Math.min(v, (d[i + w + 1] as number) + 1);
        if (x > 0) v = Math.min(v, (d[i + w - 1] as number) + 1);
      }
      d[i] = v;
    }
  return d;
}

/**
 * The edge distance of two masks that both have pixels: the farthest any pixel of one lies from the other,
 * and how many pixels of either lie farther than `limit`.
 */
function edgeDistance(
  a: Mask,
  b: Mask,
  width: number,
  limit: number,
): { gap: number; far: number } {
  const box = boxOf(a, b, width);
  let gap = 0;
  let far = 0;
  if (box === null) return { gap, far };
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const d = distanceTo(to, box, width);
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++)
        if (from[(box.y0 + y) * width + box.x0 + x]) {
          const v = d[y * box.w + x] as number;
          gap = Math.max(gap, v);
          if (v > limit) far += 1;
        }
  }
  return { gap, far };
}

/** The region of each pixel as an index into Object.keys(frame.regions); -1 for a pixel with none. */
function labels(frame: IMasks): Int8Array {
  const out = new Int8Array(frame.width * frame.height).fill(-1);
  Object.values(frame.regions).forEach((mask, index) => {
    for (let i = 0; i < mask.length; i++) if (mask[i]) out[i] = index;
  });
  return out;
}

/** Scores every object either engine draws in one pose. Pure: the two frames' masks in, rows out. */
export function samenessCell(
  input: Pick<ISamenessInput, "scene" | "pose">,
  unreal: IMasks,
  threenative: IMasks,
  limit: number = EDGE_GAP_LIMIT,
  allowed: number = EDGE_FAR_LIMIT,
): ISamenessCell {
  const cell = `${input.scene}/${input.pose}`;
  if (unreal.width !== threenative.width || unreal.height !== threenative.height)
    fail(
      "SIZE_MISMATCH",
      `${cell}: Unreal ${unreal.width}x${unreal.height}, ThreeNative ${threenative.width}x${threenative.height}`,
    );
  const { width } = unreal;
  const seenByBoth = new Uint8Array(width * unreal.height);
  const ku = known(unreal);
  const kt = known(threenative);
  for (let i = 0; i < seenByBoth.length; i++) seenByBoth[i] = ku[i] && kt[i] ? 1 : 0;
  const violations = new Uint8Array(seenByBoth.length);
  const rows: ISamenessRow[] = [];
  for (const object of Object.keys(unreal.regions)) {
    if (object === "Sky") continue;
    const ua = centroid(unreal.regions[object] as Mask, width);
    const tb = centroid(
      threenative.regions[object] ?? fail("EMPTY_MASK", `${cell}/${object}`),
      width,
    );
    // Out of view in both engines: nothing to compare in this pose.
    if (ua.count === 0 && tb.count === 0) continue;
    // Only the pixels both frames give an object colour are scored: a pixel with none (a colour that is
    // no ID) says nothing about where the object is.
    const a = new Uint8Array(seenByBoth.length);
    const b = new Uint8Array(seenByBoth.length);
    for (let i = 0; i < a.length; i++)
      if (seenByBoth[i]) {
        a[i] = (unreal.regions[object] as Mask)[i] as number;
        b[i] = (threenative.regions[object] as Mask)[i] as number;
      }
    // An object only one engine draws has no overlap and no edge to compare. One whose every pixel the
    // other frame draws in a colour that is no ID has none either.
    const both = ua.count > 0 && tb.count > 0 && a.some(Boolean) && b.some(Boolean);
    const { gap, far } = both
      ? edgeDistance(a, b, width, limit)
      : { gap: Number.POSITIVE_INFINITY, far: 0 };
    const pass = both && far <= allowed;
    if (!pass) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) violations[i] = 1;
    rows.push({
      scene: input.scene,
      pose: input.pose,
      object,
      unrealPx: ua.count,
      threenativePx: tb.count,
      iou: both ? iou(a, b) : 0,
      gap,
      far,
      shift: ua.count > 0 && tb.count > 0 ? [tb.x - ua.x, tb.y - ua.y] : null,
      pass,
    });
  }
  if (rows.length === 0) fail("EMPTY_MASK", `${cell}: neither frame shows an object`);
  const lu = labels(unreal);
  const lt = labels(threenative);
  let seen = 0;
  let agreeing = 0;
  for (let i = 0; i < lu.length; i++)
    if (seenByBoth[i]) {
      seen += 1;
      if (lu[i] === lt[i]) agreeing += 1;
    }
  const unknown = { unreal: unknownShare(unreal), threenative: unknownShare(threenative) };
  return {
    rows,
    unknown,
    agree: seen === 0 ? 0 : agreeing / seen,
    violations,
    pass: rows.every((r) => r.pass) && Math.max(unknown.unreal, unknown.threenative) <= NO_ID_LIMIT,
  };
}

/**
 * The overlap frame of one pose. An object both engines draw the same way is dimmed to a third of its
 * colour, so the scene stays readable. Grey: the engines differ there by an edge that is within the limit.
 * White: the engines draw different objects there, in an object that fails. Blue: the ThreeNative frame has
 * a colour that is no ID where Unreal has an object. Red: the other way round. Black: no ID in either.
 */
export function overlapFrame(
  unreal: IMasks,
  threenative: IMasks,
  colors: Record<string, readonly number[]>,
  violations?: Mask,
): PNG {
  const names = Object.keys(unreal.regions);
  const a = labels(unreal);
  const b = labels(threenative);
  const png = new PNG({ width: unreal.width, height: unreal.height });
  for (let i = 0; i < a.length; i++) {
    let rgb: readonly number[] = [0, 0, 0];
    if (a[i] !== -1 && b[i] !== -1)
      rgb =
        a[i] === b[i]
          ? (colors[names[a[i] as number] ?? ""] ?? [0, 0, 0]).map((c) => Math.round(c / 3))
          : violations === undefined || violations[i]
            ? [255, 255, 255]
            : [128, 128, 128];
    else if (a[i] !== -1 || b[i] !== -1) rgb = a[i] !== -1 ? [0, 0, 255] : [255, 0, 0];
    png.data.set([...rgb, 255], i * 4);
  }
  return png;
}

function load(file: string, colors: Record<string, readonly number[]>): IMasks {
  if (!existsSync(file)) fail("MISSING_CELL", file);
  return masks(decode(readFileSync(file), "png"), colors);
}

export interface ISamenessReport {
  rows: ISamenessRow[];
  cells: {
    scene: string;
    pose: string;
    unknown: ISamenessCell["unknown"];
    agree: number;
    pass: boolean;
  }[];
  limit: number;
  allowed: number;
}

/** Scores every input pose from the frames under `root`, and writes each pose's overlap frame. */
export function samenessReport(
  inputs: readonly ISamenessInput[],
  root: string,
  limit: number = EDGE_GAP_LIMIT,
  allowed: number = EDGE_FAR_LIMIT,
): ISamenessReport {
  if (inputs.length === 0) fail("BAD_INPUT", "the sameness gate selects no pose");
  const report: ISamenessReport = { rows: [], cells: [], limit, allowed };
  for (const input of inputs) {
    const unreal = load(path.join(root, "unreal", input.unreal), input.colors);
    const threenative = load(path.join(root, "threenative", input.threenative), input.colors);
    const cell = samenessCell(input, unreal, threenative, limit, allowed);
    const file = path.join(root, "overlap", input.overlap);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      PNG.sync.write(overlapFrame(unreal, threenative, input.colors, cell.violations)),
    );
    report.rows.push(...cell.rows);
    report.cells.push({
      scene: input.scene,
      pose: input.pose,
      unknown: cell.unknown,
      agree: cell.agree,
      pass: cell.pass,
    });
  }
  return report;
}

/** Every pose of the scenes `selection` names; none selects the reference scene and every registered scene. */
export function samenessInputs(selection?: string): ISamenessInput[] {
  const tokens = selection === undefined ? ["reference", "gi", "shadow"] : selection.split(",");
  for (const token of tokens)
    if (token !== "reference" && !["gi", "shadow"].includes(token.split(":")[0] ?? ""))
      fail("BAD_INPUT", `--scene ${selection}: reference, gi[:name] or shadow[:name]`);
  const inputs: ISamenessInput[] = [];
  if (tokens.includes("reference")) {
    const poses = JSON.parse(readFileSync(path.join(REFERENCE, "poses.json"), "utf8")) as {
      poses: { name: string }[];
    };
    const regions = JSON.parse(readFileSync(path.join(REFERENCE, "regions.json"), "utf8")) as {
      srgb8: Record<string, number[]>;
    };
    for (const { name } of poses.poses) {
      const frame = path.join("ID", `ID_${name}.png`);
      inputs.push({
        scene: "reference",
        pose: name,
        unreal: frame,
        threenative: frame,
        colors: regions.srgb8,
        overlap: frame,
      });
    }
  }
  for (const family of ["gi", "shadow"]) {
    const group = tokens.filter((t) => t.split(":")[0] === family);
    if (group.length === 0) continue;
    const value = group.join(",");
    for (const name of sceneNames(
      value,
      registry(familyOf(value)).scenes.map((s) => s.name),
    )) {
      const { scene } = readScene(name);
      for (const pose of scene.poses) {
        const frame = path.join(sceneKey(name), "ID", `${pose.name}.png`);
        inputs.push({
          scene: name,
          pose: pose.name,
          unreal: frame,
          threenative: frame,
          colors: scene.regions,
          overlap: frame,
        });
      }
    }
  }
  return inputs;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** The markdown report: one row per object, then one per pose. */
export function samenessTables(report: ISamenessReport): string {
  const f = (v: number, d = 4) => v.toFixed(d);
  const gap = (v: number) => (Number.isFinite(v) ? String(v) : "∞");
  const shift = (r: ISamenessRow) => (r.shift ? `${f(r.shift[0], 1)}, ${f(r.shift[1], 1)}` : "—");
  const objects = report.rows.map(
    (r) =>
      `| ${r.scene} | ${r.pose} | ${r.object} | ${r.unrealPx} | ${r.threenativePx} | ${shift(r)} | ${f(r.iou)} | ${gap(r.gap)} | ${Number.isFinite(r.gap) ? r.far : "∞"} | ${r.pass ? "PASS" : "FAIL"} |`,
  );
  const poses = report.cells.map((cell) => {
    const rows = report.rows.filter((r) => r.scene === cell.scene && r.pose === cell.pose);
    // An object one engine lacks (gap Infinity) is worse than any count of pixels.
    const worst = rows.reduce((a, b) =>
      b.gap === Number.POSITIVE_INFINITY || (a.gap !== Number.POSITIVE_INFINITY && b.far > a.far)
        ? b
        : a,
    );
    const lowest = rows.reduce((a, b) => (b.iou < a.iou ? b : a));
    return `| ${cell.scene} | ${cell.pose} | ${rows.length} | ${worst.object} | ${gap(worst.gap)} | ${Number.isFinite(worst.gap) ? worst.far : "∞"} | ${f(lowest.iou)} | ${f(cell.agree * 100, 2)} | ${f(cell.unknown.unreal * 100, 2)} / ${f(cell.unknown.threenative * 100, 2)} | ${cell.pass ? "PASS" : "FAIL"} |`;
  });
  return [
    `### ID layer, both engines: edge distance and silhouette overlap per object (pass with at most ${report.allowed} px farther than ${report.limit} px from the other engine's object)`,
    "",
    `| scene | pose | object | UE px | TN px | TN-UE centroid px | IoU | farthest px | px beyond ${report.limit} px | verdict |`,
    "|---|---|---|---:|---:|---|---:|---:|---:|---|",
    ...objects,
    "",
    `### ID layer, both engines: per pose (a frame passes with at most ${NO_ID_LIMIT * 100}% of pixels without an ID colour)`,
    "",
    "| scene | pose | objects | worst object | farthest px | px beyond limit | lowest IoU | pixels that agree % | no-ID pixels % UE / TN | verdict |",
    "|---|---|---:|---|---:|---:|---:|---:|---|---|",
    ...poses,
  ].join("\n");
}

export function runSameness(args: readonly string[]): number {
  const root = path.resolve(flag(args, "--captures") ?? path.join(REFERENCE, "captures"));
  const report = samenessReport(samenessInputs(flag(args, "--scene")), root);
  console.log(samenessTables(report));
  const failing = report.cells.filter((c) => !c.pass);
  const worst = report.rows.reduce((a, b) => (b.gap > a.gap ? b : a));
  console.log(
    `\nsameness: ${report.rows.length} objects in ${report.cells.length} poses, farthest edge ${Number.isFinite(worst.gap) ? worst.gap : "∞"} px (${worst.scene}/${worst.pose}/${worst.object}), ${failing.length} poses fail (more than ${report.allowed} px beyond ${report.limit} px, or an object one engine lacks); overlap frames in ${path.join(root, "overlap")}`,
  );
  return failing.length === 0 ? 0 : 1;
}
