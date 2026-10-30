import type { IAssetLoader } from "@threenative/core";
import type { IPlacement } from "@threenative/terrain";
import type { IPropScatter } from "./scatter.js";

interface IHeader {
  version: 1;
  counts: Record<string, number>;
  canopy: number;
  /** First eight-float record per asset; order indices follow the record array. */
  offsets: Record<string, number>;
}

/** Eight LE floats: position, yaw, scale, normal; an order index preserves identity across asset runs. */
export function encodePlacements(scatter: IPropScatter, canopy: Float32Array): ArrayBuffer {
  const offsets: Record<string, number> = {};
  let planned = 0;
  for (const [asset, count] of Object.entries(scatter.counts)) {
    offsets[asset] = planned;
    planned += count;
  }
  if (planned !== scatter.placements.length) throw new Error("Invalid baked placement counts");
  const header: IHeader = { version: 1, counts: scatter.counts, offsets, canopy: canopy.length };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = Math.ceil(json.length / 4) * 4;
  const total = scatter.placements.length;
  const canopyOffset = 4 + length + total * 36;
  const buffer = new ArrayBuffer(canopyOffset + canopy.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.fill(32, 4, 4 + length);
  bytes.set(json, 4);
  const view = new DataView(buffer);
  view.setUint32(0, length, true);
  const seen: Record<string, number> = {};
  for (const [i, p] of scatter.placements.entries()) {
    const index = seen[p.asset] ?? 0;
    const identity = `temperate-${p.asset}:${index}`;
    const outcrop = p.id === `${identity}:outcrop`;
    const first = offsets[p.asset];
    if (
      first === undefined ||
      (!outcrop && p.id !== identity) ||
      p.layer !== `temperate-${p.asset}`
    )
      throw new Error("Invalid baked placement identity");
    const record = (first as number) + index;
    view.setUint32(
      4 + length + total * 32 + record * 4,
      i | (p.alignToNormal ? 0x40000000 : 0) | (outcrop ? 0x80000000 : 0),
      true,
    );
    let offset = 4 + length + record * 32;
    seen[p.asset] = index + 1;
    for (const value of [...p.position, p.rotation, p.scale, ...p.normal]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
  }
  for (const [i, value] of canopy.entries()) view.setFloat32(canopyOffset + i * 4, value, true);
  decodePlacements(buffer);
  return buffer;
}

function invalid(): never {
  throw new Error("Invalid baked placement table");
}

function readHeader(view: DataView) {
  if (view.byteLength < 4) invalid();
  const length = view.getUint32(0, true);
  if (length === 0 || length % 4 !== 0 || length > view.byteLength - 4) invalid();
  const header = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(view.buffer, view.byteOffset + 4, length),
    ),
  ) as IHeader;
  if (
    !header ||
    header.version !== 1 ||
    !header.counts ||
    typeof header.counts !== "object" ||
    Array.isArray(header.counts) ||
    !Number.isSafeInteger(header.canopy) ||
    header.canopy < 0 ||
    !header.offsets ||
    typeof header.offsets !== "object" ||
    Array.isArray(header.offsets)
  )
    invalid();
  let total = 0;
  for (const [asset, count] of Object.entries(header.counts)) {
    if (!/^[a-z]+$/.test(asset) || !Number.isSafeInteger(count) || count < 0) invalid();
    if (header.offsets[asset] !== total) invalid();
    total += count;
  }
  const canopyOffset = 4 + length + total * 36;
  if (canopyOffset + header.canopy * 4 !== view.byteLength) invalid();
  return { header, length, total, canopyOffset };
}

export function decodePlacements(buffer: ArrayBuffer): IPropScatter & { canopy: Float32Array } {
  const view = new DataView(buffer);
  const { header, length, total, canopyOffset } = readHeader(view);
  const assets = Object.keys(header.counts);
  const visited = new Uint8Array(total);
  let offset = 4 + length;
  const next = (): number => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    if (!Number.isFinite(value)) invalid();
    return value;
  };
  const placements: IPlacement[] = new Array(total);
  let record = 0;
  for (const asset of assets)
    for (let index = 0; index < (header.counts[asset] ?? 0); index++) {
      const code = view.getUint32(4 + length + total * 32 + record++ * 4, true);
      const order = code & 0x3fffffff;
      if (order >= total || visited[order]) invalid();
      visited[order] = 1;
      const position: [number, number, number] = [next(), next(), next()];
      const rotation = next();
      const scale = next();
      const normal: [number, number, number] = [next(), next(), next()];
      if (scale <= 0) invalid();
      placements[order] = {
        asset,
        id: `temperate-${asset}:${index}${code & 0x80000000 ? ":outcrop" : ""}`,
        layer: `temperate-${asset}`,
        alignToNormal: !!(code & 0x40000000),
        position,
        rotation,
        scale,
        normal,
      };
    }
  offset = canopyOffset;
  const canopy = Float32Array.from({ length: header.canopy }, next);
  if (canopy.some((value) => value < 0 || value > 1)) invalid();
  return { placements, counts: header.counts, canopy };
}

export async function loadPlacements(
  assets: Pick<IAssetLoader, "resolve">,
  world: string,
): Promise<ReturnType<typeof decodePlacements>> {
  const response = await fetchBakedFile(assets, `world/${world}.placements.bin`, "placement table");
  return decodePlacements(await response.arrayBuffer());
}

/** One baked file under `world/`, from the first root the asset loader resolves that serves it. */
export async function fetchBakedFile(
  assets: Pick<IAssetLoader, "resolve">,
  path: string,
  what = "world file",
): Promise<Response> {
  for (const url of await assets.resolve(path)) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      continue;
    }
    if (response.ok) return response;
  }
  throw new Error(`Missing baked ${what}: ${path}`);
}
