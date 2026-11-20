import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import {
  createStylizedAsset,
  sky as makeStylizedSky,
  stylizedMaterials,
  stylizedUniforms,
} from "../src/stylized.js";
import Outcrop from "../vendor/outcrop.js";

// /api/catalog serves the story index and bake controls for both asset sources.
interface IElement {
  id: string;
  name: string;
  latin?: string;
  kind: string;
  biomes: string[];
  bake?: string;
  variants?: number;
  variantNames?: readonly string[];
  category?: string;
}
interface IBiome {
  id: string;
  name: string;
  rock: string;
}
interface IControl {
  key: string;
  label: string;
  type: "range" | "select" | "toggle" | "text";
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  labels?: readonly string[];
  default?: number | string | boolean;
  only?: string[];
}
interface IBake {
  lod: number;
  triangles: number;
  bounds: { min: number[]; max: number[] };
  ms: number;
  url: string;
  path: string;
  rock?: { tile: number };
  rockMaps?: { detail: string; normal: string };
  /** The exact call the server made, nested options and all. */
  call?: string;
  error?: string;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

// ── scene ──
const canvas = $<HTMLCanvasElement>("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const labels = new CSS2DRenderer();
Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
canvas.parentElement?.append(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9c6d2);
// One prefiltered room environment lights every PBR material (no IBL left the city modules dark);
// on top, Outcrop's page light: one shadowed sun tinted by the biome's environment row, and a low
// hemisphere fill so it does not double the environment.
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = roomEnvironment;
pmrem.dispose();
scene.fog = new THREE.Fog(0xffffff, 10, 100);
const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.35);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0003;
scene.add(sun, sun.target, hemi);
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x8a8a7c, roughness: 1 }),
);
ground.receiveShadow = true;
// Ground and grid sit below grade, as the Apex page puts its ground at -0.365: a module face at
// y = 0 (the rail module's paving) would z-fight a ground at y = 0 and flash while orbiting.
ground.position.y = -0.01;
const grid = new THREE.GridHelper(200, 200, 0x55606a, 0x77818a);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.35;
grid.position.y = -0.006;
const figure = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.22, 1.36, 6, 16).translate(0, 0.9, 0),
  new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 }),
);
figure.castShadow = true;
scene.add(ground, grid, figure);

const stylizedSky = makeStylizedSky();
stylizedSky.visible = false;
scene.add(stylizedSky);
const sharedStylizedMaterials = new Set(Object.values(stylizedMaterials));
type StylizedPreview = ReturnType<typeof createStylizedAsset>;
let scenePreview: StylizedPreview | undefined;

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
const content = new THREE.Group();
scene.add(content);

