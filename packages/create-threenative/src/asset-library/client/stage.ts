// The Scene & Diorama Bundler: place project models with a gizmo, then write the composition out as
// ordinary game source (`src/scenes/<name>.ts`) or one merged static `.glb` under `assets/bundles/`.
// No scene format: the staging list lives in this tab only (and localStorage), never in the game.
import * as three from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { IAssetElement } from "../types.js";
import { type IViewerHost, type IViewerMode, fileUrl, getJson, mb } from "./viewers.js";

/** One placed model. Transforms are world-space and metric. */
export interface IStagedItem {
  readonly path: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

interface IBundleResult {
  readonly written: string;
  readonly report: {
    readonly drawCalls: number;
    readonly triangles: number;
    readonly materials: number;
    readonly textures: number;
    readonly bytes?: number;
    readonly bounds: { readonly min: number[]; readonly max: number[] };
  };
}

const STORE = "tn-asset-library:stage";

export async function stageView(_element: IAssetElement, host: IViewerHost): Promise<IViewerMode> {
  const { camera, renderer, scene, content } = host.view;
  const group = new three.Group();
  group.name = "stage";
  content.add(group);
  const nodes: { item: IStagedItem; object: three.Object3D }[] = [];
  const gizmo = new TransformControls(camera, renderer.domElement);
  const helper = gizmo.getHelper();
  scene.add(helper);
  gizmo.addEventListener("dragging-changed", (event) => {
    host.orbit.enabled = !event.value;
  });
  gizmo.addEventListener("objectChange", () => {
    sync();
    host.invalidate();
  });
  let selected: (typeof nodes)[number] | undefined;
  let snap = true;
  const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}") as {
    name?: string;
    items?: IStagedItem[];
  };
  const models = host.catalog.elements.filter((e) => e.kind === "model");

  // ── panel ──
  const panel = host.overlay(
    "top-2 left-2 grid max-h-[calc(100%-4rem)] w-72 gap-2 overflow-y-auto rounded border border-line bg-app/92 p-2 text-xs",
  );
  const name = host.el("input", "field");
  name.name = "bundle-name";
  name.setAttribute("aria-label", "Bundle name");
  name.value = saved.name ?? "diorama";
  const pick = host.el("select", "field");
  pick.name = "add-model";
  pick.setAttribute("aria-label", "Model to add");
  for (const model of models)
    pick.append(new Option(model.path ?? model.id, model.path ?? model.id));
  const button = (label: string, onClick: () => void | Promise<void>, title = label) => {
    const b = host.el(
      "button",
      "rounded border border-line px-2 py-1 text-ink hover:border-accent",
      label,
    );
    b.title = title;
    b.onclick = () => void onClick();
    return b;
  };
  const list = host.el("ol", "grid gap-0.5");
  const result = host.el("div", "text-muted");
  const tools = host.el("div", "flex flex-wrap gap-1");
  const modes = (["translate", "rotate", "scale"] as const).map((mode) =>
    button(mode, () => {
      gizmo.setMode(mode);
      for (const b of modes) b.classList.toggle("border-accent", b.textContent === mode);
    }),
  );
  modes[0]?.classList.add("border-accent");
  const snapButton = button("snap 0.5 m · 15°", () => {
    snap = !snap;
    applySnap();
  });
  tools.append(
    ...modes,
    snapButton,
    button("floor", () => floor(), "Set the selected model's lowest point on y = 0"),
    button("duplicate", () => duplicate()),
    button("delete", () => remove()),
  );
  const views = host.el("div", "flex flex-wrap gap-1");
  for (const [label, yaw, pitch] of [
    ["front", 0, 10],
    ["side", 90, 10],
    ["top", 0, 89],
    ["iso", 40, 32],
  ] as const)
    views.append(button(label, () => framing(yaw, pitch)));
  const outputs = host.el("div", "grid gap-1");
  outputs.append(
    button("Save scene module (src/scenes/<name>.ts)", () => save("ts")),
    button("Save merged GLB (assets/bundles/<name>.glb)", () => save("glb")),
    host.copyButton("Copy scene snippet", () => snippet()),
  );
  panel.append(
    host.el("div", "font-bold text-white", "Scene Bundler"),
    name,
    pick,
    button("Add model", () =>
      add(
        { path: pick.value, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        true,
      ),
    ),
    tools,
    views,
    host.el("div", "font-bold text-muted", "Hierarchy"),
    list,
    outputs,
    result,
  );

  function applySnap(): void {
    gizmo.setTranslationSnap(snap ? 0.5 : null);
    gizmo.setRotationSnap(snap ? three.MathUtils.degToRad(15) : null);
    gizmo.setScaleSnap(snap ? 0.1 : null);
    snapButton.classList.toggle("border-accent", snap);
  }
  applySnap();

  function sync(): void {
    for (const node of nodes) {
      node.item.position = node.object.position.toArray() as IStagedItem["position"];
      node.item.quaternion = node.object.quaternion.toArray() as IStagedItem["quaternion"];
      node.item.scale = node.object.scale.toArray() as IStagedItem["scale"];
    }
    localStorage.setItem(
      STORE,
      JSON.stringify({ name: name.value, items: nodes.map((n) => n.item) }),
    );
    renderList();
  }
  name.onchange = sync;

  function renderList(): void {
    list.replaceChildren(
      ...nodes.map((node, i) => {
        const li = host.el(
          "li",
          `cursor-pointer truncate rounded px-1 ${node === selected ? "bg-accent text-accent-ink" : "hover:bg-hover"}`,
          `${i + 1}. ${node.item.path.split("/").pop()} @ ${node.item.position.map((v) => v.toFixed(1)).join(", ")}`,
        );
        li.onclick = () => select(node);
        return li;
      }),
    );
    status();
    host.rowsInto(host.stats, [
      ["Staged models", String(nodes.length)],
      ["Triangles", nodes.reduce((n, node) => n + trianglesIn(node.object), 0).toLocaleString()],
    ]);
  }

  function select(node: (typeof nodes)[number] | undefined): void {
    selected = node;
    if (node) gizmo.attach(node.object);
    else gizmo.detach();
    renderList();
    host.invalidate();
  }

  async function add(item: IStagedItem, focus: boolean): Promise<void> {
    if (!item.path) return;
    const gltf = await host.loader.loadAsync(fileUrl(host, item.path));
    const object = gltf.scene;
    object.position.fromArray(item.position);
    object.quaternion.fromArray(item.quaternion);
    object.scale.fromArray(item.scale);
    object.traverse((n) => {
      if ((n as three.Mesh).isMesh)
        (n as three.Mesh).castShadow = (n as three.Mesh).receiveShadow = true;
    });
    group.add(object);
    const node = { item: { ...item }, object };
    nodes.push(node);
    if (focus) {
      if (nodes.length > 1) object.position.x = new three.Box3().setFromObject(group).max.x + 1;
      floor(node);
      select(node);
      host.frame();
    }
    sync();
  }

  function floor(node = selected): void {
    if (!node) return;
    node.object.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(node.object);
    node.object.position.y -= box.min.y;
    sync();
    host.invalidate();
  }

  function duplicate(): void {
    if (!selected) return;
    const item = structuredClone(selected.item);
    item.position[0] += 1;
    void add(item, false).then(() => select(nodes.at(-1)));
  }

  function remove(): void {
    if (!selected) return;
    group.remove(selected.object);
    nodes.splice(nodes.indexOf(selected), 1);
    select(undefined);
    sync();
  }

  function framing(yaw: number, pitch: number): void {
    const box = new three.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new three.Sphere());
    const fit = sphere.radius / Math.sin(three.MathUtils.degToRad(camera.fov / 2));
    const y = three.MathUtils.degToRad(yaw);
    const p = three.MathUtils.degToRad(pitch);
    camera.position
      .set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p))
      .multiplyScalar(fit)
      .add(sphere.center);
    host.orbit.target.copy(sphere.center);
    camera.lookAt(sphere.center);
    host.invalidate();
  }

  function bundleBody(output: "ts" | "glb") {
    return {
      name: name.value.trim() || "diorama",
      output,
      items: nodes.map((n) => n.item),
      camera: { position: camera.position.toArray(), target: host.orbit.target.toArray() },
    };
  }

  function snippet(): string {
    const body = bundleBody("ts");
    return `// Written by the Asset Library Scene Bundler: save it as src/scenes/${body.name}.ts\n${JSON.stringify(body.items, null, 2)}`;
  }

  async function save(output: "ts" | "glb"): Promise<void> {
    if (!nodes.length) {
      host.say("Add a model to the stage first", true);
      return;
    }
    host.say(output === "ts" ? "Writing the scene module" : "Merging the GLB bundle");
    try {
      const done = await getJson<IBundleResult>(`${host.api}project/bundle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bundleBody(output)),
      });
      const { report } = done;
      result.textContent = `Wrote ${done.written} · ${report.drawCalls} draw calls · ${report.triangles.toLocaleString()} triangles · ${report.materials} materials · ${report.textures} textures${report.bytes ? ` · ${mb(report.bytes)}` : ""}`;
      host.say(`Wrote ${done.written}`);
    } catch (error) {
      host.say((error as Error).message, true);
    }
  }

  // Click a model to select it; a drag is the orbit's.
  const raycaster = new three.Raycaster();
  let down: { x: number; y: number } | undefined;
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || gizmo.dragging) return;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(
      new three.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster.intersectObject(group, true)[0]?.object;
    select(hit ? nodes.find((n) => n.object === hit || n.object.getObjectById(hit.id)) : undefined);
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);

  for (const item of saved.items ?? []) await add(item, false);
  renderList();
  host.docs.replaceChildren(
    host.el("h2", "text-xl font-extrabold text-white", "Scene Bundler"),
    host.el(
      "p",
      "text-muted",
      "Place project models, snap them to the grid and the floor, then save. The scene module is ordinary ThreeNative source that loads each model with ctx.assets.model and instances repeated props; the merged GLB is one static file with shared materials and textures deduplicated.",
    ),
  );
  function status(): void {
    const n = nodes.length;
    host.say(n ? `Stage · ${n} model${n === 1 ? "" : "s"}` : "Stage · add a model to begin");
  }
  status();
  return {
    leave() {
      gizmo.detach();
      gizmo.dispose();
      scene.remove(helper);
      host.orbit.enabled = true;
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
    },
  };
}

function trianglesIn(root: three.Object3D): number {
  let n = 0;
  root.traverse((node) => {
    const mesh = node as three.Mesh;
    if (mesh.isMesh)
      n += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(n);
}
