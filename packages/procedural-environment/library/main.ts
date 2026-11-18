import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import Outcrop from "../vendor/outcrop.js";

interface IElement {
  id: string;
  name: string;
  latin?: string;
  kind: string;
  biomes: string[];
  bake: string;
}
interface IBiome {
  id: string;
  name: string;
  rock: string;
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
  error?: string;
}

const KINDS: Record<string, string> = {
  tree: "Trees",
  cover: "Cover",
  debris: "Forest floor",
  rock: "Rocks",
};
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── scene ──
const canvas = $<HTMLCanvasElement>("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const labels = new CSS2DRenderer();
Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
canvas.parentElement?.append(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9c6d2);
// Outcrop's page light: a hemisphere and one sun tinted by the biome's environment row, no IBL.
scene.fog = new THREE.Fog(0xffffff, 10, 100);
const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.1);
const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0003;
scene.add(sun, sun.target, hemi);
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x8a8a7c, roughness: 1 }),
);
ground.receiveShadow = true;
const grid = new THREE.GridHelper(200, 200, 0x55606a, 0x77818a);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.35;
grid.position.y = 0.002;
const figure = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.22, 1.36, 6, 16).translate(0, 0.9, 0),
  new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 }),
);
figure.castShadow = true;
scene.add(ground, grid, figure);

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const content = new THREE.Group();
scene.add(content);

// ── wind: the _WIND vec4 every vegetation GLB carries (x trunk, y branch, z flutter, w phase) ──
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
const state = { seed: 1, lod: 0, rockBiome: "hills", rockDetail: 0.3, wind: true, wire: false };
const sky = { elevation: 42, azimuth: 35 };

/** The light of an Outcrop biome's `environment` row: sky, ground, sun colour and angle. */
function lightFor(outcropBiome: string): void {
  const env = (Outcrop.BIOMES[outcropBiome] ?? Outcrop.BIOMES.hills)?.environment as
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
let catalog: { elements: IElement[]; biomes: IBiome[] } = { elements: [], biomes: [] };
let route: { kind: string; id?: string } = { kind: "tree" };
let token = 0;
const loader = new GLTFLoader();
const status = $("status");
const say = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle("error", error);
};

async function bakeOf(element: IElement, lod = state.lod): Promise<IBake> {
  const q = new URLSearchParams({
    id: element.id,
    kind: element.kind,
    seed: String(state.seed),
    lod: String(lod),
    ...(element.kind === "rock"
      ? { biome: state.rockBiome, detail: String(state.rockDetail) }
      : {}),
  });
  const baked = (await (await fetch(`/api/bake?${q}`)).json()) as IBake;
  if (baked.error) throw new Error(baked.error);
  return baked;
}

// ── rocks: Outcrop's own triplanar material over the maps the bake wrote ──
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
async function modelOf(baked: IBake): Promise<THREE.Object3D> {
  const gltf = await loader.loadAsync(baked.url);
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
    mesh.castShadow = mesh.receiveShadow = true;
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.wireframe = state.wire;
    if (mesh.geometry.getAttribute("_wind")) addWind(material);
  });
  await Promise.all(meshes.map((mesh) => rockMaterial(mesh, baked)));
  return gltf.scene;
}

function clear(): void {
  for (const child of [...content.children]) {
    content.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (node instanceof CSS2DObject) node.element.remove();
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.normalMap?.dispose();
      material.dispose();
    });
  }
}

function frame(): void {
  const box = new THREE.Box3().setFromObject(content);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fit = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  controls.target.copy(sphere.center);
  camera.position
    .copy(sphere.center)
    .add(new THREE.Vector3(0.55, 0.32, 1).normalize().multiplyScalar(fit));
  camera.near = fit / 200;
  camera.far = fit * 20;
  camera.updateProjectionMatrix();
  const el = THREE.MathUtils.degToRad(sky.elevation);
  const az = THREE.MathUtils.degToRad(sky.azimuth);
  const d = sphere.radius * 3 + 4;
  sun.position
    .copy(sphere.center)
    .add(
      new THREE.Vector3(
        Math.sin(az) * Math.cos(el),
        Math.sin(el),
        Math.cos(az) * Math.cos(el),
      ).multiplyScalar(d),
    );
  (scene.fog as THREE.Fog).near = fit * 1.5;
  (scene.fog as THREE.Fog).far = fit * 6;
  sun.target.position.copy(sphere.center);
  const s = sun.shadow.camera as THREE.OrthographicCamera;
  s.left = s.bottom = -sphere.radius * 1.4;
  s.right = s.top = sphere.radius * 1.4;
  s.far = sphere.radius * 8 + 20;
  s.updateProjectionMatrix();
}