// ── wind: a GLB that carries a _WIND vec4 (x trunk, y branch, z flutter, w phase) sways ──
const wind = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(0.8, 0.6, 1) } };
function addWind(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 _wind;
uniform float uTime;
uniform vec3 uWind;
vec3 sway(vec3 p, vec3 n) {
  vec3 o = modelMatrix[3].xyz;
  vec3 wd = normalize(vec3(uWind.x, 0.0, uWind.y));
  float t = uTime, ph = o.x * 0.071 + o.z * 0.053;
  float gust = 0.55 + 0.45 * sin(t * 0.43) * sin(t * 0.17 + ph);
  float bp = _wind.w * 6.2832 + ph;
  vec3 d = wd * ((0.45 + sin(t * 0.9 + ph) * 0.6) * _wind.x * gust);
  d += (wd * (0.3 + sin(t * 1.9 + bp)) * 0.6 + vec3(0.0, sin(t * 2.7 + bp * 1.3) * 0.45, 0.0)) * (_wind.y * gust);
  float fp = dot(p, vec3(3.1, 2.3, 2.7)) + bp;
  d += (n * sin(t * 9.0 + fp * 3.0) + wd * (0.6 + sin(t * 2.4 + fp)) * 1.6) * (_wind.z * (0.4 + 0.6 * gust));
  return p + d * uWind.z;
}`,
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed = sway(transformed, objectNormal);",
      );
  };
  material.customProgramCacheKey = () => "asset-library-wind";
}

// ── state ──
/** `seed` is undefined until the user sets it, so each bake uses its own default seed. */
const state: { seed?: number; lod: number; wind: boolean; wire: boolean; background: number } = {
  lod: 0,
  wind: true,
  wire: false,
  background: 0,
};
const seedParam = (): [string, string][] =>
  state.seed === undefined ? [] : [["seed", String(state.seed)]];
/** Control values the user set, as URL strings; a control missing here is not sent, so the bake picks its default. */
const touched = new Map<string, string>();
const sky = { elevation: 42, azimuth: 35 };

/** The light of an Outcrop biome's `environment` row: sky, ground, sun colour and angle. */
function lightFor(outcropBiome?: string): void {
  // A rock story takes the page's own light (hemisphere 1.1, sun 3.2, exposure 1.05, no environment
  // map): the room environment on top of it washed every rock to near white beside the page.
  const rock = outcropBiome !== undefined;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  sun.shadow.normalBias = 0;
  camera.fov = 40;
  ground.visible = true;
  grid.visible = $("grid").getAttribute("aria-pressed") === "true";
  figure.visible = $("figure").getAttribute("aria-pressed") === "true";
  stylizedSky.visible = false;
  scene.environment = rock ? null : roomEnvironment;
  hemi.intensity = rock ? 1.1 : 0.35;
  sun.intensity = rock ? 3.2 : 3;
  renderer.toneMappingExposure = rock ? 1.05 : 1.1;
  const env = (Outcrop.BIOMES[outcropBiome ?? ""] ?? Outcrop.BIOMES.hills)?.environment as
    | Record<string, string | number>
    | undefined;
  if (!env) return;
  (scene.background as THREE.Color).set(env.skyHorizon as string);
  (scene.fog as THREE.Fog).color.set(env.skyHorizon as string);
  hemi.color.set(env.skyTop as string).lerp(new THREE.Color("#ffffff"), 0.55);
  hemi.groundColor.set(env.ground as string).multiplyScalar(0.7);
  sun.color.set(env.sun as string);
  (ground.material as THREE.MeshStandardMaterial).color.set(env.ground as string);
  sky.elevation = env.elevation as number;
  sky.azimuth = env.azimuth as number;
}

let catalog: { elements: IElement[]; biomes: IBiome[]; controls: Record<string, IControl[]> } = {
  elements: [],
  biomes: [],
  controls: {},
};
/** A story: a kind overview (optionally one category of it) or one element. */
let route: { kind: string; id?: string; category?: string; tiled?: string } = { kind: "" };
let token = 0;
const loader = new GLTFLoader();
const status = $("status");
const say = (text: string, error = false) => {
  status.textContent = text;
  status.toggleAttribute("data-error", error);
};

/** Every kind in the catalog, in the order its first element appears. */
const kinds = () => [...new Set(catalog.elements.map((e) => e.kind))];
/** The controls a kind shows; `only` ones show just for their element ids. */
const controlsFor = (kind: string, id?: string): IControl[] => {
  const element = catalog.elements.find((e) => e.kind === kind && e.id === id);
  const variants = element?.variants ?? 0;
  if (variants > 1) {
    return [
      {
        key: "variant",
        label: element?.variantNames ? "Theme" : "Variant",
        type: "select",
        options: Array.from({ length: variants }, (_, i) => String(i + 1)),
        labels: element?.variantNames,
        default: "1",
      },
    ];
  }
  return (catalog.controls[kind] ?? []).filter(
    (c) => !c.only || (id !== undefined && c.only.includes(id)),
  );
};
const paramsFor = (kind: string, id?: string) =>
  controlsFor(kind, id).flatMap((c) => {
    const value = touched.get(c.key);
    return value === undefined ? [] : [[c.key, value] as [string, string]];
  });

/** A tile index: an integer range limited to some elements that spans zero (a cliff's module along X). */
const tileControl = (kind: string, id?: string) =>
  controlsFor(kind, id).find(
    (c) => c.only && c.type === "range" && c.step === 1 && (c.min ?? 0) < 0 && (c.max ?? 0) > 0,
  );

async function bakeOf(element: IElement, lod = state.lod, extra: [string, string][] = []) {
  const q = new URLSearchParams([
    ["kind", element.kind],
    ["id", element.id],
    ...seedParam(),
    ["lod", String(lod)],
    ...paramsFor(element.kind, element.id),
  ]);
  for (const [key, value] of extra) q.set(key, value);
  const response = await fetch(`/api/bake?${q}`);
  const baked = (await response.json().catch(() => ({ error: response.statusText }))) as IBake;
  if (baked.error || !response.ok)
    throw new Error(baked.error ?? `bake failed: ${response.status}`);
  return baked as IBake;
}

// ── a bake with rock maps: Outcrop's own triplanar material over the maps the bake wrote ──
const bitmaps = new THREE.ImageBitmapLoader().setOptions({
  imageOrientation: "flipY",
  premultiplyAlpha: "none",
});
const maps = new Map<string, Promise<THREE.Texture>>();
function mapOf(url: string): Promise<THREE.Texture> {
  if (!maps.has(url))
    maps.set(
      url,
      bitmaps.loadAsync(url).then((image) => {
        const texture = new THREE.Texture(image as ImageBitmap);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.flipY = false;
        texture.anisotropy = 8;
        texture.needsUpdate = true;
        return texture;
      }),
    );
  return maps.get(url) as Promise<THREE.Texture>;
}

/** The look of Outcrop's page: `createRockMaterial`, reading the GLB's `_ROCK`, `_COVER` and `_WET`. */
async function rockMaterial(mesh: THREE.Mesh, baked: IBake): Promise<void> {
  if (!baked.rock || !baked.rockMaps) return;
  const [detail, normal] = await Promise.all([
    mapOf(baked.rockMaps.detail),
    mapOf(baked.rockMaps.normal),
  ]);
  const geometry = mesh.geometry;
  for (const [from, to] of [
    ["_rock", "aRock"],
    ["_cover", "aCover"],
    ["_wet", "aWet"],
  ] as const) {
    const attribute = geometry.getAttribute(from);
    if (attribute) geometry.setAttribute(to, attribute);
  }
  (mesh.material as THREE.Material).dispose();
  mesh.material = Outcrop.createRockMaterial({
    textures: { detail, normal },
    tile: baked.rock.tile,
  });
  (mesh.material as THREE.MeshStandardMaterial).wireframe = state.wire;
}

/** The baked GLB as a scene, with shadows, the wind patch and the wireframe toggle applied. */
async function modelOf(baked: IBake): Promise<{ model: THREE.Object3D; windy: boolean }> {
  const gltf = await loader.loadAsync(baked.url);
  const meshes: THREE.Mesh[] = [];
  let windy = false;
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
    mesh.castShadow = mesh.receiveShadow = true;
    for (const material of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
      material.wireframe = state.wire;
      if (mesh.geometry.getAttribute("_wind")) addWind(material);
    }
    windy ||= Boolean(mesh.geometry.getAttribute("_wind"));
  });
  await Promise.all(meshes.map((mesh) => rockMaterial(mesh, baked)));
  return { model: gltf.scene, windy };
}

function disposeModel(root: THREE.Object3D): void {
  const geometry = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (node instanceof CSS2DObject) node.element.remove();
    const mesh = node as THREE.Mesh & THREE.Points & THREE.InstancedMesh;
    if (!mesh.isMesh && !mesh.isPoints) return;
    if (mesh.isInstancedMesh) mesh.dispose();
    geometry.add(mesh.geometry);
    for (const material of [mesh.material].flat()) {
      if (!sharedStylizedMaterials.has(material)) materials.add(material);
    }
  });
  for (const item of geometry) item.dispose();
  for (const item of materials as Set<THREE.MeshStandardMaterial>) {
    item.map?.dispose();
    item.normalMap?.dispose();
    item.dispose();
  }
}

function clear(): void {
  for (const child of [...content.children]) {
    content.remove(child);
    disposeModel(child);
  }
}

function stylizedLighting(preview?: StylizedPreview): void {
  const env = preview?.env;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  const studio = route.kind === "dungeon" && !preview?.view;
  scene.environment = studio ? roomEnvironment : null;
  hemi.color.set(env?.hemi.sky ?? 0xd6e4ff);
  hemi.groundColor.set(env?.hemi.ground ?? 0x7f93c4);
  hemi.intensity = env?.hemi.intensity ?? (studio ? 1.12 : 1.9);
  sun.color.set(env?.sun.color ?? (studio ? 0xffedda : 0xfff3dc));
  sun.intensity = env?.sun.intensity ?? 3;
  sky.elevation = 49;
  sky.azimuth = -54;
  (scene.background as THREE.Color).set(env?.horizon ?? 0xb7c6e6);
  (scene.fog as THREE.Fog).color.set(env?.horizon ?? 0xb7c6e6);
  if (preview?.view) ground.visible = grid.visible = figure.visible = false;
  if (!env) return;
  stylizedSky.visible = true;
  stylizedSky.material.uniforms.uTop?.value.set(env.skyTop);
  stylizedSky.material.uniforms.uHorizon?.value.set(env.horizon);
  (scene.fog as THREE.Fog).near = env.fog[1];
  (scene.fog as THREE.Fog).far = env.fog[2];
  sun.target.position.set(0, 0, 0);
  sun.position
    .set(...env.sun.dir)
    .normalize()
    .multiplyScalar(env.shadow * 3);
  const shadow = sun.shadow.camera;
  shadow.left = shadow.bottom = -env.shadow;
  shadow.right = shadow.top = env.shadow;
  shadow.near = 1;
  shadow.far = env.shadow * 6;
  shadow.updateProjectionMatrix();
  sun.shadow.normalBias = Math.max(0.02, env.shadow * 0.0012);
}

/** The canvas renders on demand: after a change, while the camera moves, or while a _WIND model sways. */
let dirty = true;
let swaying = false;
const invalidate = () => {
  dirty = true;
};

function frame(): void {
  invalidate();
  if (scenePreview?.view) {
    camera.fov = 42;
    camera.near = 0.5;
    camera.far = 2500;
    orbit.target.set(...scenePreview.view.target);
    camera.position
      .set(...scenePreview.view.pos)
      .sub(orbit.target)
      .multiplyScalar(Math.max(1, 1.2 / camera.aspect))
      .add(orbit.target);
    camera.updateProjectionMatrix();
    return;
  }
  const box = new THREE.Box3().setFromObject(content);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(halfFov) * camera.aspect);
  const fit = sphere.radius / Math.sin(Math.min(halfFov, horizontal));
  orbit.target.copy(sphere.center);
  camera.position
    .copy(sphere.center)
    .add(new THREE.Vector3(0.55, 0.32, 1).normalize().multiplyScalar(fit));
  camera.near = fit / 200;
  camera.far = fit * 20;
  camera.updateProjectionMatrix();
  const elevation = THREE.MathUtils.degToRad(sky.elevation);
  const azimuth = THREE.MathUtils.degToRad(sky.azimuth);
  const d = sphere.radius * 3 + 4;
  sun.position
    .copy(sphere.center)
    .add(
      new THREE.Vector3(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.cos(azimuth) * Math.cos(elevation),
      ).multiplyScalar(d),
    );
  (scene.fog as THREE.Fog).near = fit * 1.5;
  (scene.fog as THREE.Fog).far = fit * 6;
  sun.target.position.copy(sphere.center);
  const s = sun.shadow.camera as THREE.OrthographicCamera;
  s.left = s.bottom = -sphere.radius * 1.4;
  s.right = s.top = sphere.radius * 1.4;
  s.near = 0.5;
  s.far = sphere.radius * 8 + 20;
  s.updateProjectionMatrix();
}

// ── icons: 24-unit stroke paths ──
const ICONS: Record<string, string> = {
  logo: "M12 2l9 5v10l-9 5-9-5V7zM12 22V12M21 7l-9 5-9-5",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  filter: "M4 6h16M7 12h10M10 18h4",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6",
  reload: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  zoomIn: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6",
  zoomOut: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6",
  reset: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  grid: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  figure: "M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 7v8M7 10h10M12 15l-3 6M12 15l3 6",
  wire: "M12 2l9 5v10l-9 5-9-5V7zM12 22V12M21 7l-9 5-9-5M3 17l9-5 9 5",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8",
  background: "M3 3h18v18H3zM8.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM21 15l-5-5L5 21",
  panel: "M3 3h18v18H3zM3 15h18",
  panelRight: "M3 3h18v18H3zM15 3v18",
  panelBottom: "M3 3h18v18H3zM3 15h18",
  fullscreen: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5",
  external: "M14 3h7v7M21 3l-9 9M19 14v7H3V5h7",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  chevron: "M6 9l6 6 6-6",
  doc: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8",
  story: "M6 3h12v18l-6-5-6 5z",
  group: "M3 3h18v18H3zM12 3v18M3 12h18",
};
const svg = (name: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ""}"/></svg>`;
const iconEl = (name: string, className = "", size = 14) => {
  const span = el("span", `inline-flex shrink-0 ${className}`);
  span.innerHTML = svg(name, size);
  return span;
};

// ── stats and docs ──
const size = (b: IBake["bounds"]) => b.max.map((v, i) => (v - (b.min[i] ?? 0)).toFixed(2));

/** The catalog's bake call with the seed, the LOD and every touched control written in, `out` last. */
function callFor(e: IElement): string {
  const [, fn = "bake", body = ""] = /^(\w+)\(\{(.*)\}\)$/s.exec(e.bake?.trim() ?? "") ?? [];
  const args = new Map(
    [...body.matchAll(/(\w+):\s*("[^"]*"|[^,]+?)\s*(?=,|$)/g)].map((m) => [m[1], m[2]]),
  );
  const out = args.get("out");
  args.delete("out");
  if (state.seed !== undefined) args.set("seed", String(state.seed));
  if (e.kind !== "city") args.set("lods", `[${state.lod}]`);
  for (const c of controlsFor(e.kind, e.id)) {
    const value = touched.get(c.key);
    if (value !== undefined)
      args.set(c.key, c.type === "range" || c.type === "toggle" ? value : JSON.stringify(value));
  }
  if (out) args.set("out", out);
  return `${fn}({ ${[...args].map(([k, v]) => `${k}: ${v}`).join(", ")} })`;
}

function rowsInto(dl: HTMLElement, rows: [string, string][]): HTMLElement {
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", "", k), el("dd", "break-words", v)]));
  return dl;
}

function attributesOf(model: THREE.Object3D): string {
  const rows: string[] = [];
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh)
      rows.push(
        `${(mesh.material as THREE.Material).name || "material"}: ${Object.keys(mesh.geometry.attributes).join(", ")}`,
      );
  });
  return rows.join("\n");
}

