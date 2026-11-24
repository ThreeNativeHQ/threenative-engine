// The Scene Bundler's two outputs (PRD-915), both ordinary project files and neither a scene format:
// a TypeScript module that loads each model with `ctx.assets.model` and instances repeats, or one
// merged static `.glb` with shared materials and textures deduplicated.
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { containedFile } from "./project-source.js";

export interface IBundleItem {
  readonly path: string;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface IBundleRequest {
  readonly name: string;
  readonly output: "ts" | "glb";
  readonly items: readonly IBundleItem[];
  readonly camera?: { readonly position: readonly number[]; readonly target: readonly number[] };
  /** Keep this fraction of triangles in the merged GLB (meshopt simplifier); 1 or unset keeps all. */
  readonly simplify?: number;
}

export interface IBundleReport {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly materials: number;
  readonly textures: number;
  readonly bytes?: number;
  readonly bounds: { readonly min: number[]; readonly max: number[] };
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const isVec = (value: unknown, n: number) =>
  Array.isArray(value) &&
  value.length === n &&
  value.every((v) => typeof v === "number" && Number.isFinite(v));

/** Validates a request from the page: a bad one throws before anything is written. */
export function parseBundleRequest(value: unknown): IBundleRequest {
  const request = value as Partial<IBundleRequest>;
  if (typeof request.name !== "string" || !NAME.test(request.name))
    throw new Error(
      "bundle name must be kebab-case: a lowercase letter, then letters, digits or '-'",
    );
  if (request.output !== "ts" && request.output !== "glb")
    throw new Error('bundle output must be "ts" or "glb"');
  if (!Array.isArray(request.items) || request.items.length === 0)
    throw new Error("bundle needs at least one item");
  for (const item of request.items)
    if (
      typeof item?.path !== "string" ||
      !isVec(item.position, 3) ||
      !isVec(item.quaternion, 4) ||
      !isVec(item.scale, 3)
    )
      throw new Error(
        "each bundle item needs a path, a position[3], a quaternion[4] and a scale[3]",
      );
  if (request.simplify !== undefined && !(request.simplify > 0 && request.simplify <= 1))
    throw new Error("simplify must be in (0, 1]");
  return request as IBundleRequest;
}

const camel = (name: string) =>
  name
    .replace(/-([a-z0-9])/gu, (_, c: string) => c.toUpperCase())
    .replace(/^./u, (c) => c.toUpperCase());
const round = (values: readonly number[]) => values.map((v) => Math.round(v * 1e4) / 1e4);

/** The scene module's source. Repeated models become one `InstancedMesh` per mesh part. */
export function sceneModuleText(request: IBundleRequest, source: string): string {
  const groups = new Map<string, IBundleItem[]>();
  for (const item of request.items) {
    const logical = path.posix.relative(source, item.path);
    groups.set(logical, [...(groups.get(logical) ?? []), item]);
  }
  const placements = [...groups]
    .map(
      ([logical, items]) =>
        `  ${JSON.stringify(logical)}: [\n${items
          .map(
            (item) =>
              `    { position: [${round(item.position).join(", ")}], quaternion: [${round(item.quaternion).join(", ")}], scale: [${round(item.scale).join(", ")}] },`,
          )
          .join("\n")}\n  ],`,
    )
    .join("\n");
  const camera = request.camera
    ? `\n/** The framing the bundler saved: eye and target, in metres. */\nexport const ${camel(request.name).toUpperCase()}_CAMERA = {\n  position: [${round(request.camera.position).join(", ")}],\n  target: [${round(request.camera.target).join(", ")}],\n} as const;\n`
    : "";
  return `// Written by the Asset Library Scene Bundler (/__assets/, Stage). Ordinary game source: edit,
// move or delete it freely; nothing reads it back.
import {
  Group,
  InstancedMesh,
  Matrix4,
  type Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";

interface IPlacement {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** Where each model sits, keyed by its path under assets/. */
const PLACEMENTS: Readonly<Record<string, readonly IPlacement[]>> = {
${placements}
};
${camera}
const matrixOf = (p: IPlacement) =>
  new Matrix4().compose(
    new Vector3(...p.position),
    new Quaternion(...p.quaternion),
    new Vector3(...p.scale),
  );

/** One model placed many times: each mesh part becomes one InstancedMesh, one draw for all copies. */
function instanced(source: Object3D, placements: readonly IPlacement[]): Group {
  const group = new Group();
  source.updateMatrixWorld(true);
  source.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const copies = new InstancedMesh(mesh.geometry, mesh.material, placements.length);
    copies.name = mesh.name;
    copies.castShadow = copies.receiveShadow = true;
    placements.forEach((p, i) => copies.setMatrixAt(i, matrixOf(p).multiply(mesh.matrixWorld)));
    copies.computeBoundingSphere();
    group.add(copies);
  });
  return group;
}

/** Builds the ${request.name} scene: add the returned group to your scene. */
export async function create${camel(request.name)}(ctx: {
  readonly assets: { model<T>(path: string): Promise<T> };
}): Promise<Group> {
  const root = new Group();
  root.name = ${JSON.stringify(request.name)};
  for (const [file, placements] of Object.entries(PLACEMENTS)) {
    const model = await ctx.assets.model<{ scene: Object3D }>(file);
    const [only] = placements;
    if (placements.length === 1 && only !== undefined) {
      const copy = model.scene.clone();
      copy.applyMatrix4(matrixOf(only));
      root.add(copy);
    } else root.add(instanced(model.scene, placements));
  }
  return root;
}
`;
}

/** Merges every item into one static GLB: transforms baked, materials and textures deduplicated. */
export async function mergedGlb(
  root: string,
  request: IBundleRequest,
  out: string,
): Promise<IBundleReport> {
  const [{ NodeIO, Document }, { ALL_EXTENSIONS }, functions] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/functions"),
  ]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  try {
    const { MeshoptDecoder, MeshoptEncoder } = await import("meshoptimizer");
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
    io.registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
  } catch {
    // Sources without meshopt compression read without it.
  }
  const target = new Document();
  target.createBuffer();
  const scene = target.createScene(request.name);
  target.getRoot().setDefaultScene(scene);
  const cache = new Map<string, InstanceType<typeof Document>>();
  for (const item of request.items) {
    const file = path.resolve(root, item.path);
    const source = cache.get(file) ?? (await io.read(file));
    cache.set(file, source);
    const map = functions.mergeDocuments(target, source);
    const parent = target
      .createNode(path.posix.basename(item.path, path.extname(item.path)))
      .setTranslation([...item.position])
      .setRotation([...item.quaternion])
      .setScale([...item.scale]);
    scene.addChild(parent);
    const sourceScene = source.getRoot().getDefaultScene() ?? source.getRoot().listScenes()[0];
    for (const child of sourceScene?.listChildren() ?? []) {
      const copy = map.get(child) as typeof parent | undefined;
      if (copy) parent.addChild(copy);
    }
  }
  // A bundle is static: animation, skins and the merged-in scenes have no place in it.
  for (const animation of target.getRoot().listAnimations()) animation.dispose();
  for (const skin of target.getRoot().listSkins()) skin.dispose();
  for (const extra of target.getRoot().listScenes()) if (extra !== scene) extra.dispose();
  const steps = [functions.dedup(), functions.flatten(), functions.join(), functions.prune()];
  if (request.simplify !== undefined && request.simplify < 1) {
    const { MeshoptSimplifier } = await import("meshoptimizer");
    await MeshoptSimplifier.ready;
    steps.push(
      functions.weld(),
      functions.simplify({ simplifier: MeshoptSimplifier, ratio: request.simplify, error: 0.001 }),
    );
  }
  // mergeDocuments brings each source's buffer along; a GLB holds exactly one.
  const [primary, ...others] = target.getRoot().listBuffers();
  for (const accessor of target.getRoot().listAccessors()) accessor.setBuffer(primary ?? null);
  for (const buffer of others) buffer.dispose();
  await target.transform(...steps);
  await mkdir(path.dirname(out), { recursive: true });
  await io.write(out, target);
  let drawCalls = 0;
  let triangles = 0;
  for (const node of target.getRoot().listNodes()) {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      drawCalls += 1;
      triangles +=
        (primitive.getIndices()?.getCount() ??
          primitive.getAttribute("POSITION")?.getCount() ??
          0) / 3;
    }
  }
  const bounds = functions.getBounds(scene);
  return {
    drawCalls,
    triangles: Math.round(triangles),
    materials: target.getRoot().listMaterials().length,
    textures: target.getRoot().listTextures().length,
    bytes: (await stat(out)).size,
    bounds: { min: [...bounds.min], max: [...bounds.max] },
  };
}

