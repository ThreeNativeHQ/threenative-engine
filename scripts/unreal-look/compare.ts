import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { curveShape, exposureCurve } from "./exposureCurve.js";
import { compareGi } from "./gi.js";
import { floorEdges, linearLuminance, matchedWidths } from "./penumbra.js";
// Three.js belongs to core's dependency graph; root scripts do not install a second copy.
const coreRequire = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const { FloatType } = await import(pathToFileURL(coreRequire.resolve("three")).href);
const { EXRLoader } = await import(
  pathToFileURL(coreRequire.resolve("three/examples/jsm/loaders/EXRLoader.js")).href
);

type Lab = [number, number, number];
type Mask = Uint8Array;
export interface IImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
  channels: number;
}
export interface IMasks {
  width: number;
  height: number;
  regions: Record<string, Mask>;
}
export interface IStats {
  p1: number;
  p50: number;
  p99: number;
  ev1: number | null;
  ev50: number | null;
  ev99: number | null;
  lab: Lab;
  pixels: number;
}
export interface IThresholds {
  deltaE?: number;
  dP50?: number;
  iou?: number;
  dEv?: number;
}
export interface IRow {
  layer: string;
  cell: string;
  region: string;
  unreal: IStats | null;
  threenative: IStats | null;
  deltaE: number | null;
  dP50: number | null;
  dEv50: number | null;
  iou: number | null;
  pass: boolean | null;
}
interface IReference {
  generatedAt: string;
  resolution: [number, number];
  cells: Record<string, Record<string, IStats>>;
}
export interface IOptions {
  referenceDir?: string;
  unreal?: string;
  threenative?: string;
  layers?: string[];
  suns?: string[];
  metric?: string;
  unrealVsUnreal?: string;
  writeMasks?: boolean;
  writeStats?: boolean;
  sheet?: boolean;
}

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) fail("BAD_INPUT", "missing value");
  return value;
}
function dimensions(a: { width: number; height: number }, b: { width: number; height: number }) {
  if (a.width !== b.width || a.height !== b.height)
    fail("SIZE_MISMATCH", `${a.width}x${a.height} versus ${b.width}x${b.height}`);
}
export function decode(bytes: Uint8Array, format: "png" | "exr" = "png"): IImage {
  try {
    if (format === "png") return { ...PNG.sync.read(Buffer.from(bytes)), channels: 4 };
    const buffer = new Uint8Array(bytes).buffer;
    const image = new EXRLoader().setDataType(FloatType).parse(buffer);
    const channels = image.data.length / (image.width * image.height);
    const data = new Float32Array(image.data.length);
    // EXRLoader returns bottom-up texture rows; PNG masks use a top-left origin.
    const stride = image.width * channels;
    for (let y = 0; y < image.height; y++)
      data.set(
        image.data.subarray((image.height - 1 - y) * stride, (image.height - y) * stride),
        y * stride,
      );
    return { width: image.width, height: image.height, data, channels };
  } catch (error) {
    return fail("BAD_INPUT", `cannot decode ${format}: ${String(error)}`);
  }
}
const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
export function classify(
  rgb: readonly number[],
  colors: Record<string, readonly number[]>,
): string | null {
  const near = (color: readonly number[]) =>
    color.every((v, c) => Math.abs(v - required(rgb[c])) <= 6);
  // Unreal writes its ID frames display-encoded: a linear 128 arrives as 187.
  const encoded = (color: readonly number[]) =>
    color.map((v) => Math.round(255 * linearToSrgb(v / 255)));
  if (near([0, 0, 0])) return "Sky";
  return (
    Object.entries(colors).find(([, color]) => near(color) || near(encoded(color)))?.[0] ?? null
  );
}
export function masks(image: IImage, colors: Record<string, readonly number[]>): IMasks {
  const regions: Record<string, Mask> = {};
  for (const name of ["Sky", ...Object.keys(colors)])
    regions[name] = new Uint8Array(image.width * image.height);
  for (let i = 0; i < image.width * image.height; i++) {
    const offset = i * image.channels;
    const name = classify(
      [
        required(image.data[offset]),
        required(image.data[offset + 1]),
        required(image.data[offset + 2]),
      ],
      colors,
    );
    if (name !== null) required(regions[name])[i] = 1;
  }
  return { width: image.width, height: image.height, regions };
}
function count(mask: Mask): number {
  return mask.reduce((a, b) => a + b, 0);
}
export function quantiles(
  values: readonly number[],
  fractions: readonly number[] = [0.01, 0.5, 0.99],
): number[] {
  if (!values.length) fail("EMPTY_MASK", "no measured pixels");
  if (!values.every(Number.isFinite)) fail("BAD_INPUT", "non-finite pixel measurement");
  const sorted = [...values].sort((a, b) => a - b);
  return fractions.map((f) => required(sorted[Math.max(0, Math.ceil(sorted.length * f) - 1)]));
}
// packages/playtest/src/capture.ts:75-76: display Rec.709, rounded to byte bins (no sRGB linearization).
function luminance(image: IImage, i: number): number {
  const o = i * image.channels;
  return (
    0.2126 * required(image.data[o]) +
    0.7152 * required(image.data[o + 1]) +
    0.0722 * required(image.data[o + 2])
  );
}
export function lab(rgb: readonly number[]): Lab {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Lab;
  const f = (v: number) => (v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function ciede2000(a: Lab, b: Lab): number {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a[1], a[2]);
  const c2 = Math.hypot(b[1], b[2]);
  const c = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a[1];
  const ap2 = (1 + g) * b[1];
  const cp1 = Math.hypot(ap1, a[2]);
  const cp2 = Math.hypot(ap2, b[2]);
  const hue = (x: number, y: number) => (Math.atan2(y, x) / rad + 360) % 360;
  const h1 = hue(ap1, a[2]);
  const h2 = hue(ap2, b[2]);
  const dl = b[0] - a[0];
  const dc = cp2 - cp1;
  let dh = h2 - h1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh * rad) / 2);
  const l = (a[0] + b[0]) / 2;
  const cp = (cp1 + cp2) / 2;
  let h = (h1 + h2) / 2;
  if (cp1 * cp2 === 0) h = h1 + h2;
  else if (Math.abs(h1 - h2) > 180) h += h1 + h2 < 360 ? 180 : -180;
  const t =
    1 -
    0.17 * Math.cos((h - 30) * rad) +
    0.24 * Math.cos(2 * h * rad) +
    0.32 * Math.cos((3 * h + 6) * rad) -
    0.2 * Math.cos((4 * h - 63) * rad);
  const sl = 1 + (0.015 * (l - 50) ** 2) / Math.sqrt(20 + (l - 50) ** 2);
  const sc = 1 + 0.045 * cp;
  const sh = 1 + 0.015 * cp * t;
  const rt =
    -2 *
    Math.sqrt(cp ** 7 / (cp ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((h - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}
export function iou(a: Mask, b: Mask): number {
  if (a.length !== b.length) fail("SIZE_MISMATCH", "IoU mask lengths differ");
  if (!count(a) || !count(b)) fail("EMPTY_MASK", "IoU region has no pixels");
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) intersection++;
    if (a[i] || b[i]) union++;
  }
  return intersection / union;
}
export function deriveMasks(base: IMasks, l5: IImage): IMasks {
  dimensions(base, l5);
  const floor = base.regions.Floor;
  if (!floor || !count(floor)) return { ...base, regions: { ...base.regions } };
  const values: number[] = [];
  for (let i = 0; i < floor.length; i++)
    if (floor[i]) values.push(Math.round((luminance(l5, i) / 255) * 255));
  const cutoff = 0.5 * required(quantiles(values, [0.9])[0]);
  const shadow = new Uint8Array(floor.length);
  const lit = new Uint8Array(floor.length);
  for (let i = 0; i < floor.length; i++)
    if (floor[i]) {
      if (Math.round((luminance(l5, i) / 255) * 255) < cutoff) shadow[i] = 1;
      else lit[i] = 1;
    }
  return { ...base, regions: { ...base.regions, ShadowedFloor: shadow, LitFloor: lit } };
}
export function measure(image: IImage, mask: Mask, exr?: IImage): IStats {
  if (mask.length !== image.width * image.height) fail("SIZE_MISMATCH", "image and mask differ");
  if (exr) dimensions(image, exr);
  const display: number[] = [];
  const ev: number[] = [];
  const colors: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < mask.length; i++)
    if (mask[i] && image.data[i * image.channels + 3] !== 0) {
      display.push(Math.round((luminance(image, i) / 255) * 255));
      const o = i * image.channels;
      const color = lab([
        required(image.data[o]),
        required(image.data[o + 1]),
        required(image.data[o + 2]),
      ]);
      for (let c = 0; c < 3; c++) required(colors[c]).push(required(color[c]));
      if (exr) ev.push(Math.log2(Math.max(2 ** -20, luminance(exr, i))));
    }
  const [p1, p50, p99] = quantiles(display) as Lab;
  const [ev1, ev50, ev99]: [number | null, number | null, number | null] = exr
    ? (quantiles(ev) as Lab)
    : [null, null, null];
  return {
    p1,
    p50,
    p99,
    ev1,
    ev50,
    ev99,
    lab: colors.map((c) => {
      const [lower, upper] = quantiles(c, [0.5, (Math.floor(c.length / 2) + 1) / c.length]);
      return (required(lower) + required(upper)) / 2;
    }) as Lab,
    pixels: display.length,
  };
}
function passes(row: IRow, thresholds?: IThresholds): boolean | null {
  if (!thresholds) return null;
  const checks: [number | null, number | undefined, boolean][] = [
    [row.deltaE, thresholds.deltaE, false],
    [row.dP50, thresholds.dP50, false],
    [row.dEv50 === null ? null : Math.abs(row.dEv50), thresholds.dEv, false],
    [row.iou, thresholds.iou, true],
  ];
  const evaluated = checks.filter(([value, limit]) => value !== null && limit !== undefined);
  return evaluated.length
    ? evaluated.every(([v, limit, minimum]) =>
        minimum ? required(v) >= required(limit) : required(v) <= required(limit),
      )
    : null;
}
function rowFor(
  layer: string,
  cell: string,
  region: string,
  a: IStats,
  b: IStats,
  thresholds?: IThresholds,
): IRow {
  const row: IRow = {
    layer,
    cell,
    region,
    unreal: a,
    threenative: b,
    deltaE: ciede2000(a.lab, b.lab),
    dP50: Math.abs(b.p50 - a.p50) / Math.max(a.p50, 1),
    dEv50: a.ev50 === null || b.ev50 === null ? null : b.ev50 - a.ev50,
    iou: null,
    pass: null,
  };
  row.pass = passes(row, thresholds);
  return row;
}
export function compareCells(input: {
  layer: string;
  cell: string;
  unreal?: IImage;
  threenative?: IImage;
  masks: IMasks;
  regions: string[];
  unrealExr?: IImage;
  otherExr?: IImage;
  reference?: Record<string, IStats>;
  thresholds?: IThresholds;
}): IRow[] {
  const { unreal, threenative, regions } = input;
  if (!threenative || (!unreal && !input.reference))
    fail("MISSING_CELL", `${input.layer}/${input.cell}`);
  dimensions(threenative, input.masks);
  if (unreal) dimensions(unreal, threenative);
  if (!regions.length) fail("EMPTY_MASK", `${input.cell}: empty evaluation set`);
  return regions.map((region) => {
    const mask = input.masks.regions[region];
    if (!mask || !count(mask)) fail("EMPTY_MASK", `${input.cell}/${region}`);
    const a = unreal ? measure(unreal, mask, input.unrealExr) : input.reference?.[region];
    if (!a) fail("MISSING_CELL", `${input.layer}/${input.cell}/${region} reference stats`);
    return rowFor(
      input.layer,
      input.cell,
      region,
      a,
      measure(threenative, mask, input.otherExr),
      input.thresholds,
    );
  });
}