const PRE =
  "whitespace-pre-wrap break-all rounded border border-line bg-sidebar p-3 font-mono text-xs text-ink";
const DL = "grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 [&_dt]:font-bold [&_dt]:text-muted";

type PreviewReport = Pick<IBake, "triangles" | "bounds" | "ms" | "call"> &
  Partial<Pick<IBake, "lod" | "path">>;

function renderDocs(element: IElement, baked: PreviewReport, model: THREE.Object3D): void {
  const [w, h, d] = size(baked.bounds);
  const file = baked.path?.split("/").pop();
  const runtime = isRuntimeKind(element.kind);
  rowsInto($("stat-rows"), [
    ["Triangles", baked.triangles.toLocaleString()],
    ["Size (m)", `${w} × ${h} × ${d}`],
    ...(baked.lod === undefined
      ? []
      : [["Level of detail", String(baked.lod)] as [string, string]]),
    [runtime ? "Generate" : "Bake", `${baked.ms} ms`],
    ...(file ? [["File", file] as [string, string]] : []),
  ]);
  const head = el("div");
  head.append(el("h2", "text-xl font-extrabold text-white", element.name));
  if (element.latin) head.append(el("p", "italic text-muted", element.latin));
  const dl = rowsInto(el("dl", DL), [
    ["Id", element.id],
    ["Kind", title(element.kind)],
    ...(element.category ? [["Category", element.category] as [string, string]] : []),
    ["Biomes", element.biomes.join(", ") || "none listed"],
    ...(file ? [["File", file] as [string, string]] : []),
  ]);
  const call = baked.call ?? `await ${callFor(element)};`;
  const copy = el(
    "button",
    "tool w-auto justify-self-start px-2 text-ink",
    runtime ? "Copy code" : "Copy bake call",
  );
  copy.onclick = () => navigator.clipboard?.writeText(call).then(() => say("Code copied"));
  const parts = el(
    "label",
    "grid gap-1 font-bold text-muted",
    runtime ? "Mesh attributes" : "GLB primitives and attributes",
  );
  parts.append(el("pre", PRE, attributesOf(model)));
  $("docs").replaceChildren(head, dl, el("pre", PRE, call), copy, parts);
}

