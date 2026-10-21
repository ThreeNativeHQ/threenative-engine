/**
 * Records what the real `InstancedBatch` (packages/core/src/instanced-batch.ts) decides for every
 * case of packages/core/__tests__/instanced-batch.spec.ts, as the table the native port's test
 * replays (PRD-519): every placed matrix, every build's verdict, counts and warnings, every LOD
 * partition and its per-frame selection, and every refusal with the reason code the native port
 * answers for the same input (PRD-519 box 32).
 *
 * Each step is one line `case|step|field;field;...`. Numbers that are measurements are their 16 hex
 * digits of bits, so the native side compares three's double and not a rounded print of it; counts,
 * verdicts and flags are plain values.
 *
 * Not ported, and why:
 *   - The raycast assertions of "partitions near and far instances" (`Raycaster.intersectObject`
 *     over an InstancedMesh): InstancedMesh raycasting is not ported natively, and an instance query
 *     is not a batching decision. Every other assertion of that case is recorded here.
 *   - `meshPool`'s reuse: a pooled mesh is the same object, so the only observable decision is the
 *     minted instance width, which `ms=` records.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/projection/instanced-batch-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module decides today)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from "three";
import {
  type IInstancedBatchBuildOptions,
  type IInstancedBatchOptions,
  InstancedBatch,
} from "../../../../core/src/instanced-batch.js";
import {
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  lodChainOf,
  updateModelLods,
} from "../../../../core/src/model-lod.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "instanced_batch_reference.inc");

const bits = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return ((BigInt(words[1] as number) << 32n) | BigInt(words[0] as number))
    .toString(16)
    .padStart(16, "0");
};
const triples = (values: readonly number[]) => values.map(bits).join(",");
const flag = (value: boolean) => (value ? 1 : 0);
const matrix = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);

/** The reason code the native port answers for each refusal the reference throws. */
const REFUSALS: readonly (readonly [RegExp, string])[] = [
  [/geometry is required/u, "TN_BATCH_GEOMETRY_REQUIRED"],
  [/never chooses one/u, "TN_BATCH_MATERIAL_REQUIRED"],
  [/after build\(\)/u, "TN_BATCH_CLOSED"],
  [/already called/u, "TN_BATCH_ALREADY_BUILT"],
  [/\[x, y, z\] triple/u, "TN_BATCH_TRIPLE"],
  [/three finite numbers/u, "TN_BATCH_NOT_FINITE"],
  [/scale must be a finite number/u, "TN_BATCH_NOT_FINITE"],
  [/positive finite/u, "TN_BATCH_RADIUS"],
  [/same point/u, "TN_BATCH_SPAN_POINT"],
  [/autoLod/u, "TN_BATCH_AUTO_LOD"],
  [/strictly increasing/u, "TN_BATCH_LOD_DISTANCES"],
];

/** Runs one call and answers the native port's verdict for it: `ok`, or the reason code it refused. */
function attempt<T>(run: () => T): { ok: true; value: T } | { ok: false; code: string } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const found = REFUSALS.find(([pattern]) => pattern.test(message));
    if (found === undefined) throw error;
    return { ok: false, code: found[1] };
  }
}

/** The `readInstance` of the spec: position, scale and the axis a unit +Y shape ends up pointing along. */
function instance(mesh: InstancedMesh, index: number) {
  const read = new Matrix4();
  mesh.getMatrixAt(index, read);
  const position = new Vector3().setFromMatrixPosition(read);
  const scale = new Vector3().setFromMatrixScale(read);
  const axis = new Vector3(0, 1, 0).transformDirection(read);
  return { axis, position, scale };
}

const instanceOf = (mesh: InstancedMesh, index: number) => {
  const read = instance(mesh, index);
  return [...read.position.toArray(), ...read.scale.toArray(), ...read.axis.toArray()]
    .map(bits)
    .join(",");
};

