import { bakeMesh, bakeTerrain } from "./bake.js";
import { encodeGLB, encodeHeightPNG, encodeRAW16, encodeSplatPNGs } from "./io.js";
import type {
  ExportKind,
  IExportArchive,
  IExportFile,
  ITerrainDocument,
  ITerrainState,
} from "./types.js";
const enc = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, initial) => {
  let n = initial;
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const v of b) c = (table[(c ^ v) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function concat(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** Deterministic ZIP (store method). No compression library or server required. */
/**
 * Deterministic store-method ZIP with safe unique relative filenames.
 * @requires npm i @threenative/terrain
 * @situation archive derived terrain files without another dependency
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const archive = encodeZIP([{ name: "height.raw", bytes: new Uint8Array(8) }]);
 */
export function encodeZIP(files: readonly IExportFile[]) {
  if (files.length > 65535) throw RangeError("Too many ZIP entries");
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const { name, bytes } of files) {
    if (
      !/^[a-zA-Z0-9_.\/-]+$/.test(name) ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      names.has(name)
    )
      throw Error("Unsafe or duplicate ZIP filename");
    if (!(bytes instanceof Uint8Array)) throw TypeError("ZIP bytes must be Uint8Array");
    names.add(name);
    const nb = enc.encode(name);
    const crc = crc32(bytes);
    const h = new Uint8Array(30 + nb.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(12, 0x21, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    v.setUint16(26, nb.length, true);
    h.set(nb, 30);
    parts.push(h, bytes);
    const c = new Uint8Array(46 + nb.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    c.set(nb, 46);
    central.push(c);
    offset += h.length + bytes.length;
    if (offset > 0xffffffff) throw RangeError("ZIP64 is not supported");
  }
  const directory = concat(central);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directory.length, true);
  e.setUint32(16, offset, true);
  return concat([...parts, directory, end]);
}
const json = (name: string, data: unknown): IExportFile => ({
  name,
  bytes: enc.encode(JSON.stringify(data, null, 2)),
});
/**
 * Recovered numerical/project exports; GLB/runtime outputs contain terrain only.
 * @requires npm i @threenative/terrain
 * @situation export a terrain recipe and its numerical runtime data
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const terrain = new Terrain({ resolution: 17 }); const file = await makeExport(terrain.evaluate(), terrain.toJSON(), "project");
 */
export async function makeExport(
  state: ITerrainState,
  recipe: ITerrainDocument,
  kind: ExportKind,
): Promise<IExportArchive> {
  const result = (name: string, type: string, bytes: Uint8Array): IExportArchive => ({
    name,
    type,
    bytes,
  });
  if (kind === "project")
    return result("terrain-recipe.json", "application/json", json("", recipe).bytes);
  if (kind === "png")
    return result("terrain-height16.png", "image/png", await encodeHeightPNG(state));
  if (kind === "glb") return result("terrain.glb", "model/gltf-binary", encodeGLB(bakeMesh(state)));
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const h of state.height) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  if (max === min) max = min + 1;
  const range = {
    resolution: state.resolution,
    size: state.size,
    min,
    max,
    littleEndian: true,
    units: "metres",
    rowOrder: "z increases from -size/2 to +size/2",
    columnOrder: "x increases from -size/2 to +size/2",
  };
  if (kind === "raw")
    return result(
      "terrain-raw16.zip",
      "application/zip",
      encodeZIP([
        { name: "height.raw", bytes: encodeRAW16(state.height, { min, max }) },
        json("heightfield.json", range),
      ]),
    );
  const splats = await encodeSplatPNGs(state);
  const splatFiles = splats.map((s, i) => ({ name: `splat-${i}.png`, bytes: s.bytes }));
  if (kind === "splat")
    return result(
      "terrain-splatmaps.zip",
      "application/zip",
      encodeZIP([
        ...splatFiles,
        json(
          "channels.json",
          splats.map((s, i) => ({ file: `splat-${i}.png`, rgba: s.channels })),
        ),
      ]),
    );
  if (kind !== "runtime") throw Error(`Unknown export '${kind}'`);
  const baked = bakeTerrain(state);
  const collision = new Uint8Array(state.height.length * 4);
  const dv = new DataView(collision.buffer);
  state.height.forEach((h, i) => dv.setFloat32(i * 4, h, true));
  const manifest = {
    version: 1,
    size: state.size,
    resolution: state.resolution,
    units: "metres",
    axis: "Y up",
    lods: baked.lods.map((l) => ({
      step: l.step,
      file: `lod-${l.step}.glb`,
      chunks: l.chunks.map((c) => ({ name: c.name, ...c.bounds, skirtDepth: c.skirtDepth })),
    })),
    collision: {
      format: "float32-le",
      file: "collision.f32le",
      resolution: state.resolution,
      cellSize: baked.collision.cellSize,
      origin: baked.collision.origin,
    },
    heightRange: range,
    splats: splats.map((s, i) => ({ file: `splat-${i}.png`, rgba: s.channels })),
    placements: "placements.json",
    water: "water.json",
    limitations: [
      "Static LODs; runtime selection and streaming not provided",
      "GLBs contain terrain only; supply assets for placement IDs",
      "No navigation mesh",
    ],
  };
  const water = state.waters.map((w, i) => {
    const { mask, ...rest } = w;
    return { ...rest, maskFile: `water-${i}.mask8` };
  });
  const files = [
    json("manifest.json", manifest),
    json("recipe.json", recipe),
    json("placements.json", baked.instances),
    json("water.json", { bodies: water, rivers: state.rivers }),
    { name: "collision.f32le", bytes: collision },
    { name: "height16.png", bytes: await encodeHeightPNG(state) },
    ...splatFiles,
    ...baked.lods.map((l) => ({ name: `lod-${l.step}.glb`, bytes: encodeGLB(l.chunks) })),
  ];
  for (let i = 0; i < water.length; i++)
    files.push({
      name: water[i]?.maskFile as string,
      bytes: new Uint8Array(state.waters[i]?.mask ?? []),
    });
  return result("terrain-runtime.zip", "application/zip", encodeZIP(files));
}
