// The shell's built-in viewers for project files (PRD-915): models, textures, audio, code stories
// and the scene bundler. Each one is a mode of the same stage; `IViewerHost` is all it sees.
import * as three from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VertexNormalsHelper } from "three/addons/helpers/VertexNormalsHelper.js";
import type { GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type {
  IAssetCatalog,
  IAssetControl,
  IAssetElement,
  IAssetLoaded,
  IAssetViewContext,
} from "../types.js";
import { animationPanel } from "./animation.js";
import { audioView } from "./audio.js";
import { stageView } from "./stage.js";
import { storyView } from "./story.js";
import { textureView } from "./texture.js";

/** The kinds the shell views itself, from project files, with no source client. */
export const BUILT_IN_KINDS: ReadonlySet<string> = new Set([
  "model",
  "texture",
  "audio",
  "story",
  "stage",
]);

/** What the shell hands its viewers. */
export interface IViewerBase {
  readonly api: string;
  readonly base: string;
  readonly view: IAssetViewContext;
  readonly stage: HTMLElement;
  readonly docs: HTMLElement;
  readonly stats: HTMLElement;
  readonly loader: GLTFLoader;
  readonly orbit: OrbitControls;
  readonly wire: boolean;
  invalidate(): void;
  frame(): void;
  say(text: string, error?: boolean): void;
  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K];
  rowsInto(dl: HTMLElement, rows: [string, string][]): HTMLElement;
  copyButton(label: string, text: () => string): HTMLButtonElement;
  /** A story frame reported its controls: the shell renders them and returns the current props. */
  setStoryControls(controls: readonly IAssetControl[]): Record<string, unknown>;
}

/** One live viewer mode. The shell calls each hook if the mode has it. */
export interface IViewerMode {
  leave?(): void;
  tick?(dt: number): void;
  playing?(): boolean;
  /** Renders the frame itself; true when it did. */
  render?(): boolean;
  wireframe?(on: boolean): void;
  /** A labelled contact sheet of this mode, when the 3D turntable does not fit it. */
  sheet?(mode: string): Promise<HTMLCanvasElement>;
  storyProps?(props: Record<string, unknown>): void;
  storySnippet?(props: Record<string, unknown>): string;
}

export interface IViewerHost extends IViewerBase {
  readonly catalog: IAssetCatalog;
  leave(): void;
  ready(catalog: IAssetCatalog): void;
  use(mode: IViewerMode): void;
  storyProps(props: Record<string, unknown>): void;
  storySnippet(props: Record<string, unknown>): string;
  wireframe(on: boolean): void;
  sheet(mode: string, render: () => void): Promise<void>;
  tick(dt: number): void;
  playing(): boolean;
  render(): boolean;
  /** An overlay layer over the stage, cleared on every story change. */
  overlay(className?: string): HTMLElement;
}

export function createViewerHost(base: IViewerBase): IViewerHost {
  let active: IViewerMode = {};
  // One object, filled in place when the catalog arrives: `Object.assign` copies a getter's value,
  // not the getter, so a getter here handed every viewer the empty catalog forever.
  const catalog: IAssetCatalog = { elements: [], styles: {} };
  const overlays: HTMLElement[] = [];
  const host: IViewerHost = Object.assign(base, {
    catalog,
    ready(next: IAssetCatalog) {
      Object.assign(catalog, next);
    },
    use(mode: IViewerMode) {
      active = mode;
    },
    leave() {
      active.leave?.();
      active = {};
      for (const layer of overlays.splice(0)) layer.remove();
      base.view.renderer.domElement.style.visibility = "";
    },
    overlay(className = "") {
      const layer = base.el("div", `absolute z-10 ${className}`);
      base.stage.append(layer);
      overlays.push(layer);
      return layer;
    },
    storyProps: (props: Record<string, unknown>) => active.storyProps?.(props),
    storySnippet: (props: Record<string, unknown>) => active.storySnippet?.(props) ?? "",
    wireframe: (on: boolean) => active.wireframe?.(on),
    tick: (dt: number) => active.tick?.(dt),
    playing: () => active.playing?.() ?? false,
    render: () => active.render?.() ?? false,
    async sheet(mode: string, render: () => void) {
      const sheet = active.sheet ? await active.sheet(mode) : turntable(host, mode, render);
      const url = sheet.toDataURL("image/png");
      const img = base.el("img");
      img.id = "sheet-view";
      img.alt = `Contact sheet: ${document.title}`;
      img.src = url;
      document.body.append(img);
      Reflect.set(globalThis, "__TN_ASSET_LIBRARY_SHEET__", url);
    },
  });
  return host;
}