// ── background: the biome sky, or a flat dark or light backdrop ──
const BACKGROUNDS: { name: string; color?: string; floor?: string }[] = [
  { name: "studio", color: "#30353a", floor: "#3b4146" },
  { name: "biome sky" },
  { name: "light", color: "#e9ecef", floor: "#d5d9dd" },
];
function applyBackground(): void {
  const { name, color, floor } = BACKGROUNDS[state.background] ?? { name: "biome sky" };
  if (color) {
    (scene.background as THREE.Color).set(color);
    (scene.fog as THREE.Fog).color.set(color);
    (ground.material as THREE.MeshStandardMaterial).color.set(floor ?? color);
  }
  $("background").title = `Background: ${name}`;
  $("background").setAttribute("aria-label", `Background: ${name}`);
}

// ── stories ──
/** The tiled story: the tile index at -1, 0 and 1, each placed one width (of tile 0) over. */
async function tiled(mine: number, element: IElement, key: string): Promise<boolean | undefined> {
  say(`Baking ${element.name} ×3`);
  const bakes = await Promise.all(
    [-1, 0, 1].map((n) => bakeOf(element, state.lod, [[key, String(n)]])),
  );
  const width = (bakes[1]?.bounds.max[0] ?? 0) - (bakes[1]?.bounds.min[0] ?? 0);
  let windy = false;
  for (const [i, baked] of bakes.entries()) {
    const { model, windy: sways } = await modelOf(baked);
    if (mine !== token) return undefined;
    windy ||= sways;
    model.position.x = (i - 1) * width;
    content.add(model);
    if (i === 1) renderDocs(element, baked, model);
  }
  figure.position.set(width * 1.5 + 0.8, 0, 0);
  say(`${element.name} · ${key} -1, 0, 1 · ${width.toFixed(1)} m apart`);
  return windy;
}

