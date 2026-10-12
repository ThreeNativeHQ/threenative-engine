/**
 * Records `RenderCameraCull`'s report for ~17 deterministic scenes as a C++ table the native test
 * rebuilds with the ported object model and compares field for field (PRD-519). Every double is
 * recorded as its binary64 bit pattern, so the comparison is exact.
 *
 * Each scene is described as flat data the C++ test replays: a node list with parent indices, each
 * mesh's geometry bounding sphere as three computed it, positions, scales, flags, a camera, a
 * viewport height and the gate options. The C++ test builds the same graph natively, calls its
 * `CameraCull`, and compares the report.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/visibility/camera-cull-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
} from "three";

import {
  DEFAULT_MINIMUM_PROJECTED_PIXELS,
  RenderCameraCull,
  alwaysRender,
} from "../../../../core/src/render-camera-cull.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "camera_cull_reference.inc");

const f64 = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const bits = (x: number) => `0x${f64(x).toString(16).padStart(16, "0")}ull`;

interface INodeSpec {
  mesh: boolean;
  parent: number; // -1 scene root, -2 camera, otherwise a node index
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  radius: number;
  castShadow: boolean;
  frustumCulled: boolean;
  mark: boolean;
  visible: boolean;
  layer: number;
}

type INodeInput = {
  mesh: boolean;
  parent: number;
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  radius?: number;
  castShadow?: boolean;
  frustumCulled?: boolean;
  mark?: boolean;
  visible?: boolean;
  layer?: number;
};

const node = (input: INodeInput): INodeSpec => ({
  mesh: input.mesh,
  parent: input.parent,
  x: input.x ?? 0,
  y: input.y ?? 0,
  z: input.z ?? 0,
  sx: input.scale ?? 1,
  sy: input.scale ?? 1,
  sz: input.scale ?? 1,
  radius: input.radius ?? 0,
  castShadow: input.castShadow ?? false,
  frustumCulled: input.frustumCulled ?? true,
  mark: input.mark ?? false,
  visible: input.visible ?? true,
  layer: input.layer ?? 0,
});

interface ISceneSpec {
  nodes: INodeSpec[];
  perspective: boolean;
  fov: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  viewportHeight: number;
  enabled: boolean;
  minimumPixels: number;
}

interface IRecord {
  centers: [number, number, number][];
  radii: number[];
  report: Record<string, number | boolean>;
}

const scene = (spec: Partial<ISceneSpec> & { nodes: INodeSpec[] }): ISceneSpec => ({
  nodes: spec.nodes,
  perspective: spec.perspective ?? true,
  fov: spec.fov ?? 60,
  cameraX: spec.cameraX ?? 0,
  cameraY: spec.cameraY ?? 0,
  cameraZ: spec.cameraZ ?? 0,
  viewportHeight: spec.viewportHeight ?? 720,
  enabled: spec.enabled ?? true,
  minimumPixels: spec.minimumPixels ?? DEFAULT_MINIMUM_PROJECTED_PIXELS,
});

function sphereGeometry(radius: number): SphereGeometry {
  const geometry = new SphereGeometry(radius, 8, 6);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Builds a real three scene from the flat spec, applying the gate and recording its report. */
function record(spec: ISceneSpec): {
  centers: [number, number, number][];
  radii: number[];
  report: Record<string, number | boolean>;
} {
  const root = new Scene();
  const objects: Object3D[] = [];
  const centers: [number, number, number][] = [];
  const radii: number[] = [];
  for (const entry of spec.nodes) {
    let object: Object3D;
    if (entry.mesh) {
      const geometry = sphereGeometry(entry.radius);
      const sphere = geometry.boundingSphere;
      if (sphere === null) throw new Error("fixture: SphereGeometry has no bounding sphere");
      centers.push([sphere.center.x, sphere.center.y, sphere.center.z]);
      radii.push(sphere.radius);
      object = new Mesh(geometry, new MeshBasicMaterial());
    } else {
      centers.push([0, 0, 0]);
      radii.push(0);
      object = new Group();
    }
    object.position.set(entry.x, entry.y, entry.z);
    object.scale.set(entry.sx, entry.sy, entry.sz);
    object.visible = entry.visible;
    object.castShadow = entry.castShadow;
    object.frustumCulled = entry.frustumCulled;
    object.layers.set(entry.layer);
    objects.push(object);
  }

  const camera = spec.perspective
    ? new PerspectiveCamera(spec.fov, 1, 0.1, 1_000_000)
    : new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(spec.cameraX, spec.cameraY, spec.cameraZ);
  camera.updateMatrixWorld();

  const cameraInScene = spec.nodes.some((entry) => entry.parent === -2);
  if (cameraInScene) root.add(camera);
  for (let index = 0; index < spec.nodes.length; index += 1) {
    const parent = spec.nodes[index].parent;
    const target = parent === -2 ? camera : parent < 0 ? root : objects[parent];
    target.add(objects[index]);
  }
  for (let index = 0; index < spec.nodes.length; index += 1) {
    if (spec.nodes[index].mark) alwaysRender(objects[index]);
  }
  root.updateMatrixWorld();
  camera.updateMatrixWorld();

  const cull = new RenderCameraCull(
    spec.enabled ? { minimumPixels: spec.minimumPixels } : { minimumPixels: false },
  );
  cull.apply(root, camera, spec.viewportHeight);
  return { centers, radii, report: { ...cull.report } as Record<string, number | boolean> };
}

