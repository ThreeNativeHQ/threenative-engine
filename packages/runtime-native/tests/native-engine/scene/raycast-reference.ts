/** Real three@0.185.1 oracle. node --import tsx <this file> [--check] [--lod|--raycaster]. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as three from "three";
import { numberBits, pinnedThreeVersion } from "../../../../three-native/src/fixture-format.js";

interface IObjectSpec {
  name: string;
  kind: "group" | "mesh" | "instanced" | "line" | "segments";
  position?: number[];
  rotation?: number[];
  scale?: number[];
  side?: number;
  indexed?: boolean;
  layer?: number;
  visible?: boolean;
  box?: boolean;
  clippedBox?: boolean;
  sphere?: number;
  draw?: number[];
  channels?: boolean;
  morph?: boolean;
  children?: IObjectSpec[];
}
const geometry = (spec: IObjectSpec) => {
  let g = new three.BufferGeometry();
  g.setAttribute(
    "position",
    new three.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  if (spec.channels !== false) {
    g.setAttribute("uv", new three.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setAttribute(
      "uv1",
      new three.Float32BufferAttribute([0.1, 0.2, 0.8, 0.3, 0.7, 0.9, 0.2, 0.8], 2),
    );
    g.setAttribute(
      "normal",
      new three.Float32BufferAttribute([0, 0, 1, 0.2, 0, 0.8, 0, 0.3, 1, -0.2, 0, 0.9], 3),
    );
  }
  if (spec.indexed === false) g = g.toNonIndexed();
  if (spec.morph) {
    const m = g.getAttribute("position").clone();
    for (let i = 0; i < m.count; i++) m.setZ(i, 0.5);
    g.morphAttributes.position = [m];
  }
  if (spec.box) g.computeBoundingBox();
  if (spec.clippedBox)
    g.boundingBox = new three.Box3(new three.Vector3(-1, -1, -1), new three.Vector3(-0.5, 1, 1));
  if (spec.sphere !== undefined)
    g.boundingSphere = new three.Sphere(new three.Vector3(), spec.sphere);
  if (spec.draw) g.setDrawRange(spec.draw[0], spec.draw[1]);
  return g;
};
function build(spec: IObjectSpec): three.Object3D {
  let o: three.Object3D;
  if (spec.kind === "group") o = new three.Group();
  else {
    const g = geometry(spec);
    const m = new three.MeshBasicMaterial({ side: spec.side ?? three.FrontSide });
    if (spec.kind === "line" || spec.kind === "segments") {
      const LineClass = spec.kind === "line" ? three.Line : three.LineSegments;
      o = new LineClass(g, new three.LineBasicMaterial());
    } else if (spec.kind === "instanced") {
      const mesh = new three.InstancedMesh(g, m, 3);
      for (let i = 0; i < 3; i++) {
        const matrix = new three.Matrix4().makeRotationY(i * 0.2);
        matrix.setPosition(i * 3, 0, -i);
        mesh.setMatrixAt(i, matrix);
      }
      o = mesh;
    } else {
      const mesh = new three.Mesh(g, m);
      if (spec.morph) {
        if (!mesh.morphTargetInfluences) throw new Error("missing morph influences");
        mesh.morphTargetInfluences[0] = 0.4;
      }
      o = mesh;
    }
  }
  o.name = spec.name;
  if (spec.position) o.position.fromArray(spec.position);
  if (spec.rotation) o.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
  if (spec.scale) o.scale.fromArray(spec.scale);
  if (spec.layer !== undefined) o.layers.set(spec.layer);
  if (spec.visible !== undefined) o.visible = spec.visible;
  for (const child of spec.children ?? []) o.add(build(child));
  return o;
}
const vec = (v: three.Vector2 | three.Vector3) => v.toArray().map(numberBits);
function hit(h: three.Intersection) {
  return {
    distance: numberBits(h.distance),
    point: vec(h.point),
    object: h.object.name,
    faceIndex: h.faceIndex ?? null,
    index: h.index ?? null,
    face: h.face
      ? {
          a: h.face.a,
          b: h.face.b,
          c: h.face.c,
          normal: vec(h.face.normal),
          materialIndex: h.face.materialIndex,
        }
      : null,
    uv: h.uv ? vec(h.uv) : null,
    uv1: h.uv1 ? vec(h.uv1) : null,
    normal: h.normal ? vec(h.normal) : null,
    instanceId: h.instanceId ?? null,
    barycoord: h.barycoord ? vec(h.barycoord as three.Vector3) : null,
  };
}
const specs: IObjectSpec[] = [
  { name: "front", kind: "mesh", side: 0, box: true },
  { name: "back", kind: "mesh", side: 1, position: [4, 0, 0], indexed: false },
  {
    name: "double",
    kind: "mesh",
    side: 2,
    position: [8, 0, 0],
    rotation: [0.2, 0.4, -0.1],
    scale: [2, 0.5, 1.5],
    box: true,
  },
  {
    name: "layer",
    kind: "mesh",
    side: 2,
    position: [12, 0, 0],
    layer: 2,
    visible: false,
    channels: false,
  },
  { name: "draw", kind: "mesh", side: 2, position: [16, 0, 0], indexed: false, draw: [3, 3] },
  { name: "morph", kind: "mesh", side: 2, position: [20, 0, 0], morph: true },
  {
    name: "instances",
    kind: "instanced",
    side: 2,
    position: [0, 4, 0],
    rotation: [0, 0, 0.1],
    scale: [0.75, 1.5, 2],
  },
  { name: "box-out", kind: "mesh", position: [25, 0, 0], sphere: 100, box: true },
  { name: "sphere-out", kind: "mesh", position: [30, 0, 0], sphere: 0.01 },
];
specs.push({ name: "clipped-box", kind: "mesh", side: 2, position: [35, 0, 0], clippedBox: true });
// Lines hit within raycaster.params.Line.threshold (1) of a segment: a strip over the indexed quad,
// and non-indexed segments, scaled so the threshold shrinks to local space.
specs.push({ name: "line", kind: "line", position: [40, 0, 0], scale: [1.5, 1.5, 1.5] });
specs.push({ name: "segments", kind: "segments", position: [45, 0, 0], indexed: false });
const sceneSpec: IObjectSpec = {
  name: "root",
  kind: "group",
  children: [
    {
      name: "outer",
      kind: "group",
      position: [0.1, -0.2, -1],
      rotation: [0, 0.05, 0],
      children: [{ name: "inner", kind: "group", scale: [1.25, 1, 0.8], children: specs }],
    },
    { name: "tie-a", kind: "mesh", side: 2, position: [0, -4, 0] },
    { name: "tie-b", kind: "mesh", side: 2, position: [0, -4, 0] },
  ],
};
const scene = build(sceneSpec);
scene.updateMatrixWorld(true);
const rays: Record<string, unknown>[] = [];
function rayCase(
  name: string,
  origin: three.Vector3,
  direction: three.Vector3,
  options: {
    near?: number;
    far?: number;
    layer?: number;
    recursive?: boolean;
    target?: string;
    multiple?: boolean;
  } = {},
) {
  const r = new three.Raycaster(origin, direction, options.near ?? 0, options.far ?? 100);
  r.layers.set(options.layer ?? 0);
  const target = options.target ? scene.getObjectByName(options.target) : scene;
  if (!target) throw new Error("missing ray target");
  const hits = options.multiple
    ? r.intersectObjects(scene.children, options.recursive ?? true)
    : r.intersectObject(target, options.recursive ?? true);
  rays.push({
    name,
    origin: origin.toArray(),
    direction: direction.toArray(),
    near: r.near,
    far: r.far,
    layer: options.layer ?? 0,
    recursive: options.recursive ?? true,
    target: target.name,
    multiple: options.multiple ?? false,
    hits: hits.map(hit),
  });
}
for (const spec of specs) {
  const o = scene.getObjectByName(spec.name);
  if (!o) throw new Error("missing scene object");
  for (let i = 0; i < 8; i++) {
    const local = new three.Vector3(
      i === 6 ? 2 : i === 7 ? 0 : 0.3,
      i === 7 ? 0 : i === 5 ? 0.8 : -0.2,
      0,
    );
    const point = local.clone().applyMatrix4(o.matrixWorld);
    const origin = local
      .clone()
      .add(new three.Vector3(i === 4 ? 0.2 : 0, 0, i % 2 === 0 ? 5 : -5))
      .applyMatrix4(o.matrixWorld);
    rayCase(`${spec.name}-${i}`, origin, point.sub(origin).normalize(), {
      layer: i === 3 ? 2 : 0,
      near: i === 4 ? 100 : 0,
      far: i === 5 ? 1 : 100,
      recursive: i !== 2,
      target: i === 2 ? "inner" : undefined,
      multiple: i === 1,
    });
  }
}
const instances = scene.getObjectByName("instances") as three.InstancedMesh;
for (let id = 0; id < 3; id++) {
  const m = new three.Matrix4();
  instances.getMatrixAt(id, m);
  m.premultiply(instances.matrixWorld);
  const target = new three.Vector3(0.1, -0.2, 0).applyMatrix4(m);
  for (const back of [false, true]) {
    const origin = new three.Vector3(0.1, -0.2, back ? -5 : 5).applyMatrix4(m);
    rayCase(`instance-${id}-${back}`, origin, target.clone().sub(origin).normalize());
  }
}
for (const [near, far] of [
  [4, 4],
  [4.0001, 100],
  [0, 3.9999],
  [0, 100],
])
  rayCase(`tie-${near}-${far}`, new three.Vector3(0.2, -4.3, 4), new three.Vector3(0, 0, -1), {
    near,
    far,
  });
rayCase("origin-on-plane", new three.Vector3(0.2, -4.3, 0), new three.Vector3(0, 0, -1));

function lodTable() {
  const result: Record<string, unknown>[] = [];
  for (const count of [0, 1, 4]) {
    const lod = new three.LOD();
    lod.position.set(0, 0, -2);
    const levels = [20, 0, -10, 10]
      .slice(0, count)
      .map((distance, i) => ({ distance, hysteresis: i === 0 ? 0.2 : 0.1, name: `level-${i}` }));
    for (const level of levels) {
      const object = build({ name: level.name, kind: "mesh", side: 2 });
      lod.addLevel(object, level.distance, level.hysteresis);
    }
    lod.updateMatrixWorld(true);
    const cases = [];
    const camera = new three.PerspectiveCamera();
    for (const [i, distance] of [
      0, 7.9999, 8, 8.9999, 9, 9.9999, 10, 10.0001, 15.9999, 16, 19.9999, 20, 20.0001, 19, 16,
      15.9999, 10, 9, 8.9999, 0, 40, 0, 40, 0,
    ].entries()) {
      lod.autoUpdate = i < 20;
      camera.zoom = i === 20 ? 2 : 1;
      camera.position.set(0, 0, distance - 2);
      camera.updateMatrixWorld(true);
      const explicit = i === 22;
      if (lod.autoUpdate || explicit) lod.update(camera);
      const r = new three.Raycaster(
        new three.Vector3(0.2, -0.3, distance - 2),
        new three.Vector3(0, 0, -1),
      );
      cases.push({
        distance,
        zoom: camera.zoom,
        autoUpdate: lod.autoUpdate,
        explicit,
        current: lod.getCurrentLevel(),
        selected: lod.getObjectForDistance(distance)?.name ?? null,
        visible: lod.levels.map((l) => l.object.visible),
        hits: r.intersectObject(lod, false).map(hit),
        recursiveHits: r.intersectObject(lod, true).map(hit),
      });
    }
    result.push({
      count,
      levels,
      sorted: lod.levels.map((l) => ({
        name: l.object.name,
        distance: numberBits(l.distance),
        hysteresis: numberBits(l.hysteresis),
      })),
      cases,
    });
  }
  return result;
}
const cameraCases = ["perspective", "orthographic"].flatMap((kind) =>
  [
    [0, 0],
    [-0.7, 0.4],
    [1, -1],
    [0.2, 0.3],
  ].map((coords) => {
    const camera =
      kind === "perspective"
        ? new three.PerspectiveCamera(53, 1.7, 0.3, 200)
        : new three.OrthographicCamera(-3, 5, 4, -2, 0.3, 200);
    camera.zoom = 1.8;
    camera.position.set(1, 2, 3);
    camera.rotation.set(0.1, 0.2, 0.3);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const caster = new three.Raycaster();
    caster.setFromCamera(new three.Vector2(coords[0], coords[1]), camera);
    return { kind, coords, origin: vec(caster.ray.origin), direction: vec(caster.ray.direction) };
  }),
);
const layerCases = [
  { mask: 1, operation: "set", layer: 31 },
  { mask: 1, operation: "enable", layer: 31 },
  { mask: 1, operation: "enableAll", layer: 0 },
  { mask: -1, operation: "disable", layer: 0 },
  { mask: 2147483648, operation: "toggle", layer: 31 },
  { mask: 1, operation: "set", layer: -1 },
  { mask: 1, operation: "set", layer: 32 },
  { mask: 1, operation: "set", layer: 63 },
  { mask: Number.POSITIVE_INFINITY, operation: "enable", layer: 2 },
  { mask: Number.NEGATIVE_INFINITY, operation: "disable", layer: 2 },
  { mask: 4294967297.75, operation: "enable", layer: 2 },
  { mask: -4294967297.75, operation: "toggle", layer: 2 },
  { mask: -0, operation: "test", layer: 0 },
  { mask: 2 ** 40, operation: "test", layer: 0 },
].map((spec) => {
  const layers = new three.Layers();
  layers.mask = spec.mask;
  if (spec.operation === "set") layers.set(spec.layer);
  else if (spec.operation === "enable") layers.enable(spec.layer);
  else if (spec.operation === "enableAll") layers.enableAll();
  else if (spec.operation === "disable") layers.disable(spec.layer);
  else if (spec.operation === "toggle") layers.toggle(spec.layer);
  const other = new three.Layers();
  other.set(spec.layer);
  return {
    ...spec,
    mask: numberBits(spec.mask),
    expected: numberBits(layers.mask),
    test: layers.test(other),
    enabled: layers.isEnabled(spec.layer),
  };
});
for (const kind of ["raycaster", "lod"]) {
  if (process.argv.includes("--lod") && kind !== "lod") continue;
  if (process.argv.includes("--raycaster") && kind !== "raycaster") continue;
  const out = fileURLToPath(new URL(`${kind}_reference.json`, import.meta.url));
  const data =
    kind === "raycaster"
      ? { scene: sceneSpec, rays, layerCases, cameraCases }
      : { scenes: lodTable() };
  const text = `${JSON.stringify({ three: pinnedThreeVersion(), ...data }, null, 1)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== text) throw new Error(`${kind} reference stale`);
    console.log(`${kind} reference current`);
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
  }
}