function stylizedOf(element: IElement) {
  const start = performance.now();
  const variant = touched.get("variant");
  const options = {
    ...(variant === undefined ? {} : { variant: Number(variant) - 1 }),
    ...(state.seed === undefined ? {} : { seed: state.seed }),
  };
  const preview = createStylizedAsset(element.id, options);
  const { group: model, animated: windy } = preview;
  const args = [JSON.stringify(element.id)];
  if (Object.keys(options).length) args.push(JSON.stringify(options));
  const imports = preview.update ? "createStylizedAsset, stylizedUniforms" : "createStylizedAsset";
  const call = `import { ${imports} } from "@threenative/procedural-environment/stylized";

const { group${preview.update ? ", update" : ""} } = createStylizedAsset(${args.join(", ")});${preview.update ? "\n\n// In your animation loop, using elapsed time in seconds:\nstylizedUniforms.uTime.value = elapsedSeconds;\nupdate?.(elapsedSeconds);" : ""}`;
  const bounds = new THREE.Box3().setFromObject(model);
  let triangles = 0;
  model.traverse((node) => {
    const mesh = node as THREE.Mesh & THREE.InstancedMesh;
    if (!mesh.isMesh) return;
    for (const material of [mesh.material].flat() as THREE.MeshStandardMaterial[])
      material.wireframe = state.wire;
    triangles +=
      ((mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3) *
      (mesh.isInstancedMesh ? mesh.count : 1);
  });
  if (triangles === 0) throw new Error(`No triangles in ${element.name}`);
  return {
    model,
    windy,
    preview,
    baked: {
      bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
      triangles: Math.round(triangles),
      ms: Math.round(performance.now() - start),
      call,
    },
  };
}

async function assetOf(element: IElement, lod = state.lod) {
  if (isRuntimeKind(element.kind)) return stylizedOf(element);
  const baked = await bakeOf(element, lod);
  return { ...(await modelOf(baked)), baked, preview: undefined };
}

/** The overview story: every visible element of the kind (or category) on one line, at its true size. */
async function overview(mine: number, kindRows: IElement[]): Promise<boolean | undefined> {
  let x = 0;
  let windy = false;
  const shown = kindRows.filter(
    (e) => visible(e) && (!route.category || e.category === route.category),
  );
  const name = [kindName(route.kind), route.category].filter(Boolean).join(" · ");
  rowsInto($("stat-rows"), [["Shown", `${shown.length} of ${kindRows.length}`]]);
  const list = el("ul", "grid gap-1");
  for (const e of shown) {
    const a = el("a", "text-accent hover:underline", e.name);
    a.href = hashOf(e.kind, e.id);
    const li = el("li");
    li.append(a, el("span", "text-muted", ` ${e.id}`));
    list.append(li);
  }
  $("docs").replaceChildren(
    el("h2", "text-xl font-extrabold text-white", name),
    el("p", "text-muted", `${shown.length} elements. Pick one for its preview and source call.`),
    list,
  );
  const lineup = shown.filter((row) => !isRuntimeKind(row.kind) || !isBackdrop(row));
  const openingScene = lineup.length === 0 ? shown[0] : undefined;
  if (openingScene) {
    const { model, windy: animates, preview } = stylizedOf(openingScene);
    scenePreview = preview;
    stylizedLighting(preview);
    content.add(model);
    say(name);
    return animates;
  }
  for (const [i, row] of lineup.entries()) {
    say(`Loading ${name} ${i + 1} of ${lineup.length}`);
    const { baked, model, windy: sways } = await assetOf(row, Math.max(state.lod, 1));
    if (mine !== token) {
      disposeModel(model);
      return undefined;
    }
    windy ||= sways;
    $("wind").hidden = !windy;
    const [minX = 0, , minZ = 0] = baked.bounds.min;
    const [maxX = 0, , maxZ = 0] = baked.bounds.max;
    model.position.set(x - minX, 0, -(minZ + maxZ) / 2);
    const tag = el("div", "rounded-sm bg-black/60 px-1 text-[11px] text-white", row.name);
    const label = new CSS2DObject(tag);
    label.position.set(x + (maxX - minX) / 2, 0, (maxZ - minZ) / 2 + 0.6);
    content.add(model, label);
    x += maxX - minX + Math.max(0.4, (maxX - minX) * 0.25);
    frame();
  }
  figure.position.set(-1, 0, 0);
  say(`${name} · ${shown.length} elements`);
  return windy;
}

/** One element, as baked with the current seed, LOD and controls. */
async function single(mine: number, element: IElement): Promise<boolean | undefined> {
  say(`Loading ${element.name}`);
  const { baked, model, windy, preview } = await assetOf(element);
  if (mine !== token) {
    disposeModel(model);
    return undefined;
  }
  scenePreview = preview;
  if (preview) {
    stylizedLighting(preview);
    if (!preview.view) applyBackground();
  }
  content.add(model);
  figure.position.set((baked.bounds.max[0] ?? 0) + 0.8, 0, 0);
  renderDocs(element, baked, model);
  const lod = "lod" in baked ? ` · lod ${baked.lod}` : "";
  say(`${element.name}${lod} · ${baked.triangles.toLocaleString()} triangles`);
  return windy;
}

async function show(): Promise<void> {
  const mine = ++token;
  clear();
  scenePreview = undefined;
  invalidate();
  const kindRows = catalog.elements.filter((e) => e.kind === route.kind);
  const element = kindRows.find((e) => e.id === route.id);
  const biome =
    touched.get("biome") ?? controlsFor(route.kind).find((c) => c.key === "biome")?.default;
  lightFor(
    biome === undefined
      ? undefined
      : (catalog.biomes.find((b) => b.id === biome)?.rock ?? String(biome)),
  );
  if (isRuntimeKind(route.kind)) stylizedLighting();
  applyBackground();
  let windy: boolean | undefined = false;
  try {
    if (element && route.tiled) windy = await tiled(mine, element, route.tiled);
    else if (element) windy = await single(mine, element);
    else windy = await overview(mine, kindRows);
    if (windy === undefined) return;
    frame();
  } catch (error) {
    if (mine === token) say((error as Error).message, true);
  }
  if (mine !== token) return;
  $("wind").hidden = !windy;
  $("wind").title = isRuntimeKind(route.kind) ? "Animate the scene" : "Animate the _WIND attribute";
  $("wind").setAttribute("aria-label", $("wind").title);
  swaying = Boolean(windy);
  invalidate();
}

// ── sidebar ──
function visible(e: IElement): boolean {
  const words = $<HTMLInputElement>("search").value.toLowerCase().split(/\s+/).filter(Boolean);
  const biome = $<HTMLSelectElement>("biome").value;
  const text =
    `${e.id} ${e.name} ${e.latin ?? ""} ${e.kind} ${e.category ?? ""} ${e.biomes.join(" ")}`.toLowerCase();
  return (!biome || e.biomes.includes(biome)) && words.every((w) => text.includes(w));
}

function hashOf(kind: string, id?: string, category?: string, extra: [string, string][] = []) {
  const q = new URLSearchParams([
    ...seedParam(),
    ["lod", String(state.lod)],
    ...(category && !id ? [["category", category] as [string, string]] : []),
    ...paramsFor(kind, id),
  ]);
  for (const [key, value] of extra) q.set(key, value);
  return `#/${kind}${id ? `/${id}` : ""}?${q}`;
}

/** Folder open state the user chose, so a re-render (search, route) keeps it. */
const folded = new Map<string, boolean>();
function folder(key: string, open: boolean, summary: HTMLElement): HTMLDetailsElement {
  const details = el("details");
  details.open = folded.get(key) ?? open;
  details.ontoggle = () => folded.set(key, details.open);
  details.append(summary);
  return details;
}

function leaf(
  href: string,
  text: string,
  kind: "doc" | "story",
  current: boolean,
  indent: string,
  opens: Tab,
) {
  const a = el(
    "a",
    `group flex items-center gap-2 rounded py-1 pr-2 ${indent} text-ink hover:bg-hover aria-[current=page]:bg-accent aria-[current=page]:font-bold aria-[current=page]:text-accent-ink`,
  );
  a.href = href;
  a.append(
    iconEl(
      kind,
      `${kind === "doc" ? "text-doc" : "text-story"} group-aria-[current=page]:text-white`,
    ),
    el("span", "truncate", text),
  );
  if (current) a.setAttribute("aria-current", "page");
  a.addEventListener("click", () => {
    setTab(opens);
    sidebar(false);
  });
  return a;
}

/** A tree node: a collapsible row with the group icon whose children are docs and stories. */
function node(key: string, label: string, open: boolean, indent: string) {
  const summary = el(
    "summary",
    `flex items-center gap-1.5 rounded py-1 pr-2 ${indent} text-ink hover:bg-hover`,
  );
  summary.append(
    iconEl("chevron", "chev text-muted transition-transform", 12),
    iconEl("group", "text-group"),
    el("span", "truncate", label),
  );
  return folder(key, open, summary);
}

const here = (kind: string, id?: string, category?: string) =>
  route.kind === kind && route.id === id && route.category === category;

/** A category node: its docs, its overview and one story per element. */
function categoryNode(kind: string, category: string, members: IElement[], open: boolean) {
  const docs = tab === "docs";
  const group = node(`${kind}/${category}`, category, open, "pl-1");
  const at = hashOf(kind, undefined, category);
  const current = here(kind, undefined, category);
  group.append(
    leaf(at, "Docs", "doc", current && docs, "pl-10", "docs"),
    leaf(at, "Overview", "story", current && !docs, "pl-10", "controls"),
    ...members.map((e) =>
      leaf(hashOf(kind, e.id), e.name, "story", here(kind, e.id) && !docs, "pl-10", "controls"),
    ),
  );
  return group;
}

/** An element node: its docs and its default story. */
/** An element node: its docs, its default story, a story per biome option and a tiled story. */
function elementNode(e: IElement) {
  const docs = tab === "docs";
  const current = here(e.kind, e.id);
  const story = current && !docs && !route.tiled;
  const group = node(`${e.kind}/${e.id}`, e.name, current, "pl-1");
  const at = hashOf(e.kind, e.id);
  const biome = controlsFor(e.kind, e.id).find((c) => c.key === "biome" && c.type === "select");
  const tile = tileControl(e.kind, e.id);
  group.append(
    leaf(at, "Docs", "doc", current && docs, "pl-10", "docs"),
    leaf(at, "Default", "story", story && !touched.has("biome"), "pl-10", "controls"),
    ...(biome?.options ?? []).map((o) =>
      leaf(
        hashOf(e.kind, e.id, undefined, [["biome", o]]),
        optionName(o),
        "story",
        story && touched.get("biome") === o,
        "pl-10",
        "controls",
      ),
    ),
  );
  if (tile)
    group.append(
      leaf(
        hashOf(e.kind, e.id, undefined, [["tiled", tile.key]]),
        `Tiled ×3 (${tile.label})`,
        "story",
        current && !docs && route.tiled === tile.key,
        "pl-10",
        "controls",
      ),
    );
  return group;
}

/** One kind: an uppercase section with its overview, then a node per category or per element. */
const isBackdrop = (row: IElement) => row.category === "Scenes" || row.id === "sky-dome";
const kindName = (kind: string) => (kind === "stylized" ? "Stylized Biome Kit" : title(kind));
const isRuntimeKind = (kind: string) => kind === "stylized" || kind === "dungeon";
const hasLod = (kind: string) => kind !== "city" && !isRuntimeKind(kind);

function kindSection(kind: string, rows: IElement[], searching: boolean) {
  const summary = el(
    "summary",
    "mt-3 flex items-center gap-1.5 py-1 pl-1 text-[11px] font-extrabold uppercase tracking-[0.2em] text-muted hover:text-ink",
  );
  summary.append(
    iconEl("chevron", "chev transition-transform", 12),
    el("span", "flex-1", kindName(kind)),
    el("span", "font-normal tracking-normal", String(rows.length)),
  );
  const section = folder(kind, true, summary);
  section.append(
    leaf(hashOf(kind), "Overview", "story", here(kind) && tab !== "docs", "pl-5", "controls"),
  );
  for (const category of [...new Set(rows.map((e) => e.category ?? ""))]) {
    const members = rows.filter((e) => (e.category ?? "") === category);
    if (!category) {
      section.append(...members.map(elementNode));
      continue;
    }
    const open =
      searching ||
      (route.kind === kind &&
        (route.category === category || members.some((e) => e.id === route.id)));
    section.append(categoryNode(kind, category, members, open));
  }
  return section;
}

function renderTree(): void {
  const searching = $<HTMLInputElement>("search").value.trim() !== "";
  const nav = $("tree");
  nav.replaceChildren();
  for (const kind of kinds()) {
    const rows = catalog.elements.filter((e) => e.kind === kind && visible(e));
    if (rows.length) nav.append(kindSection(kind, rows, searching));
  }
  nav.querySelector("[aria-current=page]")?.scrollIntoView({ block: "center" });
}

// ── addon panel ──
type Tab = "controls" | "docs" | "stats";
let tab: Tab = "controls";
function setTab(next: Tab): void {
  tab = next;
  for (const name of ["controls", "docs", "stats"] as const) {
    $(`tab-${name}`).setAttribute("aria-selected", String(name === next));
    $(name).hidden = name !== next;
  }
  renderTree();
}

type Dock = "bottom" | "right" | "hidden";
let dock: Dock = "bottom";
let lastDock: Exclude<Dock, "hidden"> = "bottom";
function setDock(next: Dock): void {
  dock = next;
  if (next !== "hidden") lastDock = next;
  $("panel").hidden = next === "hidden";
  $("workspace").toggleAttribute("data-right", next === "right");
  $("toggle-panel").setAttribute("aria-pressed", String(next !== "hidden"));
  const side = $("panel-side");
  side.innerHTML = svg(next === "right" ? "panelBottom" : "panelRight");
  side.title = next === "right" ? "Move the panel to the bottom" : "Move the panel to the right";
  side.setAttribute("aria-label", side.title);
}

// ── controls: whatever the catalog lists for the kind, plus seed and LOD ──
function commit(key: string, value: string): void {
  touched.set(key, value);
  go();
}

/** A pill of buttons, one per option, the shape of Storybook's boolean and inline-radio controls. */
function segmented(
  label: string,
  options: [string, string][],
  current: string,
  pick: (v: string) => void,
) {
  const box = el("div", "inline-flex flex-wrap rounded-full bg-sidebar p-0.5");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", label);
  for (const [value, text] of options) {
    const b = el(
      "button",
      "cursor-pointer rounded-full px-3 py-1 text-muted hover:text-ink aria-pressed:bg-raised aria-pressed:font-bold aria-pressed:text-white",
      text,
    );
    b.setAttribute("aria-pressed", String(value === current));
    b.onclick = () => pick(value);
    box.append(b);
  }
  return box;
}

const optionName = (option: string) => catalog.biomes.find((b) => b.id === option)?.name ?? option;

function selectWidget(c: IControl, value: string | undefined, set: (v: string) => void) {
  const select = el("select", "field");
  select.setAttribute("aria-label", c.label);
  select.name = c.key;
  for (const [i, option] of (c.options ?? []).entries()) {
    const o = el("option", "", c.labels?.[i] ?? optionName(option));
    o.value = option;
    select.append(o);
  }
  if (value !== undefined) select.value = value;
  select.onchange = () => set(select.value);
  return select;
}

function widget(c: IControl): HTMLElement {
  const value = touched.get(c.key) ?? (c.default === undefined ? undefined : String(c.default));
  const set = (v: string) => commit(c.key, v);
  if (c.type === "toggle")
    return segmented(
      c.label,
      [
        ["false", "False"],
        ["true", "True"],
      ],
      value ?? "",
      set,
    );
  if (c.type === "select" && (c.options?.length ?? 0) <= 4)
    return segmented(
      c.label,
      (c.options ?? []).map((o, i) => [o, c.labels?.[i] ?? optionName(o)]),
      value ?? "",
      set,
    );
  if (c.type === "select") return selectWidget(c, value, set);
  if (c.type === "text") {
    const text = el("input", "field");
    text.setAttribute("aria-label", c.label);
    text.name = c.key;
    text.value = value ?? "";
    text.onchange = () => set(text.value);
    return text;
  }
  return rangeWidget(c, value, set);
}

function rangeWidget(c: IControl, value: string | undefined, set: (v: string) => void) {
  const row = el("div", "flex items-center gap-3");
  const slider = el("input", "min-w-0 flex-1 accent-accent");
  const number = el("input", "field w-20 tabular-nums");
  for (const [field, type] of [
    [slider, "range"],
    [number, "number"],
  ] as const) {
    field.type = type;
    field.name = type === "range" ? c.key : `${c.key}-value`;
    field.min = String(c.min ?? 0);
    field.max = String(c.max ?? 1);
    field.step = String(c.step ?? "any");
    // Unset with no default: the bake decides (a rock trait follows its biome), so show "auto".
    if (value !== undefined) field.value = value;
    else if (type === "range") field.value = String(((c.min ?? 0) + (c.max ?? 1)) / 2);
    field.setAttribute("aria-label", type === "range" ? c.label : `${c.label} value`);
    field.onchange = () => set(field.value);
  }
  number.placeholder = "auto";
  slider.classList.toggle("opacity-40", value === undefined);
  slider.oninput = () => {
    number.value = slider.value;
  };
  row.append(slider, number);
  return row;
}

function controlRow(
  label: string,
  control: HTMLElement,
  reset?: () => void,
  note = "",
): HTMLElement {
  const tr = el("tr", "border-b border-line align-middle");
  const name = el("td", "px-4 py-2.5");
  name.append(el("div", "font-bold text-white", label));
  if (note) name.append(el("div", "text-xs text-muted", note));
  const cell = el("td", "px-4 py-2");
  cell.append(control);
  const end = el("td", "pr-3 text-right");
  if (reset) {
    const b = el("button", "tool");
    b.innerHTML = svg("undo", 14);
    b.title = `Reset ${label} to the bake's default`;
    b.setAttribute("aria-label", b.title);
    b.onclick = reset;
    end.append(b);
  }
  tr.append(name, cell, end);
  return tr;
}

function renderControls(): void {
  const list = controlsFor(route.kind, route.id);
  const body = $("control-rows");
  const seed = el("input", "field w-28 tabular-nums");
  seed.type = "number";
  seed.step = "1";
  seed.value = state.seed === undefined ? "" : String(state.seed);
  seed.placeholder = "auto";
  seed.setAttribute("aria-label", "Seed");
  seed.name = "seed";
  seed.onchange = () => {
    const value = Number.parseInt(seed.value, 10);
    state.seed = Number.isInteger(value) ? value : undefined;
    go();
  };
  const lod = segmented(
    "Level of detail",
    [
      ["0", "0 near"],
      ["1", "1 mid"],
      ["2", "2 far"],
    ],
    String(state.lod),
    (v) => {
      state.lod = Number(v);
      go();
    },
  );
  const unseed =
    state.seed === undefined
      ? undefined
      : () => {
          state.seed = undefined;
          go();
        };
  body.replaceChildren(
    controlRow("seed", seed, unseed, unseed ? "" : "auto"),
    ...(hasLod(route.kind) ? [controlRow("lod", lod)] : []),
  );
  for (const group of [...new Set(list.map((c) => c.group ?? ""))]) {
    const rows = list
      .filter((c) => (c.group ?? "") === group)
      .map((c) =>
        controlRow(
          c.label,
          widget(c),
          touched.has(c.key)
            ? () => {
                touched.delete(c.key);
                go();
              }
            : undefined,
          touched.has(c.key) ? "" : c.default === undefined ? "auto" : "default",
        ),
      );
    if (group) {
      const key = `controls/${group}`;
      const open = folded.get(key) ?? true;
      const tr = el("tr", "border-b border-line bg-sidebar");
      const td = el("td");
      td.colSpan = 3;
      const b = el(
        "button",
        "flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-[11px] font-extrabold uppercase tracking-[0.2em] text-muted hover:text-ink",
      );
      b.setAttribute("aria-expanded", String(open));
      b.append(iconEl("chevron", open ? "" : "-rotate-90", 12), el("span", "", group));
      b.onclick = () => {
        folded.set(key, !open);
        renderControls();
      };
      td.append(b);
      tr.append(td);
      body.append(tr);
      if (!open) continue;
    }
    body.append(...rows);
  }
  $("control-count").textContent = String(list.length + (hasLod(route.kind) ? 2 : 1));
}

function readHash(): void {
  const [pathPart = "", query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [kind = "", id] = pathPart.split("/");
  const q = new URLSearchParams(query);
  const known = kinds();
  const category = id ? null : q.get("category");
  const routeKind = known.includes(kind) ? kind : (known[0] ?? "");
  const tiled = q.get("tiled");
  route = {
    kind: routeKind,
    ...(id ? { id } : {}),
    ...(category ? { category } : {}),
    ...(tiled && tileControl(routeKind, id)?.key === tiled ? { tiled } : {}),
  };
  const seed = Number.parseInt(q.get("seed") ?? "", 10);
  state.seed = Number.isInteger(seed) ? seed : undefined;
  state.lod = Math.min(2, Math.max(0, Number(q.get("lod") ?? 0) || 0));
  touched.clear();
  for (const c of controlsFor(route.kind, route.id)) {
    const value = q.get(c.key);
    if (value !== null) touched.set(c.key, value);
  }
  sidebar(false);
  renderTree();
  renderControls();
  void show();
}

function go(): void {
  const next = hashOf(
    route.kind,
    route.id,
    route.category,
    route.tiled ? [["tiled", route.tiled]] : [],
  );
  if (location.hash === next) readHash();
  else location.hash = next;
}

// ── wiring ──
for (const node of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  node.innerHTML = svg(node.dataset.icon ?? "");
  if (node instanceof HTMLButtonElement && !node.hasAttribute("aria-label"))
    node.setAttribute("aria-label", node.title);
}

/** At phone width the asset list is a drawer over the page; from md up it is always shown. */
function sidebar(open: boolean): void {
  $("sidebar").classList.toggle("hidden", !open);
  $("sidebar").classList.toggle("flex", open);
  if (open) $("tree").querySelector("[aria-current=page]")?.scrollIntoView({ block: "center" });
}
$("open-tree").onclick = () => sidebar(true);
$("close-tree").onclick = () => sidebar(false);
for (const id of ["settings", "filter"])
  $(id).onclick = () => {
    const open = $("filters").hidden;
    $("filters").hidden = !open;
    for (const b of ["settings", "filter"]) $(b).setAttribute("aria-pressed", String(open));
  };
$("search").addEventListener("input", renderTree);
$("biome").addEventListener("change", () => {
  renderTree();
  if (!route.id) void show();
});
document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (e.key !== "/" || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  e.preventDefault();
  $("search").focus();
});

const toggle = (id: string, apply: (on: boolean) => void) => {
  const b = $(id);
  b.onclick = () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    apply(on);
  };
};
toggle("wind", (on) => {
  state.wind = on;
});
toggle("wire", (on) => {
  state.wire = on;
  content.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (mesh.isMesh)
      for (const material of [mesh.material].flat() as THREE.MeshStandardMaterial[])
        material.wireframe = on;
  });
});
toggle("figure", (on) => {
  figure.visible = on && !scenePreview?.view;
});
toggle("grid", (on) => {
  grid.visible = on && !scenePreview?.view;
});
const dolly = (factor: number) =>
  camera.position.sub(orbit.target).multiplyScalar(factor).add(orbit.target);