/** The `draws(root)` of the spec: a visible partition with instances and something to draw. */
function draws(root: { traverse(callback: (object: unknown) => void): void }): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  root.traverse((object) => {
    if (
      object instanceof InstancedMesh &&
      object.visible &&
      object.count > 0 &&
      object.geometry.drawRange.count > 0
    )
      found.push(object);
  });
  return found;
}

function lodCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.updateMatrixWorld();
  return camera;
}

/** The box with one baked chain under it: LOD0 is 12 triangles, LOD1 the first two of them. */
async function bakedGeometry() {
  const geometry = new BoxGeometry();
  const source = new Mesh(geometry, new MeshBasicMaterial());
  const root = new Group().add(source);
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations: new Map([[source, { meshes: 0, primitives: 0 }]]),
    getDependency: async () => ({ array: new Uint32Array([0, 1, 2, 0, 2, 3]) }),
    json: {
      meshes: [
        {
          primitives: [
            {
              extensions: {
                [TN_DISCRETE_LOD]: {
                  schemaVersion: 1,
                  lod0Triangles: 12,
                  counts: [2],
                  errors: [0.1],
                  absoluteErrors: [0.1],
                  indices: [0],
                },
              },
            },
          ],
        },
      ],
    },
  });
  await plugin.afterRoot({});
  plugin.attach(root, undefined);
  return geometry;
}

/** One partition, as the native port's `Partition` records it. */
const partition = (draw: InstancedMesh) => {
  const colours =
    draw.instanceColor === null ? [] : Array.from(draw.instanceColor.array.slice(0, 3));
  return [
    draw.name.split(":").slice(1).join(":"),
    draw.count,
    draw.geometry.index?.count ?? 0,
    triples(colours.length === 3 ? colours : [0, 0, 0]),
    flag(draw.visible),
    flag(draw.castShadow),
    flag(draw.receiveShadow),
  ].join(":");
};
const partitions = (root: Parameters<typeof draws>[0]) => draws(root).map(partition).join(",");

// ------------------------------------------------------------------------------------- the cases

const steps: string[] = [];
const record = (name: string, step: string, fields: readonly string[]) =>
  steps.push(`${name}|${step}|${fields.join(";")}`);

const box = () => new BoxGeometry(1, 1, 1);
const material = () => new MeshBasicMaterial();
const batch = (options: Partial<IInstancedBatchOptions> = {}) =>
  new InstancedBatch({ geometry: box(), material: material(), ...options });
const built = (mesh: InstancedMesh | undefined) => [
  `m=${flag(mesh !== undefined)}`,
  `mc=${mesh?.count ?? 0}`,
  `ms=${mesh?.instanceMatrix.count ?? 0}`,
];
/** The `TN_INSTANCED_LOD_*` reports the build made, as Build::warnings records them natively. */
const reports = (warnings: readonly string[]) =>
  `w=${warnings.length}${warnings.length > 0 ? `:${warnings[0]}` : ""}`;

/** 1. Every placement collapses into one mesh with the transforms it was given. */
{
  const props = batch();
  props.place({ position: [1, 2, 3] });
  props.place({ position: [-4, 0, 5], scale: [2, 3, 4], rotation: [0, Math.PI / 2, 0] });
  record("collapse", "placed", [`n=${props.count}`]);
  const mesh = props.build();
  record("collapse", "built", [
    ...built(mesh),
    `i0=${instanceOf(mesh as InstancedMesh, 0)}`,
    `i1=${instanceOf(mesh as InstancedMesh, 1)}`,
  ]);
}

/** 2. Each placement hands back its instance index, and animating one leaves its neighbours alone. */
{
  const props = batch();
  const indices = [
    props.place({ position: [0, 0, 0] }),
    props.place({ position: [0, 5, 0] }),
    props.place({ position: [0, 9, 0] }),
  ];
  record("index", "placed", [`idx=${indices.join(",")}`]);
  const mesh = props.build() as InstancedMesh;
  mesh.setMatrixAt(indices[1] as number, matrix(7, 7, 7));
  record("index", "built", [
    ...built(mesh),
    `i1=${instanceOf(mesh, indices[1] as number)}`,
    `i2=${instanceOf(mesh, 2)}`,
  ]);
}

