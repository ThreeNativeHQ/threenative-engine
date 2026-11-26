// The Asset Library shell (PRD-915): a Storybook-shaped workbench every consumer mounts — the
// engine's `pnpm asset-library` and every kit's `/__assets/`. It knows no source: the catalog says
// what to list, a source's server route bakes, and a source's client builds or dresses.
import * as three from "three";
import "./style.css";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type {
  IAssetBake,
  IAssetCatalog,
  IAssetControl,
  IAssetElement,
  IAssetLibraryClient,
  IAssetLoaded,
  IAssetReport,
  IAssetViewContext,
} from "../types.js";
import { BUILT_IN_KINDS, builtInView, createViewerHost, fileUrl } from "./viewers.js";

export interface IShellConfig {
  /** Where the library is mounted, with a trailing slash (`/__assets/`, `/`). */
  readonly base: string;
  readonly title: string;
  readonly clients: Readonly<Record<string, IAssetLibraryClient>>;
}

const config = (Reflect.get(globalThis, "__TN_ASSET_LIBRARY__") as IShellConfig | undefined) ?? {
  base: "/",
  title: "Asset Library",
  clients: {},
};
const API = `${config.base}api/`;
const query = new URLSearchParams(location.search);
/** `?embed=1`: a host (Studio) frames the stage alone and drives it by postMessage. */
const embed = query.get("embed") === "1";
/** `?sheet=turntable`: one labelled multi-angle contact sheet, then `__TN_ASSET_LIBRARY_READY__`. */
const sheetMode = query.get("sheet");

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
document.title = config.title;
$("library-title").textContent = config.title;
if (embed) document.documentElement.toggleAttribute("data-embed", true);

// ── scene ──
const canvas = $<HTMLCanvasElement>("view");
const renderer = new three.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = three.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = three.PCFShadowMap;
const labels = new CSS2DRenderer();
Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
canvas.parentElement?.append(labels.domElement);

const scene = new three.Scene();
const backgroundColor = new three.Color(0xb9c6d2);
scene.background = backgroundColor;
// One prefiltered room environment lights every PBR material; one shadowed sun and a low
// hemisphere fill on top, so a story with no light of its own still reads its materials.
const pmrem = new three.PMREMGenerator(renderer);
const roomEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = roomEnvironment;
pmrem.dispose();
scene.fog = new three.Fog(0xffffff, 10, 100);
const hemi = new three.HemisphereLight(0xffffff, 0x888888, 0.35);
const sun = new three.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0003;
scene.add(sun, sun.target, hemi);
const ground = new three.Mesh(
  new three.CircleGeometry(400, 64).rotateX(-Math.PI / 2),
  new three.MeshStandardMaterial({ color: 0x8a8a7c, roughness: 1 }),
);
ground.receiveShadow = true;
// Ground and grid sit below grade: a module face at y = 0 would z-fight them while orbiting.
ground.position.y = -0.01;
const grid = new three.GridHelper(200, 200, 0x55606a, 0x77818a);
(grid.material as three.Material).transparent = true;
(grid.material as three.Material).opacity = 0.35;
grid.position.y = -0.006;
scene.add(ground, grid);

const camera = new three.PerspectiveCamera(40, 1, 0.05, 2000);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
const content = new three.Group();
scene.add(content);

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

let catalog: Required<Pick<IAssetCatalog, "elements" | "styles">> & IAssetCatalog = {
  elements: [],
  styles: {},
};
const selectedStyles = new Set<string>();
const styleNames = (element: IAssetElement) =>
  element.styleTags.map((tag) => catalog.styles[tag] ?? tag);
const settingNames = (element: IAssetElement) =>
  element.settingTags?.map((tag) => catalog.settings?.[tag] ?? tag) ?? [];
const facetIds = ["setting", "category", "biome"] as const;
const facet = (id: (typeof facetIds)[number]) => $<HTMLSelectElement>(id).value;
/** A story: a kind overview (optionally one category of it) or one element. */
let route: { kind: string; id?: string; category?: string; tiled?: string } = { kind: "" };
let token = 0;
const loader = new GLTFLoader();
const status = $("status");
const say = (text: string, error = false) => {
  status.textContent = text;
  status.toggleAttribute("data-error", error);
};

const kindInfo = (kind: string) => catalog.kinds?.[kind] ?? {};
const isRuntimeKind = (kind: string) => kindInfo(kind).runtime === true;
const hasLod = (kind: string) => kindInfo(kind).lod === true;
const hasSeed = (kind: string) => kindInfo(kind).seed ?? !BUILT_IN_KINDS.has(kind);
const kindName = (kind: string) => kindInfo(kind).name ?? title(kind);
const packName = (kind: string) => kindInfo(kind).pack ?? kindName(kind);
const clientOf = (element?: IAssetElement): IAssetLibraryClient =>
  (element && config.clients[element.source]) ?? {};
/** The element the route names, or the first of its kind for an overview. */
const routeElement = () =>
  catalog.elements.find((e) => e.kind === route.kind && (route.id ? e.id === route.id : true));

