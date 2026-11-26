/**
 * PRD-120 (Studio). Seeds ThreeNative's public asset catalog on Cloudflare with the engine's procedural
 * assets that live outside `@threenative/procedural-environment`: the pinned Procedural Animals wolf, baked
 * here into a standard skinned GLB, and the adventure kit's baked forest-floor props.
 *
 *   pnpm tsx scripts/seed-cf-procedural-catalog.ts --dry-run          # bake and validate, upload nothing
 *   OPS_TOKEN=… pnpm tsx scripts/seed-cf-procedural-catalog.ts        # upsert into production
 *   OPS_TOKEN=… pnpm tsx scripts/seed-cf-procedural-catalog.ts --target http://127.0.0.1:8787
 *
 * The operator route upserts by slug, so a rerun with the same bytes changes nothing. The wolf comes from
 * the MIT donor `procedural-animals` at its pinned revision (`pnpm-workspace.yaml` catalog), so the seeder
 * does not need the retired `@threenative/procedural-animals` package. The GLB keeps the rest-pose skeleton
 * and linear skin weights; the donor's dual-quaternion skin and procedural motion are runtime code and are
 * not part of the file.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnimalData, clearBuildCache } from "procedural-animals";
import wolf from "procedural-animals/species/wolf";

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOOR = path.resolve(here, "../packages/create-threenative/template-assets/assets");
export const OPS_PATH = "/ops/asset-cache/public";
const LICENSE = "CC0-1.0";
const AUTHOR = "ThreeNative";

export interface ISeed {
  readonly slug: string;
  readonly prompt: string;
  readonly tags: string;
  readonly bytes: Uint8Array;
}

interface IBone {
  readonly name: string;
  readonly parent: string | null;
  readonly headJ: string;
}
export interface IWolfData {
  readonly nV: number;
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly index: Uint32Array;
  readonly skinIndex: Uint16Array;
  readonly skinWeight: Float32Array;
  readonly tint: Float32Array;
  readonly pat: Float32Array;
  readonly bones: readonly IBone[];
  readonly joints: Readonly<Record<string, readonly [number, number, number]>>;
}

/** The example material's colour, `mix(tint.rgb, pat.rgb, pat.a * 0.25)`, as a clamped vertex colour. */
function vertexColors(data: IWolfData): Float32Array {
  const out = new Float32Array(data.nV * 4);
  for (let v = 0; v < data.nV; v += 1) {
    const amount = (data.pat[v * 4 + 3] ?? 0) * 0.25;
    for (let c = 0; c < 3; c += 1) {
      const tint = data.tint[v * 4 + c] ?? 0;
      const mixed = tint + ((data.pat[v * 4 + c] ?? 0) - tint) * amount;
      out[v * 4 + c] = Math.min(1, Math.max(0, mixed));
    }
    out[v * 4 + 3] = 1;
  }
  return out;
}

function bounds(values: Float32Array): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < values.length; i += 1) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis] ?? Number.POSITIVE_INFINITY, values[i] ?? 0);
    max[axis] = Math.max(max[axis] ?? Number.NEGATIVE_INFINITY, values[i] ?? 0);
  }
  return { max, min };
}

/** One skinned mesh as a GLB: rest-pose joints (translation only), inverse binds, vertex colours. */
export function wolfGlb(data: IWolfData): Uint8Array {
  const views: Uint8Array[] = [];
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const add = (
    array: ArrayBufferView,
    accessor: Record<string, unknown>,
    target?: number,
  ): number => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({
      buffer: 0,
      byteLength: bytes.byteLength,
      byteOffset: offset,
      ...(target === undefined ? {} : { target }),
    });
    views.push(bytes);
    offset += Math.ceil(bytes.byteLength / 4) * 4;
    accessors.push({ ...accessor, bufferView: bufferViews.length - 1 });
    return accessors.length - 1;
  };
  const head = (bone: IBone) => {
    const point = data.joints[bone.headJ];
    if (point === undefined) throw new Error(`wolf bone ${bone.name} has no joint ${bone.headJ}`);
    return point;
  };
  const byName = new Map(data.bones.map((bone, index) => [bone.name, index]));
  const inverse = new Float32Array(data.bones.length * 16);
  data.bones.forEach((bone, index) => {
    const [x, y, z] = head(bone);
    inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], index * 16);
  });
  const ARRAY = 34962;
  const ELEMENTS = 34963;
  const attributes = {
    COLOR_0: add(vertexColors(data), { componentType: 5126, count: data.nV, type: "VEC4" }, ARRAY),
    JOINTS_0: add(data.skinIndex, { componentType: 5123, count: data.nV, type: "VEC4" }, ARRAY),
    NORMAL: add(data.nrm, { componentType: 5126, count: data.nV, type: "VEC3" }, ARRAY),
    POSITION: add(
      data.pos,
      { componentType: 5126, count: data.nV, type: "VEC3", ...bounds(data.pos) },
      ARRAY,
    ),
    WEIGHTS_0: add(data.skinWeight, { componentType: 5126, count: data.nV, type: "VEC4" }, ARRAY),
  };
  const indices = add(
    data.index,
    { componentType: 5125, count: data.index.length, type: "SCALAR" },
    ELEMENTS,
  );
  const inverseBindMatrices = add(inverse, {
    componentType: 5126,
    count: data.bones.length,
    type: "MAT4",
  });
  // Node 0 is the mesh; nodes 1… are the joints in bone order.
  const jointNodes = data.bones.map((bone) => {
    const [x, y, z] = head(bone);
    const parent = bone.parent === null ? undefined : data.bones[byName.get(bone.parent) ?? -1];
    const [px, py, pz] = parent === undefined ? [0, 0, 0] : head(parent);
    const children = data.bones
      .map((other, index) => (other.parent === bone.name ? index + 1 : -1))
      .filter((index) => index > 0);
    return {
      name: bone.name,
      translation: [x - px, y - py, z - pz],
      ...(children.length > 0 ? { children } : {}),
    };
  });
  const roots = data.bones
    .map((bone, index) => (bone.parent === null ? index + 1 : -1))
    .filter((index) => index > 0);
  const json = {
    accessors,
    asset: { generator: "threenative seed-cf-procedural-catalog", version: "2.0" },
    bufferViews,
    buffers: [{ byteLength: offset }],
    materials: [
      {
        name: "wolf-coat",
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.82,
        },
      },
    ],
    meshes: [{ name: "wolf", primitives: [{ attributes, indices, material: 0 }] }],
    nodes: [{ mesh: 0, name: "wolf", skin: 0 }, ...jointNodes],
    scene: 0,
    scenes: [{ nodes: [0, ...roots] }],
    skins: [
      {
        inverseBindMatrices,
        joints: data.bones.map((_bone, index) => index + 1),
        ...(roots[0] === undefined ? {} : { skeleton: roots[0] }),
      },
    ],
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const glb = new Uint8Array(12 + 8 + jsonLength + 8 + offset);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(text, 20);
  view.setUint32(20 + jsonLength, offset, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  let cursor = 28 + jsonLength;
  for (const bytes of views) {
    glb.set(bytes, cursor);
    cursor += Math.ceil(bytes.byteLength / 4) * 4;
  }
  return glb;
}

