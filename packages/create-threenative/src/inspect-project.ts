import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

/** What an agent re-derived with 39 PIL scripts and 20 manifest scripts: one call, one answer. */

const ASSET_EXTENSIONS = new Set([
  ".glb",
  ".gltf",
  ".fbx",
  ".obj",
  ".dae",
  ".blend",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ktx2",
  ".hdr",
  ".exr",
  ".ogg",
  ".wav",
  ".mp3",
]);

export interface IManifestAudit {
  /** Identical bytes under two paths: delete one. */
  readonly duplicates: readonly (readonly string[])[];
  /** Manifest entries whose source file is gone. */
  readonly missingFiles: readonly string[];
  readonly pass: boolean;
  /** `.zip` archives left behind by a download. */
  readonly leftoverArchives: readonly string[];
  /** Asset files under `assets/` with no manifest entry (an `assets.exclude` match shows up here too). */
  readonly unlisted: readonly string[];
  readonly manifestFound: boolean;
}

async function walk(directory: string, root: string, files: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, root, files);
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

export async function auditAssetManifest(project: string): Promise<IManifestAudit> {
  const root = path.resolve(project, "assets");
  const files: string[] = [];
  await walk(root, root, files);
  let entries: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(
      await readFile(path.resolve(project, "public", "assets.manifest.json"), "utf8"),
    ) as {
      entries?: Record<string, unknown>;
    };
    entries = parsed.entries ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `TN_INSPECT_MANIFEST_INVALID: public/assets.manifest.json: ${(error as Error).message}`,
      );
    }
  }
  const listed = new Set(Object.keys(entries ?? {}));
  const assets = files.filter((file) => ASSET_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const byHash = new Map<string, string[]>();
  for (const file of assets) {
    const hash = createHash("sha256")
      .update(await readFile(path.join(root, file)))
      .digest("hex");
    byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
  }
  const audit = {
    duplicates: [...byHash.values()].filter((group) => group.length > 1),
    leftoverArchives: files.filter((file) => file.toLowerCase().endsWith(".zip")),
    manifestFound: entries !== undefined,
    missingFiles: [...listed].filter((key) => !files.includes(key)),
    unlisted: assets.filter((file) => !listed.has(file)),
  };
  const pass =
    audit.manifestFound &&
    audit.duplicates.length +
      audit.leftoverArchives.length +
      audit.missingFiles.length +
      audit.unlisted.length ===
      0;
  return { ...audit, pass };
}

export function formatManifestAudit(audit: IManifestAudit): string {
  const group = (title: string, values: readonly string[]): string[] =>
    values.length === 0 ? [] : [`  ${title}`, ...values.map((value) => `    ${value}`)];
  return `${[
    audit.pass ? "assets match the manifest" : "assets and manifest disagree",
    ...(audit.manifestFound ? [] : ["  public/assets.manifest.json is missing (run the build)"]),
    ...group("unlisted (no manifest entry)", audit.unlisted),
    ...group("manifest entries without a file", audit.missingFiles),
    ...group("leftover archives", audit.leftoverArchives),
    ...group(
      "duplicates (identical bytes)",
      audit.duplicates.map((names) => names.join(" = ")),
    ),
  ].join("\n")}\n`;
}

export interface IFrameInspection {
  readonly file: string;
  readonly width: number;
  readonly height: number;
  /** Mean Rec. 709 luma, 0 (black) to 255 (white). */
  readonly meanLuma: number;
  /** Every pixel is within 2 levels of one colour: nothing was drawn. */
  readonly blank: boolean;
  /** Mean luma under 8: drawn, but in the dark. */
  readonly dark: boolean;
  readonly pass: boolean;
  readonly samples: readonly {
    readonly hex: string;
    readonly role: string;
    readonly u: number;
    readonly v: number;
  }[];
}

interface IRaster {
  readonly height: number;
  readonly width: number;
  /** RGB at (x, y). */
  readonly rgb: (x: number, y: number) => readonly [number, number, number];
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

const unsupported = (file: string, why: string): Error =>
  new Error(`TN_INSPECT_FRAME_UNSUPPORTED: ${file}: ${why}`);

/** Concatenated IDAT payload of a PNG. */
function pngPixelData(data: Buffer): Buffer {
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= data.length; ) {
    const length = data.readUInt32BE(at);
    if (data.toString("latin1", at + 4, at + 8) === "IDAT")
      idat.push(data.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return inflateSync(Buffer.concat(idat));
}

/** The byte a PNG filter adds to: none, sub, up, average or Paeth. */
function filterPrior(filter: number, left: number, up: number, upLeft: number): number | undefined {
  const guess = left + up - upLeft;
  const [a, b, c] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - upLeft)];
  return [0, left, up, (left + up) >> 1, a <= b && a <= c ? left : b <= c ? up : upLeft][filter];
}