/** 3. The matrix it is handed is copied, so one scratch Matrix4 can drive every call. */
{
  const props = batch();
  const scratch = new Matrix4();
  props.add(scratch.makeTranslation(1, 0, 0));
  props.add(scratch.makeTranslation(2, 0, 0));
  const mesh = props.build() as InstancedMesh;
  record("add", "built", [
    ...built(mesh),
    `i0=${instanceOf(mesh, 0)}`,
    `i1=${instanceOf(mesh, 1)}`,
  ]);
}

/** 4. A span stretches a unit-height shape from one point toward the other. */
{
  const rods = new InstancedBatch({
    geometry: new CylinderGeometry(1, 1, 1, 6),
    material: material(),
  });
  rods.span([0, 0, 0], [0, 0, 10], 0.25);
  const mesh = rods.build() as InstancedMesh;
  record("span", "built", [...built(mesh), `i0=${instanceOf(mesh, 0)}`]);
}

/** 5. The batch is bounded around every instance, not around one un-transformed copy. */
{
  const props = batch();
  props.place({ position: [0, 0, 0] });
  props.place({ position: [100, 0, 0] });
  const mesh = props.build() as InstancedMesh;
  record("bounds", "built", [
    ...built(mesh),
    `r=${bits(mesh.boundingSphere?.radius ?? 0)}`,
    `over=${flag((mesh.boundingSphere?.radius ?? 0) > 50)}`,
  ]);
}

/** 6. The built mesh goes straight through to the parent, name and shadow flags. */
{
  const parent = new Group();
  const props = batch();
  props.place({ position: [0, 0, 0] });
  const options: IInstancedBatchBuildOptions = {
    castShadow: true,
    name: "curbs",
    parent,
    receiveShadow: true,
  };
  const mesh = props.build(options);
  record("parent", "built", [
    ...built(mesh),
    `pc=${parent.children.length}`,
    `nm=${mesh?.name ?? ""}`,
    `cast=${flag(mesh?.castShadow ?? false)}`,
    `recv=${flag(mesh?.receiveShadow ?? false)}`,
    `mm=${flag(props.mesh === mesh)}`,
  ]);
}

/** 7. The shadow flags default to three's own, so the batch decides nothing. */
{
  const props = batch();
  props.place({ position: [0, 0, 0] });
  const mesh = props.build();
  record("shadow-defaults", "built", [
    ...built(mesh),
    `cast=${flag(mesh?.castShadow ?? false)}`,
    `recv=${flag(mesh?.receiveShadow ?? false)}`,
  ]);
}

/** 8. An empty batch builds no mesh at all, and refuses every later placement. */
{
  const props = batch();
  const mesh = props.build();
  const refusals = [
    attempt(() => props.place({ position: [1, 0, 0] })),
    attempt(() => props.span([0, 0, 0], [0, 1, 0], 0.1)),
    attempt(() => props.add(new Matrix4())),
  ];
  record("empty", "built", [
    ...built(mesh),
    `mm=${flag(props.mesh === undefined)}`,
    ...refusals.map((refusal) => `v=${refusal.ok ? "ok" : refusal.code}`),
  ]);
}

/** 9. A batch refuses to place after build, because an InstancedMesh count is fixed. */
{
  const props = batch();
  props.place({ position: [0, 0, 0] });
  const mesh = props.build();
  const refusals = [
    attempt(() => props.place({ position: [1, 0, 0] })),
    attempt(() => props.span([0, 0, 0], [0, 1, 0], 0.1)),
    attempt(() => props.add(new Matrix4())),
    attempt(() => props.build()),
  ];
  record("closed", "built", [
    ...built(mesh),
    ...refusals.map((refusal) => `v=${refusal.ok ? "ok" : refusal.code}`),
  ]);
}