/** Fetches JSON from the library API and fails with the server's own error. */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({ error: response.statusText }))) as T & {
    error?: string;
  };
  if (!response.ok || body.error) throw new Error(body.error ?? `${response.status} ${url}`);
  return body;
}

export const fileUrl = (host: Pick<IViewerBase, "api">, file: string, cooked = false) =>
  `${host.api}project/${cooked ? "cooked" : "file"}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** Opens a built-in viewer. A 3D kind resolves its loaded model; a 2D kind draws itself. */
export async function builtInView(
  element: IAssetElement,
  host: IViewerHost,
  overview = false,
): Promise<IAssetLoaded | undefined> {
  if (element.kind === "model") return modelView(element, host, overview);
  if (element.kind === "texture") host.use(await textureView(element, host));
  else if (element.kind === "audio") host.use(await audioView(element, host));
  else if (element.kind === "story") host.use(await storyView(element, host));
  else if (element.kind === "stage") host.use(await stageView(element, host));
  return undefined;
}

// ── models ──

/** What `project/info` reports for a model: inspection, health, raw and cooked stats, LOD, op log. */
export interface IModelInfo {
  readonly path: string;
  readonly inspection: {
    readonly bounds: { center: three.Vector3Like; size: three.Vector3Like };
    readonly units: { label: string; longestAxis: number };
    readonly clips: readonly string[];
    readonly bones: readonly string[];
    readonly meshes: number;
    readonly materials: number;
    readonly textures: number;
  };
  readonly health: readonly { level: "ok" | "warn" | "error"; text: string }[];
  readonly raw: IFileStats;
  readonly cooked?: IFileStats & { readonly output: string; readonly format?: string };
  readonly lod?: { readonly levels: number; readonly maxPixelError: number };
  readonly animLog?: { readonly path: string; readonly ops: number };
  readonly poseLab: boolean;
}

export interface IFileStats {
  readonly bytes: number;
  readonly triangles?: number;
  readonly vertices?: number;
  readonly textures?: number;
  /** Estimated GPU memory for the textures, in bytes. */
  readonly vram?: number;
  readonly targets?: readonly string[];
}

const BADGE: Record<string, string> = {
  ok: "border-story/60 text-story",
  warn: "border-doc/70 text-doc",
  error: "border-danger/70 text-danger",
};

export const mb = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;

export function trianglesOf(root: three.Object3D): number {
  let triangles = 0;
  root.traverse((node) => {
    const mesh = node as three.Mesh & three.InstancedMesh;
    if (!mesh.isMesh) return;
    const count = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0;
    triangles += (count / 3) * (mesh.isInstancedMesh ? mesh.count : 1);
  });
  return Math.round(triangles);
}

export function reportOf(root: three.Object3D, ms: number, path?: string) {
  const box = new three.Box3().setFromObject(root);
  return {
    triangles: trianglesOf(root),
    bounds: { min: box.min.toArray(), max: box.max.toArray() },
    ms,
    ...(path ? { path } : {}),
  };
}

/** The scene graph as a collapsible tree: nodes, their meshes, each material and its texture slots. */
function hierarchy(host: IViewerBase, root: three.Object3D): HTMLElement {
  const slots = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"];
  const branch = (node: three.Object3D, depth: number): HTMLElement => {
    const mesh = node as three.Mesh & three.SkinnedMesh;
    const type = mesh.isSkinnedMesh
      ? "skinned"
      : mesh.isMesh
        ? "mesh"
        : (node as three.Bone).isBone
          ? "bone"
          : "node";
    const label = `${node.name || "(unnamed)"} · ${type}`;
    const details = host.el("details", "pl-3");
    details.open = depth < 2;
    const summary = host.el("summary", "truncate py-0.5 text-ink", label);
    details.append(summary);
    if (mesh.isMesh) {
      for (const material of [mesh.material].flat() as three.MeshStandardMaterial[]) {
        const used = slots.filter((slot) => Reflect.get(material, slot));
        details.append(
          host.el(
            "div",
            "pl-4 text-muted",
            `material ${material.name || material.type}${used.length ? ` · ${used.join(", ")}` : ""}`,
          ),
        );
      }
    }
    for (const child of node.children) details.append(branch(child, depth + 1));
    return details;
  };
  const box = host.el("div", "font-mono text-xs");
  box.append(branch(root, 0));
  return box;
}

/** `TN_discrete_lod` levels of each primitive in a cooked GLB, as swappable index buffers. */
interface ILodMesh {
  readonly mesh: three.Mesh;
  readonly levels: readonly { readonly index: three.BufferAttribute; readonly error: number }[];
}

async function lodMeshes(gltf: GLTF): Promise<ILodMesh[]> {
  const json = gltf.parser.json as {
    meshes?: { primitives?: { extensions?: Record<string, unknown> }[] }[];
  };
  const found: ILodMesh[] = [];
  const jobs: Promise<void>[] = [];
  gltf.scene.traverse((node) => {
    const mesh = node as three.Mesh;
    if (!mesh.isMesh) return;
    const at = gltf.parser.associations.get(mesh) as
      | { meshes?: number; primitives?: number }
      | undefined;
    const extensions =
      json.meshes?.[at?.meshes ?? -1]?.primitives?.[at?.primitives ?? 0]?.extensions;
    const def = extensions?.TN_discrete_lod as
      | { indices: number[]; absoluteErrors: number[] }
      | undefined;
    if (!def || !mesh.geometry.index) return;
    const lod0 = mesh.geometry.index;
    jobs.push(
      Promise.all(def.indices.map((index) => gltf.parser.getDependency("accessor", index))).then(
        (accessors: three.BufferAttribute[]) => {
          found.push({
            mesh,
            levels: [
              { index: lod0, error: 0 },
              ...accessors.map((index, i) => ({ index, error: def.absoluteErrors[i] ?? 0 })),
            ],
          });
        },
      ),
    );
  });
  await Promise.all(jobs);
  return found;
}

/**
 * The level the runtime would pick at `distance`: the coarsest whose geometric error, projected to
 * the viewport, stays under the cook's pixel budget (`assets.manifest.json` runtime.maxPixelError).
 */
export function lodLevelAt(
  errors: readonly number[],
  distance: number,
  viewportHeight: number,
  fovDegrees: number,
  maxPixelError: number,
  worldScale = 1,
): number {
  const pixelsPerUnit =
    viewportHeight / (2 * distance * Math.tan(three.MathUtils.degToRad(fovDegrees) / 2));
  let level = 0;
  for (const [i, error] of errors.entries())
    if (error * worldScale * pixelsPerUnit <= maxPixelError) level = i;
  return level;
}

async function modelView(
  element: IAssetElement,
  host: IViewerHost,
  overview: boolean,
): Promise<IAssetLoaded> {
  const file = element.path ?? element.id;
  const started = performance.now();
  const infoJob = getJson<IModelInfo>(`${host.api}project/info?path=${encodeURIComponent(file)}`);
  if (overview) {
    const gltf = await host.loader.loadAsync(fileUrl(host, file));
    return {
      model: gltf.scene,
      report: reportOf(gltf.scene, Math.round(performance.now() - started), file),
    };
  }
  const info = await infoJob;
  let cooked = false;
  const root = new three.Group();
  let gltf = await host.loader.loadAsync(fileUrl(host, file));
  root.add(gltf.scene);
  const helpers = new three.Group();
  root.add(helpers);
  let lods: ILodMesh[] = [];
  let lodDistance = 2;
  const overlay = host.overlay(
    "top-2 right-2 grid w-64 gap-2 rounded border border-line bg-app/90 p-2",
  );
  const badges = host.overlay("top-2 left-2 flex max-w-[60%] flex-wrap gap-1");
  for (const badge of info.health)
    badges.append(
      host.el(
        "span",
        `rounded border bg-app/85 px-1.5 py-0.5 text-[11px] ${BADGE[badge.level]}`,
        badge.text,
      ),
    );

  const readout = host.el("div", "text-xs text-muted");
  const setLod = () => {
    if (!lods.length) return;
    const { camera, renderer } = host.view;
    const height = renderer.domElement.clientHeight || 600;
    let triangles = 0;
    let shown = 0;
    for (const { mesh, levels } of lods) {
      const scale = mesh.getWorldScale(new three.Vector3()).length() / Math.sqrt(3);
      const level = lodLevelAt(
        levels.map((l) => l.error),
        lodDistance,
        height,
        camera.fov,
        info.lod?.maxPixelError ?? 1,
        scale,
      );
      shown = Math.max(shown, level);
      mesh.geometry.setIndex(levels[level]?.index ?? null);
      triangles += (levels[level]?.index.count ?? 0) / 3;
    }
    readout.textContent = `${lodDistance} m → LOD ${shown} · ${Math.round(triangles).toLocaleString()} triangles`;
    host.invalidate();
  };
  const lodRow = host.el("label", "grid gap-1 text-xs text-muted", "Auto-LOD distance");
  const slider = host.el("input", "accent-accent");
  slider.type = "range";
  slider.name = "lod-distance";
  slider.min = "2";
  slider.max = "80";
  slider.step = "1";
  slider.value = "2";
  slider.setAttribute("aria-label", "Auto-LOD distance (m)");
  slider.oninput = () => {
    lodDistance = Number(slider.value);
    setLod();
  };
  lodRow.append(slider, readout);
  lodRow.hidden = true;

  const toggles = host.el("div", "flex flex-wrap gap-1");
  const pill = (label: string, on: boolean, apply: (on: boolean) => void) => {
    const b = host.el(
      "button",
      "rounded border border-line px-2 py-0.5 text-xs text-ink aria-pressed:border-accent aria-pressed:text-accent",
      label,
    );
    b.setAttribute("aria-pressed", String(on));
    b.onclick = () => {
      const next = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(next));
      apply(next);
    };
    toggles.append(b);
    return b;
  };
  const rebuildHelpers = (normals: boolean, bounds: boolean) => {
    for (const helper of [...helpers.children]) {
      helpers.remove(helper);
      (helper as three.LineSegments).geometry?.dispose();
    }
    gltf.scene.updateMatrixWorld(true);
    if (bounds)
      helpers.add(new three.Box3Helper(new three.Box3().setFromObject(gltf.scene), 0xe0fb50));
    if (normals) {
      const size = new three.Box3().setFromObject(gltf.scene).getSize(new three.Vector3()).length();
      gltf.scene.traverse((node) => {
        if ((node as three.Mesh).isMesh && !(node as three.SkinnedMesh).isSkinnedMesh)
          helpers.add(new VertexNormalsHelper(node, size * 0.02, 0x37d5d3));
      });
    }
    host.invalidate();
  };
  const flags = { normals: false, bounds: false };
  pill("Normals", false, (on) => {
    flags.normals = on;
    rebuildHelpers(on, flags.bounds);
  });
  pill("Bounds", false, (on) => {
    flags.bounds = on;
    rebuildHelpers(flags.normals, on);
  });
  const cookedPill = info.cooked
    ? pill("Cooked", false, (on) => {
        cooked = on;
        void swap();
      })
    : undefined;
  if (cookedPill) cookedPill.title = "Raw source in assets/ vs the cooked file in public/";
  overlay.append(toggles, lodRow);

  let animation: ReturnType<typeof animationPanel> | undefined;
  const swap = async () => {
    const next = await host.loader.loadAsync(fileUrl(host, file, cooked));
    animation?.leave();
    root.remove(gltf.scene);
    gltf = next;
    root.add(gltf.scene);
    dress(gltf.scene, host.wire);
    lods = cooked ? await lodMeshes(gltf) : [];
    lodRow.hidden = lods.length === 0;
    setLod();
    rebuildHelpers(flags.normals, flags.bounds);
    animation = gltf.animations.length ? animationPanel(host, gltf, info) : undefined;
    renderDocs(host, element, info, gltf, cooked);
    host.say(
      `${element.name} · ${cooked ? "cooked" : "raw"} · ${trianglesOf(gltf.scene).toLocaleString()} triangles`,
    );
  };
  dress(gltf.scene, host.wire);
  animation = gltf.animations.length ? animationPanel(host, gltf, info) : undefined;
  renderDocs(host, element, info, gltf, cooked);
  host.use({
    leave: () => animation?.leave(),
    tick: (dt) => animation?.tick(dt),
    playing: () => animation?.playing() ?? false,
    wireframe: (on) => dress(gltf.scene, on),
  });
  return {
    model: root,
    report: reportOf(gltf.scene, Math.round(performance.now() - started), file),
  };
}

function dress(root: three.Object3D, wire: boolean): void {
  root.traverse((node) => {
    const mesh = node as three.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = mesh.receiveShadow = true;
    for (const material of [mesh.material].flat() as three.MeshStandardMaterial[])
      material.wireframe = wire;
  });
}

function renderDocs(
  host: IViewerBase,
  element: IAssetElement,
  info: IModelInfo,
  gltf: GLTF,
  cooked: boolean,
): void {
  const { inspection, raw } = info;
  const size = inspection.bounds.size;
  const triangles = trianglesOf(gltf.scene);
  const rows: [string, string][] = [
    ["Showing", cooked ? "cooked (public/)" : "raw (assets/)"],
    ["Triangles", triangles.toLocaleString()],
    ["Size (m)", `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`],
    ["Units", inspection.units.label],
    [
      "Meshes · materials · textures",
      `${inspection.meshes} · ${inspection.materials} · ${inspection.textures}`,
    ],
    ["Raw file", `${mb(raw.bytes)}${raw.vram ? ` · ~${mb(raw.vram)} VRAM` : ""}`],
  ];
  if (info.cooked)
    rows.push(
      [
        "Cooked file",
        `${mb(info.cooked.bytes)} (${Math.round((100 * info.cooked.bytes) / Math.max(1, raw.bytes))}%)${info.cooked.vram ? ` · ~${mb(info.cooked.vram)} VRAM` : ""}`,
      ],
      ["Cooked triangles", info.cooked.triangles?.toLocaleString() ?? "—"],
      ["Texture slots", String(info.cooked.textures ?? inspection.textures)],
      ["Target profile", info.cooked.targets?.join(", ") || info.cooked.format || "—"],
    );
  else rows.push(["Cooked file", "not cooked yet (run pnpm dev)"]);
  if (info.lod)
    rows.push(["Cooked LODs", `${info.lod.levels} levels · ${info.lod.maxPixelError} px budget`]);
  if (gltf.animations.length)
    rows.push(["Clips", gltf.animations.map((clip) => clip.name).join(", ")]);
  if (inspection.bones.length) rows.push(["Bones", String(inspection.bones.length)]);
  if (info.animLog) rows.push(["Op log", `${info.animLog.path} · ${info.animLog.ops} ops`]);
  host.rowsInto(host.stats, rows);
  const name = info.path.replace(/^assets\//u, "");
  const snippet = `const model = await ctx.assets.model(${JSON.stringify(name)});\nscene.add(model.scene);`;
  const head = host.el("h2", "text-xl font-extrabold text-white", element.name);
  const badges = host.el("ul", "grid gap-1");
  for (const badge of info.health)
    badges.append(host.el("li", BADGE[badge.level], `● ${badge.text}`));
  host.docs.replaceChildren(
    head,
    host.el("p", "text-muted", info.path),
    badges,
    host.el(
      "pre",
      "whitespace-pre-wrap rounded border border-line bg-sidebar p-3 font-mono text-xs",
      snippet,
    ),
    host.copyButton("Copy snippet", () => snippet),
    host.el("h3", "font-bold text-muted", "Hierarchy"),
    hierarchy(host, gltf.scene),
  );
}

// ── the contact sheet: Front / Side / Back / ¾ Iso, plus Wireframe and the 1.8 m figure ──
const ANGLES: readonly {
  label: string;
  yaw: number;
  pitch: number;
  wire?: boolean;
  figure?: boolean;
}[] = [
  { label: "Front", yaw: 0, pitch: 8 },
  { label: "Side", yaw: 90, pitch: 8 },
  { label: "Back", yaw: 180, pitch: 8 },
  { label: "¾ Iso", yaw: 35, pitch: 28 },
  { label: "Wireframe", yaw: 35, pitch: 28, wire: true },
  { label: "1.8 m figure", yaw: 35, pitch: 18, figure: true },
];

function turntable(host: IViewerHost, mode: string, render: () => void): HTMLCanvasElement {
  const { camera, content, figure, renderer } = host.view;
  const cells = new URLSearchParams(location.search).get("cells") === "4" ? 4 : 6;
  const columns = cells === 4 ? 2 : 3;
  const source = renderer.domElement;
  const width = source.width;
  const height = source.height;
  const sheet = document.createElement("canvas");
  sheet.width = width * columns;
  sheet.height = height * 2;
  const ctx = sheet.getContext("2d") as CanvasRenderingContext2D;
  const box = new three.Box3().setFromObject(content);
  const sphere = box.isEmpty()
    ? new three.Sphere(new three.Vector3(), 1)
    : box.getBoundingSphere(new three.Sphere());
  const fit = (sphere.radius / Math.sin(three.MathUtils.degToRad(camera.fov / 2))) * 1.05;
  const saved = { position: camera.position.clone(), figure: figure.visible };
  const materials: three.MeshStandardMaterial[] = [];
  content.traverse((node) => {
    if ((node as three.Mesh).isMesh)
      materials.push(...([(node as three.Mesh).material].flat() as three.MeshStandardMaterial[]));
  });
  for (const [i, angle] of ANGLES.slice(0, cells).entries()) {
    const yaw = three.MathUtils.degToRad(angle.yaw);
    const pitch = three.MathUtils.degToRad(angle.pitch);
    camera.position
      .set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
      .multiplyScalar(fit * (angle.figure ? 1.25 : 1))
      .add(sphere.center);
    camera.lookAt(sphere.center);
    figure.visible = angle.figure === true;
    if (angle.figure)
      figure.position.set(sphere.center.x + sphere.radius + 0.5, 0, sphere.center.z);
    for (const material of materials) material.wireframe = angle.wire === true;
    render();
    const x = (i % columns) * width;
    const y = Math.floor(i / columns) * height;
    ctx.drawImage(source, x, y, width, height);
    ctx.fillStyle = "rgba(2,4,7,0.72)";
    ctx.fillRect(x + 8, y + 8, Math.max(120, angle.label.length * 13), 30);
    ctx.fillStyle = "#e0fb50";
    ctx.font = `bold ${Math.round(18 * Math.max(1, width / 900))}px sans-serif`;
    ctx.fillText(angle.label, x + 16, y + 30);
  }
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "14px sans-serif";
  ctx.fillText(`${document.title} · ${mode} · ${location.hash}`, 12, sheet.height - 12);
  for (const material of materials) material.wireframe = host.wire;
  camera.position.copy(saved.position);
  figure.visible = saved.figure;
  host.frame();
  render();
  return sheet;
}