/** Undo the PNG scanline filters. */
function unfilter(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
  file: string,
): Buffer {
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  const at = (y: number, i: number): number =>
    y < 0 || i < 0 ? 0 : (pixels[y * stride + i] as number);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i += 1) {
      const prior = filterPrior(filter, at(y, i - channels), at(y - 1, i), at(y - 1, i - channels));
      if (prior === undefined) throw unsupported(file, `bad PNG filter ${filter}.`);
      pixels[y * stride + i] = ((raw[y * (stride + 1) + 1 + i] as number) + prior) & 255;
    }
  }
  return pixels;
}

/** Non-interlaced 8-bit grey, RGB, grey-alpha and RGBA: what a browser screenshot is. Anything else fails closed. */
function decodePng(data: Buffer, file: string): IRaster {
  if (data.length < 33 || data.readUInt32BE(0) !== 0x89504e47)
    throw unsupported(file, "not a PNG.");
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const channels = CHANNELS[data[25] as number];
  if (data[24] !== 8 || channels === undefined || data[28] !== 0) {
    throw unsupported(file, "only non-interlaced 8-bit PNG is read.");
  }
  const pixels = unfilter(pngPixelData(data), width, height, channels, file);
  return {
    height,
    rgb: (x, y) => {
      const at = (y * width + x) * channels;
      const r = pixels[at] as number;
      return channels < 3 ? [r, r, r] : [r, pixels[at + 1] as number, pixels[at + 2] as number];
    },
    width,
  };
}

function parseSample(text: string): { role: string; u: number; v: number } {
  const match = /^([^:]+):(\d*\.?\d+),(\d*\.?\d+)$/u.exec(text);
  const [u, v] = [Number(match?.[2]), Number(match?.[3])];
  if (match === null || u > 1 || v > 1) {
    throw new Error(
      `--sample '${text}' must be role:u,v with u and v from 0 to 1 (example: hero:0.5,0.6).`,
    );
  }
  return { role: match[1] as string, u, v };
}

export async function inspectFrame(
  file: string,
  sampleArgs: readonly string[],
): Promise<IFrameInspection> {
  const samples = sampleArgs.map(parseSample);
  const raster = decodePng(await readFile(file), file);
  let lumaSum = 0;
  let count = 0;
  const first = raster.rgb(0, 0);
  let blank = true;
  // A 1-in-4 grid in each axis reads every region of a 4K frame and costs a sixteenth of the pixels.
  for (let y = 0; y < raster.height; y += 4) {
    for (let x = 0; x < raster.width; x += 4) {
      const [r, g, b] = raster.rgb(x, y);
      lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
      if (Math.abs(r - first[0]) > 2 || Math.abs(g - first[1]) > 2 || Math.abs(b - first[2]) > 2)
        blank = false;
    }
  }
  const meanLuma = Math.round((lumaSum / Math.max(count, 1)) * 10) / 10;
  const dark = meanLuma < 8;
  return {
    blank,
    dark,
    file: path.basename(file),
    height: raster.height,
    meanLuma,
    pass: !blank && !dark,
    samples: samples.map(({ role, u, v }) => {
      const [r, g, b] = raster.rgb(
        Math.min(raster.width - 1, Math.floor(u * raster.width)),
        Math.min(raster.height - 1, Math.floor(v * raster.height)),
      );
      return {
        hex: `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`,
        role,
        u,
        v,
      };
    }),
    width: raster.width,
  };
}

export function formatFrameInspection(result: IFrameInspection): string {
  return `${[
    `${result.file}  ${result.width}x${result.height}`,
    `  luma       mean ${result.meanLuma} of 255${result.blank ? "   BLANK (one flat colour)" : result.dark ? "   DARK" : ""}`,
    ...result.samples.map(({ hex, role, u, v }) => `  ${role.padEnd(10)} ${hex}  at ${u},${v}`),
  ].join("\n")}\n`;
}