/** 10. Input that would silently shift every later index fails closed. */
{
  const props = batch();
  const refusals = [
    attempt(() => props.span([1, 2, 3], [1, 2, 3], 0.2)),
    attempt(() => props.span([0, 0, 0], [0, 1, 0], 0)),
    attempt(() => props.place({ position: [0, Number.NaN, 0] })),
    attempt(() =>
      props.place({
        position: [0, 0, 0],
        scale: [1, 2] as unknown as [number, number, number],
      }),
    ),
  ];
  record("fail-closed", "refused", [
    ...refusals.map((refusal) => `v=${refusal.ok ? "ok" : refusal.code}`),
    `n=${props.count}`,
  ]);
}

/** 11. The game supplies both the shape and the surface; the batch chooses neither. */
{
  const refusals = [
    attempt(
      () =>
        new InstancedBatch({
          geometry: undefined as unknown as BoxGeometry,
          material: material(),
        }),
    ),
    attempt(
      () =>
        new InstancedBatch({
          geometry: box(),
          material: undefined as unknown as MeshBasicMaterial,
        }),
    ),
  ];
  record(
    "requires-parts",
    "refused",
    refusals.map((refusal) => `v=${refusal.ok ? "ok" : refusal.code}`),
  );
}

/** 12. Invalid automatic selection options are refused even on geometry without a chain. */
{
  const props = new InstancedBatch({
    geometry: new BoxGeometry(),
    material: material(),
    autoLod: { maxPixelError: Number.NaN },
  });
  props.place({ position: [0, 0, 0] });
  const refused = attempt(() => props.build());
  record("auto-lod", "built", [`v=${refused.ok ? "ok" : refused.code}`]);
}

/** 13. Near and far instances partition through the engine frame tracker, with no game LOD code. */
{
  const props = new InstancedBatch({ geometry: await bakedGeometry(), material: material() });
  props.place({ position: [0, 0, -5] });
  props.place({ position: [0, 0, -100] });
  const root = new Group();
  const mesh = props.build({ name: "pines", parent: root, castShadow: true }) as InstancedMesh;
  mesh.setColorAt(0, new Color(1, 0, 0));
  mesh.setColorAt(1, new Color(0, 0, 1));
  root.updateMatrixWorld(true);
  const first = updateModelLods(root, lodCamera(), 1080);
  record("partitions", "frame", [
    `t=${first}`,
    `d=${partitions(root)}`,
    `ac=${mesh.children.length}`,
  ]);
  // Public matrices retain placement order: a far slot moved near joins the near partition.
  mesh.setMatrixAt(1, matrix(0, 0, -5));
  const second = updateModelLods(root, lodCamera(), 1080);
  record("partitions", "moved", [`t=${second}`, `d=${partitions(root)}`]);
  root.remove(mesh);
  root.add(mesh);
  const third = updateModelLods(root, lodCamera(), 1080);
  record("partitions", "readded", [`t=${third}`, `d=${partitions(root)}`]);
}

/** 14. Empty render partitions stay visible across LOD changes, so projection lights are stable. */
{
  const props = new InstancedBatch({ geometry: await bakedGeometry(), material: material() });
  props.place({ position: [0, 0, -100] });
  const root = new Group();
  const mesh = props.build({
    parent: root,
    castShadow: true,
    receiveShadow: true,
  }) as InstancedMesh;
  const flags = () =>
    mesh.children.map(
      (child) => `${flag(child.castShadow && child.receiveShadow)}${flag(child.visible)}`,
    );
  record("empty-partitions", "built", [`ac=${mesh.children.length}`, `f=${flags().join(",")}`]);
  const far = updateModelLods(root, lodCamera(), 1080);
  record("empty-partitions", "far", [`t=${far}`, `f=${flags().join(",")}`]);
  mesh.setMatrixAt(0, matrix(0, 0, -5));
  const near = updateModelLods(root, lodCamera(), 1080);
  record("empty-partitions", "near", [`t=${near}`, `f=${flags().join(",")}`]);
}