function json(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return fail("BAD_INPUT", `${file}: ${String(error)}`);
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("BAD_INPUT", "expected JSON object");
  return value as Record<string, unknown>;
}
function names(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value) || !value.length) fail("BAD_INPUT", "expected non-empty names array");
  const result = value.map((item) => object(item).name);
  if (
    !result.every((name): name is string => typeof name === "string" && pattern.test(name)) ||
    new Set(result).size !== result.length
  )
    fail("BAD_INPUT", "invalid or duplicate names");
  return result;
}
function image(file: string): IImage {
  if (!existsSync(file)) fail("MISSING_CELL", file);
  return decode(readFileSync(file), file.endsWith(".exr") ? "exr" : "png");
}
function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(value, (_, v: unknown) => (typeof v === "number" ? Number(v.toPrecision(4)) : v))}\n`,
  );
}
function writePng(file: string, png: PNG) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
}
function pngOfMask(base: IMasks, mask: Mask): PNG {
  const png = new PNG({ width: base.width, height: base.height });
  for (let i = 0; i < mask.length; i++) {
    png.data.fill(mask[i] ? 255 : 0, i * 4, i * 4 + 3);
    png.data[i * 4 + 3] = 255;
  }
  return png;
}
function readReference(file: string): IReference {
  if (!existsSync(file)) fail("MISSING_CELL", file);
  const data = object(json(file));
  const resolution = data.resolution;
  if (
    !Array.isArray(resolution) ||
    resolution.length !== 2 ||
    !resolution.every((n) => Number.isSafeInteger(n) && n > 0) ||
    typeof data.generatedAt !== "string"
  )
    fail("BAD_INPUT", "invalid reference metadata");
  for (const regions of Object.values(object(data.cells)))
    for (const raw of Object.values(object(regions))) {
      const stats = object(raw);
      for (const key of ["p1", "p50", "p99", "pixels"])
        if (typeof stats[key] !== "number" || !Number.isFinite(stats[key]))
          fail("BAD_INPUT", `invalid stats ${key}`);
      if ((stats.pixels as number) <= 0) fail("EMPTY_MASK", "cached region has no pixels");
      for (const key of ["ev1", "ev50", "ev99"])
        if (stats[key] !== null && (typeof stats[key] !== "number" || !Number.isFinite(stats[key])))
          fail("BAD_INPUT", `invalid stats ${key}`);
      if (
        !Array.isArray(stats.lab) ||
        stats.lab.length !== 3 ||
        !stats.lab.every((v) => typeof v === "number" && Number.isFinite(v))
      )
        fail("BAD_INPUT", "invalid Lab stats");
    }
  return data as unknown as IReference;
}
function sheetPair(sheet: PNG, a: IImage, b: IImage, row: number) {
  for (const [column, source] of [a, b].entries())
    for (let y = 0; y < 360; y++)
      for (let x = 0; x < 640; x++) {
        const src =
          (Math.floor((y * source.height) / 360) * source.width +
            Math.floor((x * source.width) / 640)) *
          source.channels;
        const dst = ((row * 360 + y) * 1280 + column * 640 + x) * 4;
        for (let c = 0; c < 3; c++) sheet.data[dst + c] = required(source.data[src + c]);
        sheet.data[dst + 3] = 255;
      }
}
export function runComparison(options: IOptions = {}) {
  const dir = options.referenceDir ?? "tools/unreal-reference";
  const rootA = options.unreal ?? path.join(dir, "captures/unreal");
  const rootB =
    options.unrealVsUnreal ?? options.threenative ?? path.join(dir, "captures/threenative");
  const offline = !existsSync(rootA);
  const prepareOnly =
    !existsSync(rootB) &&
    Boolean(options.writeMasks || options.writeStats) &&
    !options.sheet &&
    !options.unrealVsUnreal;
  if (
    offline &&
    (options.writeMasks || options.writeStats || options.sheet || options.unrealVsUnreal)
  )
    fail("MISSING_CELL", "this mode requires Unreal captures");
  const posesData = object(json(path.join(dir, "poses.json")));
  const poses = names(posesData.poses, /^(exterior|spheres|interior|backlit)$/);
  const allSuns = names(posesData.suns, /^(sun60|sun15|sun04)$/);
  const allLayers = names(object(json(path.join(dir, "layers.json"))).layers, /^L[0-9]$/);
  const resolution = posesData.resolution;
  if (
    !Array.isArray(resolution) ||
    resolution.length !== 2 ||
    !resolution.every((v) => Number.isSafeInteger(v) && v > 0)
  )
    fail("BAD_INPUT", "invalid resolution");
  const colors = object(object(json(path.join(dir, "regions.json"))).srgb8);
  for (const color of Object.values(colors))
    if (
      !Array.isArray(color) ||
      color.length !== 3 ||
      !color.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    )
      fail("BAD_INPUT", "invalid region color");
  const palette = colors as Record<string, number[]>;
  const sunNames: Record<string, string> = { "60": "sun60", "15": "sun15", "4": "sun04" };
  const suns = options.suns?.map((sun) => sunNames[sun] ?? sun) ?? allSuns;
  if (!suns.length || suns.some((s) => !allSuns.includes(s))) fail("BAD_INPUT", "unknown sun");
  const cached = offline ? readReference(path.join(dir, "reference-stats.json")) : undefined;
  if (cached)
    dimensions(
      { width: resolution[0], height: resolution[1] },
      { width: cached.resolution[0], height: cached.resolution[1] },
    );
  const file = (root: string, layer: string, sun: string, pose: string, ext = "png") =>
    path.join(root, layer, `${layer}_${sun}_${pose}.${ext}`);
  const layers = [
    ...new Set(
      options.layers ??
        allLayers.filter((layer) =>
          suns.some((sun) =>
            poses.some(
              (pose) =>
                existsSync(file(rootA, layer, sun, pose)) ||
                existsSync(file(rootB, layer, sun, pose)) ||
                cached?.cells[`${layer}_${sun}_${pose}`],
            ),
          ),
        ),
    ),
  ];
  if (!layers.length && prepareOnly && options.writeMasks && !options.writeStats) layers.push("ID");
  if (!layers.length) fail("MISSING_CELL", "no layers present");
  if (layers.some((l) => !allLayers.includes(l) && l !== "ID")) fail("BAD_INPUT", "unknown layer");
  const thresholdFile = path.join(dir, "thresholds.json");
  const thresholds = existsSync(thresholdFile)
    ? (object(json(thresholdFile)) as IThresholds)
    : undefined;
  if (thresholds)
    for (const [key, value] of Object.entries(thresholds))
      if (
        !["deltaE", "dP50", "iou", "dEv"].includes(key) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (key === "iou" && value > 1)
      )
        fail("BAD_INPUT", "invalid thresholds");
  const reference: IReference = {
    generatedAt: new Date().toISOString(),
    resolution: resolution as [number, number],
    cells: {},
  };
  const rows: IRow[] = [];
  const exposure: {
    layer: string;
    cell: string;
    unrealP50: number;
    threenativeP50: number;
    dEv: number;
  }[] = [];
  const noise: { layer: string; cell: string; dP50: number }[] = [];
  const penumbra: {
    cell: string;
    matched: number;
    unrealPx: number;
    threenativePx: number;
    ratio: number;
  }[] = [];
  // `--metric curve`: the L8 frames of both arms, kept until the same cell's L9 is compared.
  const curveBase = new Map<string, { unreal: Float64Array; other: Float64Array }>();
  const curve: {
    cell: string;
    unreal: number[];
    threenative: number[];
    worst: number;
    level: number;
    shape: number;
  }[] = [];
  const sheets = new Map<string, PNG>();
  for (const layer of layers)
    if (options.sheet)
      sheets.set(
        layer,
        new PNG({ width: 1280, height: (layer === "ID" ? 1 : suns.length) * poses.length * 360 }),
      );
  for (const [poseIndex, pose] of poses.entries()) {
    const idPath = offline
      ? path.join(dir, "masks", `ID_${pose}.png`)
      : path.join(rootA, "ID", `ID_${pose}.png`);
    const idA = image(idPath);
    const base = masks(idA, palette);
    const regions = Object.keys(base.regions).filter(
      (r) => count(required(base.regions[r])) >= idA.width * idA.height * 0.002,
    );
    if (!regions.length) fail("EMPTY_MASK", `${pose}: empty evaluation set`);
    if (options.writeMasks)
      writePng(path.join(dir, "masks", `ID_${pose}.png`), PNG.sync.read(readFileSync(idPath)));
    let idB: IImage | undefined;
    let masksB: IMasks | undefined;
    if (!prepareOnly && (layers.includes("L0") || layers.includes("ID"))) {
      idB = image(path.join(rootB, "ID", `ID_${pose}.png`));
      dimensions(idA, idB);
      masksB = masks(idB, palette);
    }
    for (const [sunIndex, sun] of [...new Set(suns)].entries()) {
      let cellMasks = base;
      const l5Path = file(rootA, "L5", sun, pose);
      const shadowPath = path.join(dir, "masks", `shadow_${sun}_${pose}.png`);
      if (!offline && existsSync(l5Path)) {
        cellMasks = deriveMasks(base, image(l5Path));
        if (options.writeMasks && cellMasks.regions.ShadowedFloor)
          writePng(shadowPath, pngOfMask(base, cellMasks.regions.ShadowedFloor));
      } else if (offline && existsSync(shadowPath)) {
        const shadow = image(shadowPath);
        dimensions(base, shadow);
        const floor = required(base.regions.Floor);
        const dark = new Uint8Array(floor.length);
        const lit = new Uint8Array(floor.length);
        for (let i = 0; i < floor.length; i++)
          if (floor[i]) {
            if ([0, 1, 2].every((c) => required(shadow.data[i * shadow.channels + c]) >= 249))
              dark[i] = 1;
            else lit[i] = 1;
          }
        if (count(floor))
          cellMasks = { ...base, regions: { ...base.regions, ShadowedFloor: dark, LitFloor: lit } };
      } else if (layers.some((l) => /^L[5-9]$/.test(l)))
        fail("MISSING_CELL", offline ? shadowPath : l5Path);
      const evaluation = [
        ...regions,
        ...["LitFloor", "ShadowedFloor"].filter((r) => r in cellMasks.regions),
      ];
      for (const layer of layers) {
        const cell = `${sun}_${pose}`;
        if (layer === "ID" && masksB)
          for (const region of regions) {
            const row: IRow = {
              layer,
              cell: pose,
              region,
              unreal: null,
              threenative: null,
              deltaE: null,
              dP50: null,
              dEv50: null,
              iou: iou(required(base.regions[region]), required(masksB.regions[region])),
              pass: null,
            };
            // ID geometry is sun-independent: emit each pose once in ID mode.
            if (sunIndex === 0) {
              row.pass = passes(row, thresholds);
              rows.push(row);
            }
          }
        if (layer === "ID") {
          if (options.sheet && sunIndex === 0)
            sheetPair(required(sheets.get(layer)), idA, required(idB), poseIndex);
          continue;
        }
        if (prepareOnly && !options.writeStats) continue;
        const a = offline ? undefined : image(file(rootA, layer, sun, pose));
        const exrA = offline ? undefined : image(file(rootA, layer, sun, pose, "exr"));
        const key = `${layer}_${cell}`;
        const whole = new Uint8Array(base.width * base.height).fill(1);
        if (prepareOnly) {
          dimensions(required(a), base);
          reference.cells[key] = Object.fromEntries(
            [...evaluation, "WholeFrame"].map((region) => [
              region,
              measure(
                required(a),
                region === "WholeFrame" ? whole : required(cellMasks.regions[region]),
                exrA,
              ),
            ]),
          );
          continue;
        }
        const b = image(file(rootB, layer, sun, pose));
        const exrB = options.unrealVsUnreal
          ? image(file(rootB, layer, sun, pose, "exr"))
          : undefined;
        const cellRows = compareCells({
          layer,
          cell,
          unreal: a,
          threenative: b,
          masks: cellMasks,
          regions: evaluation,
          unrealExr: exrA,
          otherExr: exrB,
          reference: cached?.cells[key],
          thresholds,
        });
        if (layer === "L0" && masksB)
          for (const row of cellRows) {
            if (regions.includes(row.region))
              row.iou = iou(
                required(base.regions[row.region]),
                required(masksB.regions[row.region]),
              );
            row.pass = passes(row, thresholds);
          }
        rows.push(...cellRows);
        const wholeA = a ? measure(a, whole, exrA) : cached?.cells[key]?.WholeFrame;
        if (!wholeA) fail("MISSING_CELL", `${key}/WholeFrame reference stats`);
        const wholeB = measure(b, whole, exrB);
        reference.cells[key] = Object.fromEntries([
          ...cellRows.map((row) => [row.region, required(row.unreal)]),
          ["WholeFrame", wholeA],
        ]);
        if (options.metric === "exposure")
          exposure.push({
            layer,
            cell,
            unrealP50: wholeA.p50,
            threenativeP50: wholeB.p50,
            dEv: Math.log2(Math.max(wholeB.p50, 2 ** -20) / Math.max(wholeA.p50, 2 ** -20)),
          });
        if (options.metric === "curve" && a) {
          const pixels = a.width * a.height;
          const frames = {
            unreal: linearLuminance(a.data, pixels),
            other: linearLuminance(b.data, pixels),
          };
          const before = curveBase.get(cell);
          if (layer === "L8") curveBase.set(cell, frames);
          else if (layer === "L9" && before) {
            const u = exposureCurve(before.unreal, frames.unreal);
            const t = exposureCurve(before.other, frames.other);
            curve.push({
              cell,
              unreal: u,
              threenative: t,
              worst: Math.max(...u.map((value, i) => Math.abs((t[i] ?? 0) - value))),
              // The scenes differ before local exposure (lighting, global exposure), so the offset
              // between the two curves is a level and the remainder is the curve's shape.
              ...curveShape(u, t),
            });
          }
        }
        if (options.metric === "penumbra" && layer === "L5" && a) {
          // Shadow-edge width on the floor (PRD-634): rows where both arms hold an edge.
          const floor = required(base.regions.Floor);
          const edges = (image: IImage) =>
            floorEdges(
              linearLuminance(image.data, image.width * image.height),
              image.width,
              image.height,
              floor,
            );
          const m = matchedWidths(edges(a), edges(b));
          if (m.matched > 0)
            penumbra.push({
              cell,
              matched: m.matched,
              unrealPx: m.unreal,
              threenativePx: m.other,
              ratio: m.other / m.unreal,
            });
        }
        if (options.unrealVsUnreal)
          noise.push({
            layer,
            cell,
            dP50: Math.abs(wholeB.p50 - wholeA.p50) / Math.max(wholeA.p50, 1),
          });
        if (options.sheet)
          sheetPair(
            required(sheets.get(layer)),
            required(a),
            b,
            sunIndex * poses.length + poseIndex,
          );
      }
    }
  }
  if (options.writeStats) writeJson(path.join(dir, "reference-stats.json"), reference);
  for (const [layer, sheet] of sheets)
    writePng(path.join(dir, "captures/sheets", `${layer}.png`), sheet);
  const summary = layers.map((layer) => {
    const selected = rows.filter((r) => r.layer === layer);
    const maximum = (key: "deltaE" | "dP50") => {
      const values = selected.flatMap((r) => (r[key] === null ? [] : [required(r[key])]));
      return values.length ? Math.max(...values) : null;
    };
    const overlaps = selected.flatMap((r) => (r.iou === null ? [] : [r.iou]));
    return {
      layer,
      worstDeltaE: maximum("deltaE"),
      worstDP50: maximum("dP50"),
      worstIoU: overlaps.length ? Math.min(...overlaps) : null,
      passCount: selected.filter((r) => r.pass === true).length,
      evaluatedCount: selected.filter((r) => r.pass !== null).length,
      failCount: selected.filter((r) => r.pass === false).length,
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    unreal: rootA,
    comparison: rootB,
    mode: options.unrealVsUnreal ? "unreal-vs-unreal" : "threenative",
    metric: options.metric ?? null,
    thresholds: thresholds ?? null,
    rows,
    summary,
    exposure,
    noise,
    penumbra,
    curve,
    maxNoise: noise.length
      ? Math.max(
          ...noise.map((r) => r.dP50),
          ...rows.flatMap((r) => (r.dP50 === null ? [] : [r.dP50])),
        )
      : null,
  };
  writeJson(path.join(dir, "captures/compare-report.json"), report);
  return report;
}
export function parseArgs(args: string[]): IOptions {
  const options: IOptions = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--write-masks") options.writeMasks = true;
    else if (flag === "--write-stats") options.writeStats = true;
    else if (flag === "--sheet") options.sheet = true;
    else {
      if (
        ![
          "--unreal",
          "--threenative",
          "--layer",
          "--sun",
          "--metric",
          "--unreal-vs-unreal",
        ].includes(required(flag))
      )
        fail("BAD_INPUT", `unknown flag ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) fail("BAD_INPUT", `missing value for ${flag}`);
      switch (flag) {
        case "--unreal":
          options.unreal = value;
          break;
        case "--threenative":
          options.threenative = value;
          break;
        case "--unreal-vs-unreal":
          options.unrealVsUnreal = value;
          break;
        case "--metric":
          options.metric = value;
          break;
        case "--layer":
          options.layers = [...(options.layers ?? []), ...value.split(",")];
          break;
        case "--sun":
          options.suns = [...(options.suns ?? []), ...value.split(",")];
          break;
      }
    }
  }
  return options;
}
export function main(args = process.argv.slice(2)): void {
  if (args.includes("--scene")) {
    process.exitCode = compareGi(args);
    return;
  }
  const report = runComparison(parseArgs(args));
  const show = (v: number | null) => (v === null ? "—" : Number(v.toPrecision(4)).toString());
  const verdict = (v: boolean | null) => (v === null ? "—" : v ? "PASS" : "FAIL");
  const triplet = (stats: IStats | null, ev = false) =>
    stats === null
      ? "—"
      : (ev ? [stats.ev1, stats.ev50, stats.ev99] : [stats.p1, stats.p50, stats.p99])
          .map(show)
          .join(" / ");
  const color = (stats: IStats | null) => (stats === null ? "—" : stats.lab.map(show).join(" / "));
  if (!report.thresholds) console.log("no thresholds yet");
  for (const summary of report.summary) {
    console.log(
      `\n### ${summary.layer}\n\n| layer | cell | region | UE p1/50/99 | TN p1/50/99 | UE EV1/50/99 | TN EV1/50/99 | UE Lab | TN Lab | deltaE | dP50 | dEv50 | IoU | pass |\n|---|---|---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---|`,
    );
    for (const row of report.rows.filter((r) => r.layer === summary.layer))
      console.log(
        `| ${row.layer} | ${row.cell} | ${row.region} | ${triplet(row.unreal)} | ${triplet(row.threenative)} | ${triplet(row.unreal, true)} | ${triplet(row.threenative, true)} | ${color(row.unreal)} | ${color(row.threenative)} | ${show(row.deltaE)} | ${show(row.dP50)} | ${show(row.dEv50)} | ${show(row.iou)} | ${verdict(row.pass)} |`,
      );
  }
  console.log(
    "\n| layer | worst deltaE | worst dP50 | worst IoU | passes/evaluated | failures |\n|---|---:|---:|---:|---:|---:|",
  );
  for (const s of report.summary)
    console.log(
      `| ${s.layer} | ${show(s.worstDeltaE)} | ${show(s.worstDP50)} | ${show(s.worstIoU)} | ${s.passCount}/${s.evaluatedCount} | ${s.failCount} |`,
    );
  if (report.exposure.length) {
    console.log(
      "\n| layer | cell | UE whole p50 | TN whole p50 | exposure EV difference |\n|---|---|---:|---:|---:|",
    );
    for (const r of report.exposure)
      console.log(
        `| ${r.layer} | ${r.cell} | ${r.unrealP50} | ${r.threenativeP50} | ${show(r.dEv)} |`,
      );
  }
  if (report.curve.length) {
    console.log(
      "\n| cell | UE log2(L9/L8) by L8 brightness, dark to bright | TN | worst difference (stops) | level offset | worst shape difference |\n|---|---|---|---:|---:|---:|",
    );
    const list = (values: number[]) => values.map((v) => show(v)).join(" ");
    for (const r of report.curve)
      console.log(
        `| ${r.cell} | ${list(r.unreal)} | ${list(r.threenative)} | ${show(r.worst)} | ${show(r.level)} | ${show(r.shape)} |`,
      );
  }
  if (report.penumbra.length) {
    console.log(
      "\n| L5 cell | matched edge rows | UE width px | TN width px | TN / UE |\n|---|---:|---:|---:|---:|",
    );
    for (const r of report.penumbra)
      console.log(
        `| ${r.cell} | ${r.matched} | ${show(r.unrealPx)} | ${show(r.threenativePx)} | ${show(r.ratio)} |`,
      );
  }
  if (report.noise.length) {
    console.log("\n| layer | cell | whole-frame relative p50 difference |\n|---|---|---:|");
    for (const r of report.noise) console.log(`| ${r.layer} | ${r.cell} | ${show(r.dP50)} |`);
    console.log(`Maximum relative p50 difference: ${show(report.maxNoise)}`);
  }
  if (report.rows.some((r) => r.pass === false)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