const size = (b: IBake["bounds"]) => b.max.map((v, i) => (v - (b.min[i] ?? 0)).toFixed(2));
const callFor = (e: IElement) =>
  e.kind === "rock"
    ? `bakeRock({ form: "${e.id}", biome: "${state.rockBiome}", seed: ${state.seed}, lods: [${state.lod}], out: "assets/environment" })`
    : `bakeVegetation({ preset: "${e.id}", seed: ${state.seed}, lods: [${state.lod}], out: "assets/environment" })`;

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

function renderDocs(element: IElement, baked: IBake, model: THREE.Object3D): void {
  const [w, h, d] = size(baked.bounds);
  $("stats").innerHTML = `<dt>Triangles</dt><dd>${baked.triangles.toLocaleString()}</dd>
    <dt>Size (m)</dt><dd>${w} × ${h} × ${d}</dd><dt>Bake</dt><dd>${baked.ms} ms</dd>`;
  const docs = $("docs");
  docs.innerHTML = "";
  const head = document.createElement("div");
  head.innerHTML = `<h2></h2>${element.latin ? "<p></p>" : ""}`;
  (head.querySelector("h2") as HTMLElement).textContent = element.name;
  const latin = head.querySelector("p");
  if (latin) latin.textContent = element.latin ?? "";
  const dl = document.createElement("dl");
  const rows: [string, string][] = [
    ["Id", element.id],
    ["Kind", element.kind],
    ["Biomes", element.biomes.join(", ") || "none listed"],
    ["Triangles", baked.triangles.toLocaleString()],
    ["Size (m)", `${w} × ${h} × ${d}`],
    ["File", baked.path.split("/").pop() ?? ""],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const call = document.createElement("pre");
  call.textContent = `import { ${element.kind === "rock" ? "bakeRock" : "bakeVegetation"} } from "@threenative/procedural-environment";\n\nawait ${callFor(element)};`;
  const copy = document.createElement("button");
  copy.textContent = "Copy bake call";
  copy.onclick = () => navigator.clipboard?.writeText(callFor(element));
  const parts = document.createElement("pre");
  parts.textContent = attributesOf(model);
  const partsLabel = document.createElement("label");
  partsLabel.textContent = "GLB primitives and attributes";
  partsLabel.append(parts);
  docs.append(head, dl, call, copy, partsLabel);
}

async function show(): Promise<void> {
  const mine = ++token;
  clear();
  const kindRows = catalog.elements.filter((e) => e.kind === route.kind);
  const element = kindRows.find((e) => e.id === route.id);
  $("rock-biome-row").hidden = route.kind !== "rock";
  $("rock-detail-row").hidden = route.kind !== "rock";
  lightFor(
    route.kind === "rock"
      ? (catalog.biomes.find((b) => b.id === state.rockBiome)?.rock ?? "hills")
      : "hills",
  );
  try {
    if (element) {
      say(`Baking ${element.name}`);
      const baked = await bakeOf(element);
      const model = await modelOf(baked);
      if (mine !== token) return;
      content.add(model);
      figure.position.set((baked.bounds.max[0] ?? 0) + 0.8, 0, 0);
      renderDocs(element, baked, model);
      say(`${element.name} · lod ${baked.lod} · ${baked.triangles.toLocaleString()} triangles`);
    } else {
      // The overview story: every element of the kind on one line, at its true size.
      let x = 0;
      const shown = kindRows.filter(visible);
      for (const [i, row] of shown.entries()) {
        say(`Baking ${KINDS[route.kind]} ${i + 1} of ${shown.length}`);
        const baked = await bakeOf(row, Math.max(state.lod, 1));
        const model = await modelOf(baked);
        if (mine !== token) return;
        const [minX = 0, , minZ = 0] = baked.bounds.min;
        const [maxX = 0, , maxZ = 0] = baked.bounds.max;
        model.position.set(x - minX, 0, -(minZ + maxZ) / 2);
        const tag = document.createElement("div");
        tag.textContent = row.name;
        Object.assign(tag.style, {
          font: "11px system-ui",
          color: "#1f2933",
          background: "#ffffffcc",
          padding: "1px 4px",
          borderRadius: "3px",
        });
        const label = new CSS2DObject(tag);
        label.position.set(x + (maxX - minX) / 2, 0, (maxZ - minZ) / 2 + 0.6);
        content.add(model, label);
        x += maxX - minX + Math.max(0.4, (maxX - minX) * 0.25);
        frame();
      }
      figure.position.set(-1, 0, 0);
      $("stats").innerHTML = `<dt>Shown</dt><dd>${shown.length} of ${kindRows.length}</dd>`;
      $("docs").textContent =
        `${KINDS[route.kind]}: ${shown.length} elements. Pick one in the sidebar for its bake call.`;
      say(`${KINDS[route.kind]} · ${shown.length} elements`);
    }
    frame();
  } catch (error) {
    if (mine === token) say((error as Error).message, true);
  }
}

// ── sidebar ──
function visible(e: IElement): boolean {
  const words = ($<HTMLInputElement>("search").value ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const biome = $<HTMLSelectElement>("biome").value;
  const text = `${e.id} ${e.name} ${e.latin ?? ""} ${e.kind} ${e.biomes.join(" ")}`.toLowerCase();
  return (!biome || e.biomes.includes(biome)) && words.every((w) => text.includes(w));
}

function hashOf(kind: string, id?: string): string {
  const q = new URLSearchParams({ seed: String(state.seed), lod: String(state.lod) });
  if (kind === "rock") {
    q.set("biome", state.rockBiome);
    q.set("detail", String(state.rockDetail));
  }
  return `#/${kind}${id ? `/${id}` : ""}?${q}`;
}

function renderTree(): void {
  const nav = $("tree");
  nav.innerHTML = "";
  for (const [kind, title] of Object.entries(KINDS)) {
    const rows = catalog.elements.filter((e) => e.kind === kind && visible(e));
    const group = document.createElement("details");
    group.open = true;
    const summary = document.createElement("summary");
    summary.textContent = title;
    const count = document.createElement("span");
    count.textContent = String(rows.length);
    summary.append(count);
    group.append(summary);
    const all = document.createElement("a");
    all.className = "story";
    all.href = hashOf(kind);
    all.textContent = "Overview";
    if (route.kind === kind && !route.id) all.setAttribute("aria-current", "page");
    group.append(all);
    for (const e of rows) {
      const a = document.createElement("a");
      a.className = "story";
      a.href = hashOf(kind, e.id);
      a.textContent = `${e.name} `;
      const id = document.createElement("em");
      id.textContent = e.id;
      a.append(id);
      if (route.kind === kind && route.id === e.id) a.setAttribute("aria-current", "page");
      group.append(a);
    }
    nav.append(group);
  }
}

function readHash(): void {
  const [pathPart = "", query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [kind = "tree", id] = pathPart.split("/");
  const q = new URLSearchParams(query);
  route = { kind: KINDS[kind] ? kind : "tree", ...(id ? { id } : {}) };
  state.seed = Number.parseInt(q.get("seed") ?? "1", 10) || 1;
  state.lod = Math.min(2, Math.max(0, Number(q.get("lod") ?? 0)));
  state.rockBiome = q.get("biome") ?? state.rockBiome;
  state.rockDetail = Math.min(1, Math.max(0, Number(q.get("detail") ?? 0.3)));
  $<HTMLInputElement>("rock-detail").value = String(state.rockDetail);
  $<HTMLInputElement>("seed").value = String(state.seed);
  $<HTMLSelectElement>("rock-biome").value = state.rockBiome;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#lods button"))
    b.setAttribute("aria-pressed", String(Number(b.dataset.lod) === state.lod));
  renderTree();
  void show();
}

const go = () => {
  location.hash = hashOf(route.kind, route.id);
};
$("search").addEventListener("input", renderTree);
$("biome").addEventListener("change", renderTree);
$("seed").addEventListener("change", (e) => {
  state.seed = Number.parseInt((e.target as HTMLInputElement).value, 10) || 1;
  go();
});
for (const b of document.querySelectorAll<HTMLButtonElement>("#lods button"))
  b.onclick = () => {
    state.lod = Number(b.dataset.lod);
    go();
  };
$("rock-detail").addEventListener("change", (e) => {
  state.rockDetail = Number((e.target as HTMLInputElement).value);
  go();
});
$("rock-biome").addEventListener("change", (e) => {
  state.rockBiome = (e.target as HTMLSelectElement).value;
  go();
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
    if ((n as THREE.Mesh).isMesh)
      ((n as THREE.Mesh).material as THREE.MeshStandardMaterial).wireframe = on;
  });
});
toggle("figure", (on) => {
  figure.visible = on;
});
toggle("grid", (on) => {
  grid.visible = on;
});
$("frame").onclick = frame;
for (const tab of ["controls", "docs"])
  $(`tab-${tab}`).onclick = () => {
    for (const other of ["controls", "docs"]) {
      $(`tab-${other}`).setAttribute("aria-pressed", String(other === tab));
      $(other).hidden = other !== tab;
    }
  };
window.addEventListener("hashchange", readHash);

// ── loop ──
let last = performance.now();
function resize(): void {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (
    canvas.width !== Math.floor(w * renderer.getPixelRatio()) ||
    canvas.height !== Math.floor(h * renderer.getPixelRatio())
  ) {
    renderer.setSize(w, h, false);
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
  if (state.wind) wind.uTime.value += dt;
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
});

catalog = (await (await fetch("/api/catalog")).json()) as typeof catalog;
for (const biome of catalog.biomes) {
  for (const select of [$<HTMLSelectElement>("biome"), $<HTMLSelectElement>("rock-biome")]) {
    const option = document.createElement("option");
    option.value = biome.id;
    option.textContent = biome.name;
    select.append(option);
  }
}
readHash();