$("rebake").onclick = () => void show();
$("zoom-in").onclick = () => dolly(0.8);
$("zoom-out").onclick = () => dolly(1.25);
$("frame").onclick = frame;
$("background").onclick = () => {
  state.background = (state.background + 1) % BACKGROUNDS.length;
  void show();
};
$("toggle-panel").onclick = () => setDock(dock === "hidden" ? lastDock : "hidden");
$("panel-side").onclick = () => setDock(dock === "right" ? "bottom" : "right");
$("panel-close").onclick = () => setDock("hidden");
$("fullscreen").onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : $("stage").requestFullscreen();
$("new-tab").onclick = () => window.open(location.href, "_blank", "noopener");
$("copy-link").onclick = () =>
  navigator.clipboard?.writeText(location.href).then(() => say("Link copied"));
for (const name of ["controls", "docs", "stats"] as const)
  $(`tab-${name}`).onclick = () => setTab(name);
$("reset-all").onclick = () => {
  touched.clear();
  state.seed = undefined;
  go();
};
window.addEventListener("hashchange", readHash);
setDock("bottom");

// ── loop ──
let last = performance.now();
function resize(): void {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (
    canvas.width !== Math.floor(w * renderer.getPixelRatio()) ||
    canvas.height !== Math.floor(h * renderer.getPixelRatio())
  ) {
    renderer.setSize(w, h, false);
    invalidate();
    labels.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
}
renderer.setAnimationLoop(() => {
  resize();
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  const moved = orbit.update();
  const animate = swaying && state.wind;
  if (animate && isRuntimeKind(route.kind)) {
    stylizedUniforms.uTime.value += Math.min(dt, 0.1);
    scenePreview?.update?.(stylizedUniforms.uTime.value);
  } else if (animate) wind.uTime.value += dt;
  if (!(moved || dirty || animate)) return;
  dirty = false;
  renderer.render(scene, camera);
  labels.render(scene, camera);
});
for (const type of ["click", "change", "input"]) document.addEventListener(type, invalidate);

try {
  catalog = (await (await fetch("/api/catalog")).json()) as typeof catalog;
  for (const biome of catalog.biomes) {
    const option = el("option", "", biome.name);
    option.value = biome.id;
    $("biome").append(option);
  }
  readHash();
} catch (error) {
  say(`Catalog failed: ${(error as Error).message}`, true);
}