/** 15. A broad LOD batch is spatially bounded while retaining its offscreen shadow casters. */
{
  const props = new InstancedBatch({ geometry: await bakedGeometry(), material: material() });
  for (const x of [100, 0, -100, 80, -1, -80, 60, 1, -60]) props.place({ position: [x, 0, -10] });
  const root = new Group();
  const mesh = props.build({ parent: root, castShadow: true }) as InstancedMesh;
  const camera = lodCamera();
  updateModelLods(root, camera, 1080);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const found = draws(root);
  const visible = found.filter(
    (child) =>
      child.boundingSphere !== null &&
      frustum.intersectsSphere(child.boundingSphere.clone().applyMatrix4(child.matrixWorld)),
  );
  const read = new Matrix4();
  mesh.getMatrixAt(0, read);
  record("broad", "frame", [
    `t=${updateModelLods(root, camera, 1080)}`,
    `d=${partitions(root)}`,
    `fr=${visible.reduce((sum, child) => sum + child.count * 12, 0)}`,
    `tot=${found.reduce((sum, child) => sum + child.count, 0)}`,
    `cv=${flag(found.every((child) => child.castShadow && child.visible))}`,
    `nx=${bits(read.elements[12] as number)}`,
  ]);
}

/** 16. A scaled parent and a moving camera both move the switch distances. */
{
  const geometry = (await bakedGeometry()).clone().applyMatrix4(new Matrix4().makeScale(2, 3, 4));
  const props = new InstancedBatch({ geometry, material: material() });
  props.place({ position: [0, 0, -150] });
  const root = new Group();
  root.scale.setScalar(2);
  props.build({ parent: root });
  root.updateMatrixWorld(true);
  const camera = lodCamera();
  record("scaled-parent", "chain", [`e1=${bits(lodChainOf(geometry)?.errors[1] ?? 0)}`]);
  const far = updateModelLods(root, camera, 1080);
  camera.position.z = -290;
  const near = updateModelLods(root, camera, 1080);
  record("scaled-parent", "levels", [`t0=${far}`, `t1=${near}`]);
}

/** 17. Authored levels win, a failed rung warns once with the batch name, and opt-out keeps LOD0. */
{
  const geometry = await bakedGeometry();
  const authored = new BoxGeometry(2, 2, 2);
  authored.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  const warnings: string[] = [];
  const spy = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  const props = new InstancedBatch({
    geometry,
    material: material(),
    lods: [
      { distance: 10, geometry: authored },
      { distance: 20, geometry: undefined },
    ],
  });
  props.place({ position: [0, 0, -100] });
  const root = new Group();
  const mesh = props.build({ parent: root, name: "authored-pines" });
  console.warn = spy;
  root.updateMatrixWorld(true);
  updateModelLods(root, lodCamera(), 1080);
  updateModelLods(root, lodCamera(), 1080);
  record("authored", "built", [
    ...built(mesh),
    `d=${partitions(root)}`,
    `g=${draws(root).every((draw) => draw.geometry === authored) ? "authored" : "other"}`,
    reports(warnings),
  ]);
  const fixed = new InstancedBatch({ geometry, material: material(), autoLod: false });
  fixed.place({ position: [0, 0, -100] });
  const kept = fixed.build();
  record("authored", "opt-out", [
    `g=${kept?.geometry === geometry ? "base" : "other"}`,
    `ac=${kept?.children.length ?? 0}`,
  ]);
}

// ------------------------------------------------------------------------------------- the table

const text = [
  "// Generated by packages/runtime-native/tests/native-engine/projection/instanced-batch-reference.ts.",
  "// Do not edit: rerun the generator. Each line is case|step|field;field, and every measurement is",
  "// its 16 hex digits of bits.",
  "static const char* const kSteps[] = {",
  ...steps.map((step) => `    ${JSON.stringify(step)},`),
  "};",
  "",
].join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      `TN_INSTANCED_BATCH_REFERENCE_STALE: ${path.relative(process.cwd(), OUT)} is not what instanced-batch.ts decides today`,
    );
    process.exit(1);
  }
  console.log(`instanced batch reference current: ${steps.length} steps`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${steps.length} steps to ${OUT}`);
}