/** The GLB header checks the catalog's consumers run: magic, version 2, and the declared length. */
export function validGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(0, true) === 0x46546c67 &&
    view.getUint32(4, true) === 2 &&
    view.getUint32(8, true) === bytes.byteLength &&
    view.getUint32(16, true) === 0x4e4f534a
  );
}

export async function bakeWolfData(tier: "high" | "crowd" = "high"): Promise<IWolfData> {
  clearBuildCache();
  return (await buildAnimalData(wolf, { quality: tier, seed: 7, worker: false })) as IWolfData;
}

const FLOOR_PROPS = [
  ["floor-fern-0", "a sword fern clump for a forest floor", "fern plant forest floor foliage"],
  ["floor-litter-0", "a patch of fallen leaf litter", "leaves litter forest floor ground cover"],
  ["floor-log-0", "a fallen mossy log", "log wood tree forest floor"],
  ["floor-log-1", "a fallen log, low detail", "log wood tree forest floor lod"],
  ["floor-stump-0", "a cut tree stump", "stump wood tree forest floor"],
  ["floor-twig-0", "a small fallen twig", "twig stick branch forest floor"],
] as const;

export async function seeds(): Promise<ISeed[]> {
  const floor = await Promise.all(
    FLOOR_PROPS.map(async ([slug, prompt, tags]) => ({
      bytes: new Uint8Array(await readFile(path.join(FLOOR, `${slug}.glb`))),
      prompt,
      slug,
      tags,
    })),
  );
  // The crowd tier is the game-ready default; the high tier is for a hero close-up.
  return [
    {
      bytes: wolfGlb(await bakeWolfData("crowd")),
      prompt: "a low poly grey wolf, rigged (37 bones, rest pose)",
      slug: "wolf-grey",
      tags: "animal wolf quadruped canine creature rigged skinned",
    },
    {
      bytes: wolfGlb(await bakeWolfData("high")),
      prompt: "a detailed grey wolf, rigged (37 bones, rest pose), hero detail",
      slug: "wolf-grey-high",
      tags: "animal wolf quadruped canine creature rigged skinned high detail",
    },
    ...floor,
  ];
}

export async function upload(
  seed: ISeed,
  target: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; updated: boolean }> {
  const reply = await fetcher(new URL(OPS_PATH, target), {
    body: JSON.stringify({
      author: AUTHOR,
      glbBase64: Buffer.from(seed.bytes).toString("base64"),
      license: LICENSE,
      origin: "procedural",
      prompt: seed.prompt,
      slug: seed.slug,
      tags: seed.tags,
      type: "model",
    }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  if (!reply.ok) throw new Error(`${seed.slug}: ${reply.status} ${await reply.text()}`);
  return (await reply.json()) as { id: string; updated: boolean };
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const flag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const target = flag("--target") ?? "https://studio.threenative.com";
  const out = flag("--out");
  const all = await seeds();
  for (const seed of all) {
    if (!validGlb(seed.bytes)) throw new Error(`${seed.slug} is not a valid GLB`);
    const sha = createHash("sha256").update(seed.bytes).digest("hex").slice(0, 12);
    console.info(`${seed.slug.padEnd(16)} ${String(seed.bytes.byteLength).padStart(9)} B  ${sha}`);
    if (out !== undefined) await writeFile(path.join(out, `${seed.slug}.glb`), seed.bytes);
  }
  if (dryRun) {
    console.info(`\n--dry-run: ${all.length} valid GLBs, nothing uploaded`);
    return;
  }
  const token = process.env.OPS_TOKEN;
  if (!token) throw new Error("OPS_TOKEN is required to upload (or pass --dry-run)");
  for (const seed of all) {
    // One upsert at a time: each one rebuilds the catalog.
    const { id, updated } = await upload(
      seed,
      target.includes("://") ? target : `https://${target}`,
      token,
    );
    console.info(`${updated ? "updated" : "created"} ${seed.slug} → ${id}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