/** Every kind in the catalog, in the order its first element appears. */
const kinds = () => [...new Set(catalog.elements.map((e) => e.kind))];
/** The controls a kind shows; `only` ones show just for their element ids. */
let storyControls: readonly IAssetControl[] | undefined;
const controlsFor = (kind: string, id?: string): readonly IAssetControl[] => {
  const element = catalog.elements.find((e) => e.kind === kind && e.id === id);
  if (kind === "story" && id) return storyControls ?? [];
  const variants = element?.variants ?? 0;
  if (variants > 1) {
    return [
      {
        key: "variant",
        label: element?.variantNames ? "Theme" : "Variant",
        type: "select",
        options: Array.from({ length: variants }, (_, i) => String(i + 1)),
        ...(element?.variantNames ? { labels: element.variantNames } : {}),
        default: "1",
      },
    ];
  }
  return (catalog.controls?.[kind] ?? []).filter(
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

async function bakeOf(element: IAssetElement, lod = state.lod, extra: [string, string][] = []) {
  const q = new URLSearchParams([
    ["kind", element.kind],
    ["id", element.id],
    ...seedParam(),
    ["lod", String(lod)],
    ...paramsFor(element.kind, element.id),
  ]);
  for (const [key, value] of extra) q.set(key, value);
  const response = await fetch(`${API}${element.source}/bake?${q}`);
  const baked = (await response.json().catch(() => ({ error: response.statusText }))) as IAssetBake;
  if (baked.error || !response.ok)
    throw new Error(baked.error ?? `bake failed: ${response.status}`);
  return baked;
}

/** The baked GLB as a scene, with shadows and the wireframe toggle, dressed by its source's client. */
async function modelOf(element: IAssetElement, baked: IAssetBake) {
  const gltf = await loader.loadAsync(baked.url);
  gltf.scene.traverse((node) => {
    const mesh = node as three.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = mesh.receiveShadow = true;
    for (const material of [mesh.material].flat() as three.MeshStandardMaterial[])
      material.wireframe = state.wire;
  });
  const windy = (await clientOf(element).dress?.(gltf.scene, baked, view)) ?? false;
  return { model: gltf.scene, windy };
}

function disposeModel(root: three.Object3D): void {
  const geometry = new Set<three.BufferGeometry>();
  const materials = new Set<three.Material>();
  const shared = (material: unknown) =>
    Object.values(config.clients).some((client) => client.shared?.(material));
  root.traverse((node) => {
    if (node instanceof CSS2DObject) node.element.remove();
    const mesh = node as three.Mesh & three.Points & three.InstancedMesh;
    if (!mesh.isMesh && !mesh.isPoints) return;
    if (mesh.isInstancedMesh) mesh.dispose();
    geometry.add(mesh.geometry);
    for (const material of [mesh.material].flat()) if (!shared(material)) materials.add(material);
  });
  for (const item of geometry) item.dispose();
  for (const item of materials as Set<three.MeshStandardMaterial>) {
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

/** Shadow map size and blur radius of the sun; a new size drops the old map. */
function sunShadow(size: number, radius: number): void {
  sun.shadow.radius = radius;
  if (sun.shadow.mapSize.x === size) return;
  sun.shadow.mapSize.set(size, size);
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
}

/** The canvas renders on demand: after a change, while the camera moves, or while a story animates. */
let dirty = true;
let swaying = false;
const invalidate = () => {
  dirty = true;
};

/** The view the current story asked for (a whole scene story), else undefined. */
let fixedView: IAssetLoaded["view"];

/** Where the framing camera sits from the subject. */
const VIEW_DIRECTION = new three.Vector3(0.55, 0.32, 1).normalize();

function frame(): void {
  invalidate();
  if (fixedView) {
    camera.fov = 42;
    camera.near = 0.5;
    camera.far = 2500;
    orbit.target.set(...fixedView.target);
    camera.position
      .set(...fixedView.pos)
      .sub(orbit.target)
      .multiplyScalar(Math.max(1, 1.2 / camera.aspect))
      .add(orbit.target);
    camera.updateProjectionMatrix();
    return;
  }
  const box = new three.Box3().setFromObject(content);
  // Nothing shown yet (the intro, an empty Stage): a raised view of the floor, not a camera left at
  // floor height that sees the ground as a flat band.
  if (box.isEmpty())
    box.setFromCenterAndSize(new three.Vector3(0, 0.9, 0), new three.Vector3(1, 1.8, 1));
  const sphere = box.getBoundingSphere(new three.Sphere());
  const halfFov = three.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(halfFov) * camera.aspect);
  const fit = sphere.radius / Math.sin(Math.min(halfFov, horizontal));
  orbit.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(VIEW_DIRECTION.clone().multiplyScalar(fit));
  camera.near = fit / 200;
  camera.far = fit * 20;
  camera.updateProjectionMatrix();
  const elevation = three.MathUtils.degToRad(sky.elevation);
  const azimuth = three.MathUtils.degToRad(sky.azimuth);
  const d = sphere.radius * 3 + 4;
  sun.position
    .copy(sphere.center)
    .add(
      new three.Vector3(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.cos(azimuth) * Math.cos(elevation),
      ).multiplyScalar(d),
    );
  (scene.fog as three.Fog).near = fit * 1.5;
  (scene.fog as three.Fog).far = fit * 6;
  sun.target.position.copy(sphere.center);
  const s = sun.shadow.camera as three.OrthographicCamera;
  s.left = s.bottom = -sphere.radius * 1.4;
  s.right = s.top = sphere.radius * 1.4;
  s.near = 0.5;
  s.far = sphere.radius * 8 + 20;
  s.updateProjectionMatrix();
}

// ── icons: 24-unit stroke paths; the logo is the ThreeNative TN mark ──
const TN_MARK =
  "M2.1 5.2C-0.2 5.3-0.1 6.4 2.7 9.6C5.4 12.6 8.1 15 9.6 15.6C11 16.2 11.4 16.2 24.6 16.3C38.6 16.3 38.1 16.3 39.8 17.3C41.7 18.3 42.5 19.4 43.4 21.9L43.8 23.1 43.8 32.9C43.8 42 43.8 42.7 43.6 42.9C43.1 43.4 42 43 41.3 42C41.2 41.7 40.8 41.4 40.5 41.3C40.2 41.1 39.8 40.8 39.5 40.5C39.2 40.3 38.6 39.7 38.1 39.3C35.5 37.2 33 35.1 33 35C33 35 32.7 34.8 32.4 34.6C32.1 34.4 31.4 33.9 30.9 33.4C30.3 32.9 29.5 32.2 29.1 31.8C28.6 31.4 28 30.8 27.7 30.6C27.4 30.4 26.7 29.9 26.1 29.4C24.1 27.6 22.8 26.5 22.2 26.1C21.9 25.8 21.2 25.3 20.8 24.9C19.1 23.4 17.9 23.3 17.2 24.4C17 24.8 17 25 16.9 46.3L16.9 67.8 16.6 69.4C16.5 70.2 16.2 71.2 16 71.6C15.7 72.2 13.5 75.7 12.6 77C11.8 78.2 9.6 81.6 7.3 85.3C3.1 92.1 2.3 95.3 5 94.9C6.6 94.7 12.5 90.9 16.1 87.8C16.5 87.5 17.2 86.9 17.7 86.6C18.9 85.6 20.1 84.7 20.6 84.2C20.8 84 21.6 83.2 22.5 82.5C26 79.4 27.8 77.5 28.5 76C29.2 74.5 29.2 74.2 29.2 60.7C29.2 48.2 29.2 48 29.5 47.8C29.7 47.7 29.9 47.6 30.1 47.7C30.6 47.8 32.1 49 36.1 52.4C36.7 52.9 37.7 53.7 38.3 54.2C39.8 55.3 42.1 57.2 43.3 58.3L43.8 58.8 43.8 70.8C43.7 84 43.8 85 44.4 86.3C45.3 88.2 48.1 91.7 49.2 92.3C50 92.7 50.9 92.4 51.9 91.2C52.2 90.9 52.7 90.3 53.1 89.9C53.9 89.1 55 87.5 55.4 86.5C56.2 85.1 56.1 85.4 56.2 77.8C56.2 73.9 56.2 70.6 56.3 70.4C56.5 69.6 57.4 69.9 59 71.3C59.6 71.9 60.2 72.3 60.2 72.3C60.4 72.3 64 75.1 66.6 77.3C66.9 77.6 67.6 78.1 68 78.4C68.4 78.7 69.1 79.2 69.4 79.5C69.7 79.8 70.4 80.3 71 80.7C71.5 81.1 72.3 81.7 72.7 82C73.2 82.3 73.8 82.8 74.2 83.1C74.6 83.3 75.1 83.7 75.3 83.8C75.5 84 76.5 84.7 77.5 85.4C82.7 89.1 87.1 91.8 90.3 93.4C96.3 96.4 97.5 95.2 94.3 89.1C93.5 87.5 91.4 83.9 90.8 83.1C90.6 82.8 90.3 82.2 90 81.7C89.5 80.8 89.2 80.3 87.4 77.5C84.3 72.7 84 72.2 83.5 70.7L83 69.3 82.9 47C82.8 23.5 82.9 24.3 82.2 23.9C81.2 23.3 80.6 23.6 77.6 26.5C71.8 31.9 70.5 33.2 69.9 35L69.6 35.7 69.6 49.7C69.5 63.5 69.5 64.5 69.2 64.7C68.9 64.9 68 64.5 67.2 63.8C66.8 63.4 66.1 62.8 65.7 62.5C65.3 62.2 64.4 61.4 63.6 60.8C62.9 60.2 62 59.5 61.8 59.3C61.5 59 60.6 58.2 59.7 57.5C58.8 56.7 57.7 55.8 57.3 55.5C56.9 55.2 56.5 54.8 56.4 54.7C56.1 54.3 56.1 23.6 56.4 22.2C56.9 20.4 58.3 18.2 59.6 17.6C59.9 17.4 60.4 17.1 60.6 17C61.4 16.4 62 16.3 75.5 16.3C82.6 16.2 88.4 16.2 88.8 16.1C90.7 15.8 92.3 14.8 94.7 12.3C100 6.9 100.6 5.4 97.8 5.1C96.6 5 3.7 5.1 2.1 5.2";
const ICONS: Record<string, string> = {
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
  wire: "M12 2l9 5v10l-9 5-9-5V7zM12 22V12M21 7l-9 5-9-5M3 17l9-5 9 5",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8",
  background: "M3 3h18v18H3zM8.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM21 15l-5-5L5 21",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5",
  panel: "M3 3h18v18H3zM3 15h18",
  panelRight: "M3 3h18v18H3zM15 3v18",
  panelBottom: "M3 3h18v18H3zM3 15h18",
  fullscreen: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5",
  external: "M14 3h7v7M21 3l-9 9M19 14v7H3V5h7",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  sheet: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  chevron: "M6 9l6 6 6-6",
  doc: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8",
  story: "M6 3h12v18l-6-5-6 5z",
  group: "M3 3h18v18H3zM12 3v18M3 12h18",
};
const svg = (name: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ""}"/></svg>`;
$("logo").innerHTML =
  `<svg viewBox="0 4.5 100 91" width="18" height="18" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="${TN_MARK}"/></svg>`;
const iconEl = (name: string, className = "", size = 14) => {
  const span = el("span", `inline-flex shrink-0 ${className}`);
  span.innerHTML = svg(name, size);
  return span;
};

// ── stats and docs ──
const size = (b: IAssetReport["bounds"]) => b.max.map((v, i) => (v - (b.min[i] ?? 0)).toFixed(2));

/** The catalog's bake call with the seed, the LOD and every touched control written in, `out` last. */
function callFor(e: IAssetElement): string {
  const [, fn = "bake", body = ""] = /^(\w+)\(\{(.*)\}\)$/s.exec(e.bake?.trim() ?? "") ?? [];
  const args = new Map(
    [...body.matchAll(/(\w+):\s*("[^"]*"|[^,]+?)\s*(?=,|$)/g)].map((m) => [m[1], m[2]]),
  );
  const out = args.get("out");
  args.delete("out");
  if (state.seed !== undefined) args.set("seed", String(state.seed));
  if (hasLod(e.kind)) args.set("lods", `[${state.lod}]`);
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

function attributesOf(model: three.Object3D): string {
  const rows: string[] = [];
  model.traverse((node) => {
    const mesh = node as three.Mesh;
    if (mesh.isMesh)
      rows.push(
        `${(mesh.material as three.Material).name || "material"}: ${Object.keys(mesh.geometry.attributes).join(", ")}`,
      );
  });
  return rows.join("\n");
}

const PRE =
  "whitespace-pre-wrap break-all rounded border border-line bg-sidebar p-3 font-mono text-xs text-ink";
const DL = "grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 [&_dt]:font-bold [&_dt]:text-muted";

function copyButton(label: string, text: () => string): HTMLButtonElement {
  const copy = el("button", "tool w-auto justify-self-start px-2 text-ink", label);
  copy.onclick = () => navigator.clipboard?.writeText(text()).then(() => say("Copied"));
  return copy;
}

function renderDocs(element: IAssetElement, baked: IAssetReport, model: three.Object3D): void {
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
    ["Kind", kindName(element.kind)],
    ["Visual style", styleNames(element).join(", ")],
    ...(element.settingTags?.length
      ? [["Setting", settingNames(element).join(", ")] as [string, string]]
      : []),
    ...(element.category ? [["Category", element.category] as [string, string]] : []),
    ...(baked.materialSlots?.length
      ? [["Material slots", baked.materialSlots.join(", ")] as [string, string]]
      : []),
    ["Biomes", element.biomes?.join(", ") || "none listed"],
    ...(file ? [["File", file] as [string, string]] : []),
  ]);
  const call = baked.call ?? `await ${callFor(element)};`;
  const parts = el(
    "label",
    "grid gap-1 font-bold text-muted",
    runtime ? "Mesh attributes" : "GLB primitives and attributes",
  );
  parts.append(el("pre", PRE, attributesOf(model)));
  $("docs").replaceChildren(
    head,
    dl,
    el("pre", PRE, call),
    copyButton(runtime ? "Copy code" : "Copy bake call", () => call),
    parts,
  );
}

// ── background: the source's sky, or a flat dark or light backdrop ──
const BACKGROUNDS: { name: string; color?: string; floor?: string }[] = [
  { name: "studio", color: "#30353a", floor: "#3b4146" },
  { name: "sky" },
  { name: "light", color: "#e9ecef", floor: "#d5d9dd" },
];
function applyBackground(): void {
  const { name, color, floor } = BACKGROUNDS[state.background] ?? { name: "sky" };
  scene.background = backgroundColor;
  if (color) {
    backgroundColor.set(color);
    (scene.fog as three.Fog).color.set(color);
    (ground.material as three.MeshStandardMaterial).color.set(floor ?? color);
  }
  clientOf(routeElement()).background?.(view);
  $("background").title = `Background: ${name}`;
  $("background").setAttribute("aria-label", `Background: ${name}`);
}

// ── lighting: the source's own, or a preset so an asset is tuned under the game's look ──
interface ILightPreset {
  readonly name: string;
  readonly tone: three.ToneMapping;
  readonly exposure: number;
  readonly env: number;
  readonly hemi: [number, number, number];
  readonly sun: [number, number, number];
  readonly sky: [number, number];
}
const LIGHTS: Record<string, ILightPreset> = {
  studio: {
    name: "Studio neutral",
    tone: three.NeutralToneMapping,
    exposure: 1,
    env: 1,
    hemi: [0xffffff, 0x888888, 0.35],
    sun: [0xffffff, 3, 0],
    sky: [42, 35],
  },
  daylight: {
    name: "Daylight",
    tone: three.ACESFilmicToneMapping,
    exposure: 1.1,
    env: 0.8,
    hemi: [0xbfd8ff, 0x6b5f4a, 0.6],
    sun: [0xfff1d6, 4, 0],
    sky: [55, 30],
  },
  overcast: {
    name: "Overcast",
    tone: three.ACESFilmicToneMapping,
    exposure: 1.2,
    env: 1.2,
    hemi: [0xd8dde2, 0x707070, 1.2],
    sun: [0xe8ecf0, 0.6, 0],
    sky: [70, 10],
  },
  night: {
    name: "Night",
    tone: three.ACESFilmicToneMapping,
    exposure: 0.9,
    env: 0.12,
    hemi: [0x3a4a78, 0x0a0c14, 0.35],
    sun: [0x9fb4ff, 0.6, 0],
    sky: [35, -60],
  },
  // The stock look a scene with no look options gets (WorldEnvironment: filmic tone curve).
  filmic: {
    name: "Filmic (Unreal defaults)",
    tone: three.AgXToneMapping,
    exposure: 1,
    env: 1,
    hemi: [0xdfe9ff, 0x6a6458, 0.5],
    sun: [0xfff4e0, 3.5, 0],
    sky: [45, 40],
  },
};
let lighting = "auto";
function applyLighting(element: IAssetElement | undefined, loaded?: IAssetLoaded): void {
  const preset = LIGHTS[lighting] ?? (clientOf(element).light ? undefined : LIGHTS.studio);
  if (!preset) {
    clientOf(element).light?.(element, view, loaded);
    return;
  }
  renderer.toneMapping = preset.tone;
  renderer.toneMappingExposure = preset.exposure;
  scene.environment = roomEnvironment;
  scene.environmentIntensity = preset.env;
  hemi.color.set(preset.hemi[0]);
  hemi.groundColor.set(preset.hemi[1]);
  hemi.intensity = preset.hemi[2];
  sun.color.set(preset.sun[0]);
  sun.intensity = preset.sun[1];
  [sky.elevation, sky.azimuth] = preset.sky;
  sunShadow(2048, 1);
  ground.visible = true;
  grid.visible = toggled("grid");
}

const toggled = (id: string) => $(id).getAttribute("aria-pressed") === "true";
/** The shell's scene as a source client sees it. */
const view: IAssetViewContext = {
  renderer,
  scene,
  camera,
  sun,
  hemi,
  ground,
  grid,
  content,
  backgroundColor,
  roomEnvironment,
  sky,
  state,
  touched,
  get route() {
    return route;
  },
  get catalog() {
    return catalog;
  },
  get background() {
    return BACKGROUNDS[state.background]?.name ?? "sky";
  },
  invalidate,
  sunShadow,
  say,
  toggled,
};

// ── stories ──
/** The tiled story: the tile index at -1, 0 and 1, each placed one width (of tile 0) over. */
async function tiled(
  mine: number,
  element: IAssetElement,
  key: string,
): Promise<boolean | undefined> {
  say(`Baking ${element.name} ×3`);
  const bakes = await Promise.all(
    [-1, 0, 1].map((n) => bakeOf(element, state.lod, [[key, String(n)]])),
  );
  const width = (bakes[1]?.bounds.max[0] ?? 0) - (bakes[1]?.bounds.min[0] ?? 0);
  let windy = false;
  for (const [i, baked] of bakes.entries()) {
    const { model, windy: sways } = await modelOf(element, baked);
    if (mine !== token) return undefined;
    windy ||= sways;
    model.position.x = (i - 1) * width;
    content.add(model);
    if (i === 1) renderDocs(element, baked, model);
  }
  say(`${element.name} · ${key} -1, 0, 1 · ${width.toFixed(1)} m apart`);
  return windy;
}

async function assetOf(element: IAssetElement, lod = state.lod): Promise<IAssetLoaded> {
  const client = clientOf(element);
  if (isRuntimeKind(element.kind) && client.create) {
    const loaded = await client.create(element, view);
    loaded.model.traverse((node) => {
      const mesh = node as three.Mesh;
      if (mesh.isMesh)
        for (const material of [mesh.material].flat() as three.MeshStandardMaterial[])
          material.wireframe = state.wire;
    });
    return loaded;
  }
  const baked = await bakeOf(element, lod);
  const { model, windy } = await modelOf(element, baked);
  return { model, animated: windy, report: baked };
}

/** The overview story: every visible element of the kind (or category) on one line, at its true size. */
async function overview(mine: number, kindRows: IAssetElement[]): Promise<boolean | undefined> {
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
    el(
      "p",
      "text-muted",
      `${plural(shown.length, "element")}. Pick one for its preview and source call.`,
    ),
    list,
  );
  const lineup = shown.filter((row) => !row.backdrop && !BUILT_IN_KINDS.has(row.kind));
  if (BUILT_IN_KINDS.has(route.kind) && route.kind !== "model") {
    // A 2D kind has no 3D lineup: its overview is a card per file over the stage, not an empty floor.
    const grid = viewerHost.overlay(
      "inset-0 grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 overflow-y-auto bg-app p-4",
    );
    for (const e of shown) {
      const card = el("a", "grid gap-1 rounded border border-line p-2 text-xs hover:border-accent");
      card.href = hashOf(e.kind, e.id);
      const file = e.path ?? e.id;
      if (e.kind === "texture" && /\.(png|jpe?g|webp|svg)$/iu.test(file)) {
        const img = el("img", "aspect-square w-full rounded bg-black/30 object-contain");
        img.src = fileUrl(viewerHost, file);
        img.alt = e.name;
        img.loading = "lazy";
        card.append(img);
      }
      card.append(
        el("span", "truncate font-semibold text-ink", e.name),
        el("span", "truncate text-muted", e.id),
      );
      grid.append(card);
    }
    say(`${name} · ${plural(shown.length, "file")}`);
    return false;
  }
  const opening = lineup.length === 0 ? shown.find((row) => row.backdrop) : undefined;
  if (opening) {
    const loaded = await assetOf(opening);
    fixedView = loaded.view;
    applyLighting(opening, loaded);
    content.add(loaded.model);
    say(name);
    return loaded.animated ?? false;
  }
  const models = route.kind === "model" ? shown : lineup;
  for (const [i, row] of models.entries()) {
    say(`Loading ${name} ${i + 1} of ${models.length}`);
    const loaded =
      row.kind === "model"
        ? await builtInView(row, viewerHost, true)
        : await assetOf(row, Math.max(state.lod, 1));
    if (!loaded) continue;
    const { report: baked, model, animated } = loaded;
    if (mine !== token) {
      disposeModel(model);
      return undefined;
    }
    windy ||= animated ?? false;
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
  say(`${name} · ${plural(shown.length, "element")}`);
  return windy;
}

/** One element, as baked with the current seed, LOD and controls. */
async function single(mine: number, element: IAssetElement): Promise<boolean | undefined> {
  say(`Loading ${element.name}`);
  const loaded = BUILT_IN_KINDS.has(element.kind)
    ? await builtInView(element, viewerHost)
    : await assetOf(element);
  if (!loaded) return false;
  const { report: baked, model, animated, view: fixed } = loaded;
  if (mine !== token) {
    disposeModel(model);
    return undefined;
  }
  fixedView = fixed;
  applyLighting(element, loaded);
  if (!fixed) applyBackground();
  content.add(model);
  if (!BUILT_IN_KINDS.has(element.kind)) renderDocs(element, baked, model);
  const lod = baked.lod === undefined ? "" : ` · lod ${baked.lod}`;
  say(
    `${element.name}${lod} · ${baked.triangles.toLocaleString()} triangle${baked.triangles === 1 ? "" : "s"}`,
  );
  return animated ?? false;
}

async function show(): Promise<void> {
  const mine = ++token;
  clear();
  fixedView = undefined;
  viewerHost.leave();
  invalidate();
  $("intro").hidden = Boolean(route.kind);
  if (!route.kind) {
    frame();
    say("Pick an asset or an overview from the list");
    return;
  }
  const kindRows = catalog.elements.filter((e) => e.kind === route.kind);
  const element = kindRows.find((e) => e.id === route.id);
  applyLighting(element ?? kindRows[0]);
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
  $("wind").title = isRuntimeKind(route.kind) ? "Animate the scene" : "Animate the story";
  $("wind").setAttribute("aria-label", $("wind").title);
  swaying = Boolean(windy);
  invalidate();
  settled(mine);
}

// ── sidebar ──
function visible(e: IAssetElement): boolean {
  const words = $<HTMLInputElement>("search").value.toLowerCase().split(/\s+/).filter(Boolean);
  const biome = facet("biome");
  const setting = facet("setting");
  const category = facet("category");
  if (biome && !e.biomes?.includes(biome)) return false;
  if (setting && !e.settingTags?.includes(setting)) return false;
  if (category && e.category !== category) return false;
  if (selectedStyles.size && !e.styleTags.some((tag) => selectedStyles.has(tag))) return false;
  if (!words.length) return true;
  const text = [
    e.id,
    e.name,
    e.latin,
    e.kind,
    kindName(e.kind),
    e.category,
    ...styleNames(e),
    ...settingNames(e),
    ...(e.settingTags ?? []),
    ...(e.biomes ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

function hashOf(kind: string, id?: string, category?: string, extra: [string, string][] = []) {
  const q = new URLSearchParams([
    ...seedParam(),
    ...(hasLod(kind) ? [["lod", String(state.lod)] as [string, string]] : []),
    ...(category && !id ? [["category", category] as [string, string]] : []),
    ...paramsFor(kind, id),
  ]);
  for (const [key, value] of extra) q.set(key, value);
  const tail = q.toString();
  return `#/${kind}${id ? `/${encodeURIComponent(id)}` : ""}${tail ? `?${tail}` : ""}`;
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
      `${kind === "doc" ? "text-doc" : "text-story"} group-aria-[current=page]:text-accent-ink`,
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
function categoryNode(kind: string, category: string, members: IAssetElement[], open: boolean) {
  const docs = tab === "docs";
  const group = node(`${kind}/${category}`, category, open, "pl-5");
  const at = hashOf(kind, undefined, category);
  const current = here(kind, undefined, category);
  group.append(
    leaf(at, "Docs", "doc", current && docs, "pl-14", "docs"),
    leaf(at, "Overview", "story", current && !docs, "pl-14", "controls"),
    ...members.map((e) =>
      leaf(hashOf(kind, e.id), e.name, "story", here(kind, e.id) && !docs, "pl-14", "controls"),
    ),
  );
  return group;
}

/** An element node: its docs, its default story, a story per biome option and a tiled story. */
function elementNode(e: IAssetElement) {
  const docs = tab === "docs";
  const current = here(e.kind, e.id);
  const story = current && !docs && !route.tiled;
  const at = hashOf(e.kind, e.id);
  const biome = controlsFor(e.kind, e.id).find((c) => c.key === "biome" && c.type === "select");
  const tile = tileControl(e.kind, e.id);
  // A project file has one story: it is a leaf. A source element keeps its Docs and Default nodes.
  if (BUILT_IN_KINDS.has(e.kind) && !biome && !tile)
    return leaf(at, e.name, "story", story, "pl-10", "controls");
  const group = node(`${e.kind}/${e.id}`, e.name, current, "pl-5");
  group.append(
    leaf(at, "Docs", "doc", current && docs, "pl-14", "docs"),
    leaf(at, "Default", "story", story && !touched.has("biome"), "pl-14", "controls"),
    ...(biome?.options ?? []).map((o) =>
      leaf(
        hashOf(e.kind, e.id, undefined, [["biome", o]]),
        optionName(o),
        "story",
        story && touched.get("biome") === o,
        "pl-14",
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
        "pl-14",
        "controls",
      ),
    );
  return group;
}

/** One kind: a pack inside its collection, with its overview, then a node per category or per element. */
function kindSection(kind: string, rows: IAssetElement[], searching: boolean) {
  const summary = el(
    "summary",
    "flex items-center gap-1.5 rounded py-1 pr-2 pl-1 font-bold text-ink hover:bg-hover",
  );
  summary.append(
    iconEl("chevron", "chev text-muted transition-transform", 12),
    iconEl("group", "text-group"),
    el("span", "flex-1 truncate", packName(kind)),
    el("span", "font-normal text-muted", String(rows.length)),
  );
  const section = folder(kind, searching || route.kind === kind, summary);
  section.append(
    leaf(hashOf(kind), "Overview", "story", here(kind) && tab !== "docs", "pl-10", "controls"),
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
  const filtering = Boolean($<HTMLInputElement>("search").value.trim() || facetIds.some(facet));
  const matching = catalog.elements.filter(visible);
  const nav = $("tree");
  nav.replaceChildren();
  // collections first, then one pack per kind inside each
  for (const [style, label] of Object.entries(catalog.styles)) {
    const packs = kinds()
      .map((kind) => matching.filter((e) => e.kind === kind && e.styleTags[0] === style))
      .filter((rows) => rows.length);
    if (!packs.length) continue;
    const summary = el(
      "summary",
      "mt-3 flex items-center gap-1.5 py-1 pl-1 text-[11px] font-extrabold uppercase tracking-[0.2em] text-muted hover:text-ink",
    );
    summary.append(
      iconEl("chevron", "chev transition-transform", 12),
      el("span", "flex-1", label),
      el(
        "span",
        "font-normal tracking-normal",
        String(packs.reduce((n, rows) => n + rows.length, 0)),
      ),
    );
    const collection = folder(`style/${style}`, true, summary);
    for (const rows of packs) collection.append(kindSection(rows[0]?.kind ?? "", rows, filtering));
    nav.append(collection);
  }
  if (!nav.childElementCount) nav.append(el("p", "px-1 py-3 text-muted", "No matching assets"));
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
  // A story re-renders live in its frame; a bake goes through the URL so the link names it.
  if (route.kind === "story") {
    viewerHost.storyProps(storyProps());
    return;
  }
  go();
}

/** The current story props, each control's touched value or its default, typed. */
function storyProps(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const c of storyControls ?? []) {
    const raw = touched.get(c.key);
    if (raw === undefined) props[c.key] = c.default;
    else if (c.type === "range") props[c.key] = Number(raw);
    else if (c.type === "toggle") props[c.key] = raw === "true";
    else if (c.type === "vec3") props[c.key] = raw.split(",").map(Number);
    else props[c.key] = raw;
  }
  return props;
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

const optionName = (option: string) => catalog.biomes?.find((b) => b.id === option)?.name ?? option;

function selectWidget(c: IAssetControl, value: string | undefined, set: (v: string) => void) {
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

function widget(c: IAssetControl): HTMLElement {
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
  if (c.type === "color") {
    const color = el("input", "h-7 w-14 cursor-pointer rounded border border-line bg-sidebar");
    color.type = "color";
    color.name = c.key;
    color.setAttribute("aria-label", c.label);
    color.value = value ?? "#ffffff";
    color.oninput = () => set(color.value);
    return color;
  }
  if (c.type === "vec3") return vec3Widget(c, value, set);
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

/** Three number fields, x y z, committed together as `x,y,z`. */
function vec3Widget(c: IAssetControl, value: string | undefined, set: (v: string) => void) {
  const row = el("div", "flex items-center gap-1.5");
  const parts = (value ?? "0,0,0").split(",");
  const fields = ["x", "y", "z"].map((axis, i) => {
    const field = el("input", "field w-20 tabular-nums");
    field.type = "number";
    field.step = String(c.step ?? 0.1);
    field.name = `${c.key}-${axis}`;
    field.value = parts[i] ?? "0";
    field.setAttribute("aria-label", `${c.label} ${axis}`);
    return field;
  });
  for (const field of fields) field.onchange = () => set(fields.map((f) => f.value).join(","));
  row.append(...fields);
  return row;
}

function rangeWidget(c: IAssetControl, value: string | undefined, set: (v: string) => void) {
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
    if (route.kind === "story") set(slider.value);
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
    b.title = `Reset ${label} to its default`;
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
  const seeded = route.kind !== "" && hasSeed(route.kind);
  body.replaceChildren(
    ...(seeded ? [controlRow("seed", seed, unseed, unseed ? "" : "auto")] : []),
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
                if (route.kind === "story") {
                  viewerHost.storyProps(storyProps());
                  renderControls();
                } else go();
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
  if (route.kind === "story" && list.length) {
    const row = el("tr");
    const td = el("td", "flex gap-2 px-4 py-3");
    td.append(
      copyButton("Copy props", () => JSON.stringify(storyProps(), null, 2)),
      copyButton("Copy snippet", () => viewerHost.storySnippet(storyProps())),
    );
    row.append(td);
    body.append(row);
  }
  $("control-count").textContent = String(
    list.length + (hasLod(route.kind) ? 1 : 0) + (seeded ? 1 : 0),
  );
}

function readHash(): void {
  const [pathPart = "", search = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [kind = "", ...rest] = pathPart.split("/");
  const id = rest.length ? decodeURIComponent(rest.join("/")) : undefined;
  const q = new URLSearchParams(search);
  const known = kinds();
  const category = id ? null : q.get("category");
  const routeKind = known.includes(kind) ? kind : "";
  const tiledKey = q.get("tiled");
  if (route.kind !== routeKind || route.id !== id) storyControls = undefined;
  route = {
    kind: routeKind,
    ...(id ? { id } : {}),
    ...(category ? { category } : {}),
    ...(tiledKey && tileControl(routeKind, id)?.key === tiledKey ? { tiled: tiledKey } : {}),
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

// ── built-in viewers (project files, stories) see the shell through this host ──
const viewerHost = createViewerHost({
  api: API,
  base: config.base,
  view,
  stage: $("stage"),
  docs: $("docs"),
  stats: $("stat-rows"),
  loader,
  orbit,
  invalidate,
  frame,
  say,
  el,
  rowsInto,
  copyButton,
  get wire() {
    return state.wire;
  },
  setStoryControls(controls: readonly IAssetControl[]) {
    storyControls = controls;
    for (const c of controls) {
      const value = new URLSearchParams(location.hash.split("?")[1] ?? "").get(c.key);
      if (value !== null) touched.set(c.key, value);
    }
    renderControls();
    return storyProps();
  },
});

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
function refreshFilters(): void {
  $("filter").setAttribute("data-active", String(facetIds.some(facet)));
  renderTree();
  if (!route.id) void show();
}
for (const id of facetIds) $(id).addEventListener("change", refreshFilters);
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
    const mesh = n as three.Mesh;
    if (mesh.isMesh)
      for (const material of [mesh.material].flat() as three.MeshStandardMaterial[])
        material.wireframe = on;
  });
  viewerHost.wireframe(on);
});
toggle("grid", (on) => {
  grid.visible = on && !fixedView;
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
for (const [id, preset] of Object.entries(LIGHTS)) {
  const option = el("option", "", preset.name);
  option.value = id;
  $("lighting").append(option);
}
$<HTMLSelectElement>("lighting").onchange = (event) => {
  lighting = (event.target as HTMLSelectElement).value;
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
$("open-sheet").onclick = () => {
  const url = new URL(location.href);
  url.searchParams.set("sheet", "turntable");
  window.open(url.href, "_blank", "noopener");
};
for (const name of ["controls", "docs", "stats"] as const)
  $(`tab-${name}`).onclick = () => setTab(name);
$("reset-all").onclick = () => {
  touched.clear();
  state.seed = undefined;
  go();
};
window.addEventListener("hashchange", readHash);
setDock("bottom");

// ── host bridge (`?embed=1`): a parent selects a story, switches the theme, asks for a sheet ──
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || typeof event.data !== "object" || event.data === null)
    return;
  const message = event.data as { type?: string; hash?: string; theme?: string; sheet?: string };
  if (message.type === "tn-asset-library:select" && typeof message.hash === "string")
    location.hash = message.hash.startsWith("#") ? message.hash : `#/${message.hash}`;
  else if (message.type === "tn-asset-library:theme")
    document.documentElement.dataset.theme = message.theme === "light" ? "light" : "dark";
  else if (message.type === "tn-asset-library:sheet") {
    const url = new URL(location.href);
    url.searchParams.set("sheet", message.sheet ?? "turntable");
    location.href = url.href;
  } else if (message.type === "tn-asset-library:pause") paused = true;
  else if (message.type === "tn-asset-library:resume") {
    paused = false;
    invalidate();
  }
});
/** Posts a story's settle to the host, and in sheet mode renders the contact sheet once. */
function settled(mine: number): void {
  if (embed)
    window.parent.postMessage(
      { type: "tn-asset-library:ready", hash: location.hash, title: status.textContent },
      "*",
    );
  if (!sheetMode || !route.kind) return;
  void viewerHost
    .sheet(sheetMode, () => renderNow())
    .then(() => {
      if (mine !== token) return;
      Reflect.set(globalThis, "__TN_ASSET_LIBRARY_READY__", true);
    });
}

// ── loop: renders on demand, and not at all while the page is hidden or paused by the host ──
let paused = false;
let last = performance.now();
function resize(): void {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (
    canvas.width !== Math.floor(w * renderer.getPixelRatio()) ||
    canvas.height !== Math.floor(h * renderer.getPixelRatio())
  ) {
    renderer.setSize(w, h, false);
    for (const client of Object.values(config.clients)) client.resize?.(w, h);
    invalidate();
    labels.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
}
function renderNow(dt = 0): void {
  const client = clientOf(routeElement());
  if (viewerHost.render()) return;
  if (!client.render?.(dt, view)) renderer.render(scene, camera);
  labels.render(scene, camera);
}
renderer.setAnimationLoop(() => {
  if (paused || document.visibilityState === "hidden") {
    last = performance.now();
    return;
  }
  resize();
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const moved = orbit.update();
  const animate = swaying && state.wind;
  if (animate) clientOf(routeElement()).tick?.(dt, view);
  const playing = viewerHost.playing();
  if (playing) viewerHost.tick(dt);
  if (!(moved || dirty || animate || playing)) return;
  dirty = false;
  renderNow(dt);
});
for (const type of ["click", "change", "input"]) document.addEventListener(type, invalidate);
document.addEventListener("visibilitychange", invalidate);
const pointer = new three.Raycaster();
canvas.addEventListener("pointermove", (event) => {
  const client = clientOf(routeElement());
  if (!client.pointer) return;
  const rect = canvas.getBoundingClientRect();
  pointer.setFromCamera(
    new three.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
  client.pointer(pointer.intersectObject(content, true)[0]?.point, view);
  invalidate();
});

/** A tab opened straight on `/__assets/` waits until it is shown before it fetches anything. */
async function visibleOnce(): Promise<void> {
  if (document.visibilityState === "visible") return;
  await new Promise<void>((resolve) => {
    const onShow = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onShow);
      resolve();
    };
    document.addEventListener("visibilitychange", onShow);
  });
}

try {
  await visibleOnce();
  catalog = (await (await fetch(`${API}catalog`)).json()) as typeof catalog;
  for (const [id, name] of Object.entries(catalog.styles)) {
    const button = el(
      "button",
      "rounded border border-line px-2 py-1 text-xs text-ink hover:bg-hover aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-ink",
      name,
    );
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.onclick = () => {
      if (!selectedStyles.delete(id)) selectedStyles.add(id);
      button.setAttribute("aria-pressed", String(selectedStyles.has(id)));
      refreshFilters();
    };
    $("style-tags").append(button);
  }
  const categories = [
    ...new Set(catalog.elements.flatMap((entry) => (entry.category ? [entry.category] : []))),
  ];
  const facets: Record<(typeof facetIds)[number], [string, string][]> = {
    setting: Object.entries(catalog.settings ?? {}),
    category: categories.map((name) => [name, name]),
    biome: (catalog.biomes ?? []).map(({ id, name }) => [id, name]),
  };
  $("filter").hidden = $("settings").hidden = facetIds.every((id) => !facets[id].length);
  for (const id of facetIds) {
    $(id).hidden = !facets[id].length;
    for (const [value, name] of facets[id].sort((a, b) => a[1].localeCompare(b[1]))) {
      const option = el("option", "", name);
      option.value = value;
      $(id).append(option);
    }
  }
  viewerHost.ready(catalog);
  readHash();
} catch (error) {
  say(`Catalog failed: ${(error as Error).message}`, true);
}