/** What the scene module draws: one draw per mesh part of each distinct model (instancing). */
async function moduleReport(root: string, request: IBundleRequest): Promise<IBundleReport> {
  const [{ NodeIO }, { ALL_EXTENSIONS }, functions] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/functions"),
  ]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let drawCalls = 0;
  let triangles = 0;
  const materials = new Set<string>();
  const textures = new Set<string>();
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const counts = new Map<string, number>();
  for (const item of request.items) counts.set(item.path, (counts.get(item.path) ?? 0) + 1);
  for (const [file, copies] of counts) {
    const document = await io.read(path.resolve(root, file));
    let parts = 0;
    let tris = 0;
    for (const mesh of document.getRoot().listMeshes())
      for (const primitive of mesh.listPrimitives()) {
        parts += 1;
        tris +=
          (primitive.getIndices()?.getCount() ??
            primitive.getAttribute("POSITION")?.getCount() ??
            0) / 3;
      }
    drawCalls += parts;
    triangles += tris * copies;
    for (const m of document.getRoot().listMaterials()) materials.add(`${file}#${m.getName()}`);
    for (const t of document.getRoot().listTextures())
      textures.add(`${file}#${t.getURI() || t.getName()}`);
    const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
    if (!scene) continue;
    const box = functions.getBounds(scene);
    for (const item of request.items.filter((i) => i.path === file))
      for (let k = 0; k < 3; k += 1) {
        const s = item.scale[k] ?? 1;
        min[k] = Math.min(min[k] as number, (item.position[k] ?? 0) + (box.min[k] ?? 0) * s);
        max[k] = Math.max(max[k] as number, (item.position[k] ?? 0) + (box.max[k] ?? 0) * s);
      }
  }
  return {
    drawCalls,
    triangles: Math.round(triangles),
    materials: materials.size,
    textures: textures.size,
    bounds: { min, max },
  };
}

/** Writes the requested output and reports what it holds. */
export async function writeBundle(
  root: string,
  source: string,
  value: unknown,
): Promise<{ written: string; report: IBundleReport }> {
  const request = parseBundleRequest(value);
  for (const item of request.items)
    if (!containedFile(root, item.path, [source]))
      throw new Error(`bundle item must be under ${source}/: ${item.path}`);
  if (request.output === "ts") {
    const written = `src/scenes/${request.name}.ts`;
    const file = path.join(root, written);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, sceneModuleText(request, source), "utf8");
    return { written, report: await moduleReport(root, request) };
  }
  const written = `${source}/bundles/${request.name}.glb`;
  return { written, report: await mergedGlb(root, request, path.join(root, written)) };
}
