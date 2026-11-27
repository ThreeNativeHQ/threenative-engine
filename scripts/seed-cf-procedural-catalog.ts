/**
 * PRD-120 (Studio). Seeds ThreeNative's public asset catalog on Cloudflare with the engine's procedural
 * assets: the baked Procedural Animals wolf, the adventure kit's forest-floor props, and the full
 * `@threenative/procedural-environment` Asset Library (242 bakeable + 208 runtime kit models).
 *
 *   pnpm tsx scripts/seed-cf-procedural-catalog.ts --dry-run          # bake and validate, upload nothing
 *   OPS_TOKEN=… pnpm tsx scripts/seed-cf-procedural-catalog.ts        # upsert missing/changed into production
 *   OPS_TOKEN=… pnpm tsx scripts/seed-cf-procedural-catalog.ts --only tree,city,stylized
 *   OPS_TOKEN=… pnpm tsx scripts/seed-cf-procedural-catalog.ts --force --target http://127.0.0.1:8787
 *
 * The operator route upserts by slug, so a rerun with the same bytes changes nothing. By default the
 * seeder checks `public-catalog.json` first and skips unchanged slugs unless `--force` is passed.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnimalData, clearBuildCache } from "procedural-animals";
import wolf from "procedural-animals/species/wolf";
import {
  type ISeedEntry,
  assertValidSelfContainedGlb,
  assetLibraryCatalog,
  iterateAssetLibrarySeeds,
} from "./seed-cf-asset-library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOOR = path.resolve(here, "../packages/create-threenative/template-assets/assets");
export const OPS_PATH = "/ops/asset-cache/public";
const PUBLIC_CATALOG_PATH = "/api/assets/public/catalog.json";
const DEFAULT_OPS_TARGET = "https://studio.threenative.com";
const DEFAULT_PUBLIC_ORIGIN = "https://gateway.threenative.com";
const LICENSE = "CC0-1.0";
const AUTHOR = "ThreeNative";

export type ISeed = ISeedEntry;

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
      license: seed.license ?? LICENSE,
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

interface IPublicCatalogSnapshotItem {
  readonly slug: string;
  readonly prompt: string;
  readonly tags: string;
  readonly license: string;
  readonly contentHash: string;
}

async function fetchExistingCatalog(
  publicOrigin: string,
): Promise<Map<string, IPublicCatalogSnapshotItem>> {
  try {
    const response = await fetch(new URL(PUBLIC_CATALOG_PATH, publicOrigin));
    if (!response.ok) return new Map();
    const json = (await response.json()) as { items?: IPublicCatalogSnapshotItem[] };
    return new Map((json.items ?? []).map((item) => [item.slug, item]));
  } catch {
    return new Map();
  }
}

function isUnchanged(
  seed: ISeed,
  sha256: string,
  existing: IPublicCatalogSnapshotItem | undefined,
): boolean {
  if (!existing) return false;
  return (
    existing.contentHash === sha256 &&
    existing.prompt === seed.prompt &&
    existing.tags === seed.tags &&
    existing.license === (seed.license ?? LICENSE)
  );
}

function parseOnlyFlag(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function assertUniqueAllSlugs(only: readonly string[] | undefined): Promise<void> {
  const seen = new Set<string>();
  const coreSlugs = [
    ...(only && !only.includes("wolf") ? [] : ["wolf-grey", "wolf-grey-high"]),
    ...(only && !only.includes("floor") ? [] : FLOOR_PROPS.map(([slug]) => slug)),
  ];
  for (const slug of coreSlugs) seen.add(slug);
  const lib = await assetLibraryCatalog();
  for (const item of lib) {
    if (only && !only.includes(item.kind)) continue;
    if (seen.has(item.slug)) throw new Error(`Slug collision detected: "${item.slug}"`);
    seen.add(item.slug);
  }
}

async function* iterateCoreSeeds(only: readonly string[] | undefined): AsyncGenerator<ISeed> {
  const wantWolf = !only || only.includes("wolf");
  const wantFloor = !only || only.includes("floor");
  if (!wantWolf && !wantFloor) return;
  const base = await seeds();
  for (const seed of base) {
    const isWolf = seed.slug.startsWith("wolf-");
    if ((isWolf && wantWolf) || (!isWolf && wantFloor)) yield seed;
  }
}

async function* iterateAllSelectedSeeds(
  only: readonly string[] | undefined,
): AsyncGenerator<ISeed> {
  for await (const seed of iterateCoreSeeds(only)) yield seed;
  for await (const { seed } of iterateAssetLibrarySeeds({ only })) yield seed;
}

interface IRunContext {
  readonly count: number;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly out: string | undefined;
  readonly target: string;
  readonly token: string;
  readonly existing: ReadonlyMap<string, IPublicCatalogSnapshotItem>;
}

async function processSeed(
  seed: ISeed,
  ctx: IRunContext,
): Promise<"uploaded" | "skipped" | "dry-run"> {
  if (!validGlb(seed.bytes)) throw new Error(`${seed.slug} is not a valid GLB`);
  assertValidSelfContainedGlb(seed.slug, seed.bytes);
  const sha256 = createHash("sha256").update(seed.bytes).digest("hex");
  if (ctx.out !== undefined) await writeFile(path.join(ctx.out, `${seed.slug}.glb`), seed.bytes);
  const kb = (seed.bytes.byteLength / 1024).toFixed(1).padStart(7);
  if (ctx.dryRun) {
    console.info(`[${ctx.count}] ${seed.slug.padEnd(32)} ${kb} KB  ${sha256.slice(0, 12)}`);
    return "dry-run";
  }
  if (!ctx.force && isUnchanged(seed, sha256, ctx.existing.get(seed.slug))) {
    console.info(`[${ctx.count}] skipped   ${seed.slug.padEnd(32)} ${kb} KB`);
    return "skipped";
  }
  const { id, updated } = await upload(seed, ctx.target, ctx.token);
  console.info(
    `[${ctx.count}] ${updated ? "updated" : "created"}   ${seed.slug.padEnd(32)} ${kb} KB → ${id}`,
  );
  return "uploaded";
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const flag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const rawTarget = flag("--target") ?? DEFAULT_OPS_TARGET;
  const target = rawTarget.includes("://") ? rawTarget : `https://${rawTarget}`;
  const publicOrigin = rawTarget === DEFAULT_OPS_TARGET ? DEFAULT_PUBLIC_ORIGIN : target;
  const out = flag("--out");
  const only = parseOnlyFlag(flag("--only"));

  await assertUniqueAllSlugs(only);

  const token = process.env.OPS_TOKEN ?? "";
  if (!dryRun && !token) throw new Error("OPS_TOKEN is required to upload (or pass --dry-run)");
  const existing = dryRun || force ? new Map() : await fetchExistingCatalog(publicOrigin);

  let count = 0;
  let totalBytes = 0;
  let uploadedCount = 0;
  let skippedCount = 0;

  for await (const seed of iterateAllSelectedSeeds(only)) {
    count += 1;
    totalBytes += seed.bytes.byteLength;
    const outcome = await processSeed(seed, { count, dryRun, existing, force, out, target, token });
    if (outcome === "uploaded") uploadedCount += 1;
    else if (outcome === "skipped") skippedCount += 1;
  }

  const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
  if (dryRun) {
    console.info(`\n--dry-run: ${count} valid GLBs (${totalMb} MB total), nothing uploaded`);
    return;
  }
  console.info(
    `\nSeed complete: ${count} processed (${uploadedCount} uploaded, ${skippedCount} unchanged, ${totalMb} MB total)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