/* ---- the scenes ---- */

const TINY = 0.1;
const FAR = -1_000;

const scenes: ISceneSpec[] = [
  scene({
    nodes: [
      node({ mesh: true, parent: -1, radius: TINY, z: FAR }),
      node({ mesh: true, parent: -1, radius: 1, z: -100 }),
    ],
  }),
  scene({
    nodes: [
      node({ mesh: false, parent: -1, visible: false }),
      node({ mesh: true, parent: 0, radius: TINY, z: FAR }),
      node({ mesh: true, parent: -1, radius: TINY, z: FAR }),
    ],
  }),
  scene({
    nodes: [
      node({ mesh: false, parent: -1 }),
      node({ mesh: false, parent: 0 }),
      node({ mesh: true, parent: 1, radius: TINY, z: FAR }),
      node({ mesh: true, parent: 1, radius: 1, z: -100 }),
    ],
  }),
  scene({
    nodes: [node({ mesh: true, parent: -1, radius: 0.01, x: 100_000, z: FAR, castShadow: true })],
  }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 0.01, z: FAR, castShadow: true })] }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 0.01, z: FAR, mark: true })] }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 0.01, z: FAR, frustumCulled: false })] }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 0, z: FAR })] }),
  scene({
    nodes: [
      node({ mesh: true, parent: -1, radius: TINY, z: FAR, layer: 3 }),
      node({ mesh: true, parent: -1, radius: TINY, z: FAR, layer: 7 }),
    ],
  }),
  scene({ nodes: [node({ mesh: true, parent: -2, radius: 0.01, z: FAR })] }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 0.001, z: -100 })], perspective: false }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 1, z: -100 })], viewportHeight: 0.5 }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 1, z: -100 })], minimumPixels: 40 }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: TINY, z: FAR })], enabled: false }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 1, z: FAR })], minimumPixels: 5 }),
  scene({
    nodes: [node({ mesh: true, parent: -1, radius: 1, z: FAR })],
    minimumPixels: 5,
    cameraZ: -900,
  }),
  scene({ nodes: [node({ mesh: true, parent: -1, radius: 0.001, z: FAR, scale: 1_000 })] }),
];

const recorded = scenes.map((spec) => ({ spec, ...record(spec) }));

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/visibility/camera-cull-reference.ts",
  "// from packages/core/src/render-camera-cull.ts. Do not edit: rerun the generator. Doubles are",
  "// binary64 bit patterns; counts are decimal integers.",
  "",
];
for (const [index, { spec, centers, radii, report }] of recorded.entries()) {
  lines.push(`static const RefNode kCameraCullNodes${index}[] = {`);
  for (const [nodeIndex, entry] of spec.nodes.entries()) {
    const [cx, cy, cz] = centers[nodeIndex] as [number, number, number];
    lines.push(
      `    {${entry.parent}, ${entry.mesh}, ${bits(entry.x)}, ${bits(entry.y)}, ${bits(entry.z)}, ` +
        `${bits(entry.sx)}, ${bits(entry.sy)}, ${bits(entry.sz)}, ${bits(radii[nodeIndex] as number)}, ` +
        `${bits(cx)}, ${bits(cy)}, ${bits(cz)}, ${entry.castShadow}, ${entry.frustumCulled}, ` +
        `${entry.mark}, ${entry.visible}, ${entry.layer}u},`,
    );
  }
  lines.push("};", "");
}
lines.push("static const RefScene kCameraCullScenes[] = {");
for (const [index, { spec, report }] of recorded.entries()) {
  lines.push(
    `    {kCameraCullNodes${index}, std::size(kCameraCullNodes${index}), ` +
      `{${spec.perspective}, ${bits(spec.fov)}, ${bits(spec.cameraX)}, ${bits(spec.cameraY)}, ${bits(spec.cameraZ)}}, ` +
      `${bits(spec.viewportHeight)}, ${spec.enabled}, ${bits(spec.minimumPixels)}, ` +
      `{${Boolean(report.enabled)}, ${Boolean(report.cameraResolved)}, ${bits(report.thresholdPixels as number)}, ` +
      `${report.considered}u, ${report.culled}u, ${report.exemptCameraAttached}u, ${report.exemptMarked}u, ` +
      `${report.exemptShadowCasters}u, ${report.exemptWithoutBounds}u, ${report.exemptDynamicBounds}u, ` +
      `${report.exemptFrustumCulled}u}},`,
  );
}
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      "TN_FIXTURE_STALE: camera_cull_reference.inc is not what the core module produces",
    );
    process.exit(1);
  }
  console.log("current: camera_cull_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
