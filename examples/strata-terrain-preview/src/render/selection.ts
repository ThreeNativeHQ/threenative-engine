import type { ICtx } from "@threenative/core";
import type { IPlacementOverride, Layer } from "@threenative/terrain";
import {
  type TerrainEditorController,
  createEditorSelection,
  editorPlacementCenter,
  editorPointToClient,
  landformPose,
} from "@threenative/terrain/editor";
import type { IEditorSnapshot } from "@threenative/terrain/editor/server";
import { BufferGeometry, Line, LineBasicMaterial, Mesh, Object3D, Vector3 } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  type IPropInstance,
  type PropGroundQuery,
  preparePropTransform,
  readPropTransform,
  writePropTransform,
} from "./props.js";

export function createPropSelection(
  ctx: Pick<ICtx, "camera" | "add" | "renderer" | "scene">,
  orbit: OrbitControls,
  controller: TerrainEditorController,
  instances: () => Map<string, IPropInstance> | undefined,
  ground: () => PropGroundQuery | undefined,
  pick: (x: number, y: number) => string | undefined,
  surface: (x: number, z: number) => number | undefined,
  focusTarget: (target: { kind: "prop" | "region"; id: string }) => { diagnostic: string | null },
) {
  const proxy = ctx.add(new Object3D());
  const footprint = ctx.add(
    new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0xffd66b, depthTest: false })),
  );
  footprint.visible = false; // engine-override: selection overlay follows a recipe, not a rendered solid.

  const gizmo = new TransformControls(ctx.camera, ctx.renderer.domElement);
  gizmo.setSize(0.8);
  ctx.add(gizmo.getHelper());
  const sidebar = document.querySelector<HTMLElement>(".right-sidebar");
  if (!sidebar) throw new Error("Placement inspector sidebar missing");
  const panel = document.createElement("section");
  panel.id = "placement-inspector";
  panel.className = "inspector";
  panel.style.display = "none";
  panel.innerHTML = `<h3>Individual placement</h3>
    <label class="field-label">Object list<select aria-label="Placement" id="placement-list"></select></label>
    <div class="segmented">${["translate", "rotate", "scale"].map((mode) => `<button type="button" data-transform-mode="${mode}">${mode}</button>`).join("")}</div>
    <button type="button" id="placement-focus" class="full">Focus selection</button>
    <form id="placement-form">${["Position (m)", "Rotation (degrees, XYZ)", "Scale"].map((label, group) => `<fieldset><legend>${label}</legend><div class="transform-vector">${["X", "Y", "Z"].map((axis, index) => `<label>${axis}<input aria-label="${label} ${axis}" type="number" step="any" required data-transform-group="${group}" data-axis="${index}"></label>`).join("")}</div></fieldset>`).join("")}
    <label id="placement-grounding-label" class="field-label"><span><input id="placement-grounding" type="checkbox"> Ground to terrain</span></label>
    <p id="placement-clearance" class="small muted"></p>
    <button class="secondary full" type="submit">Apply transform</button></form>
    <div class="segmented"><button type="button" id="placement-reset">Reset</button><button type="button" id="placement-undo">Undo transform</button></div>
    <p class="small muted">Y translation disables grounding. Escape cancels the current drag. XYZ rotations apply to props.</p>
    <div id="placement-orphans"></div><p id="placement-status" class="small muted"></p>`;
  const style = document.createElement("style");
  style.textContent =
    "#placement-inspector [hidden]{display:none!important}body[data-terrain-tool=select] .brush-section>.slider-label,body[data-terrain-tool=select] .brush-section>input[type=range],body[data-terrain-tool=select] .brush-section>.advanced{display:none}.right-sidebar[data-selecting=true]>.inspector:not(#placement-inspector){display:none}.right-sidebar[data-selecting=true]>.layer-list{flex:none;max-height:170px}#placement-inspector{overflow-y:auto;min-height:0;flex:1}#placement-inspector h3{margin-bottom:12px}#placement-inspector fieldset{border:0;padding:0;margin:0 0 12px}#placement-inspector legend{font-size:10px;margin-bottom:6px}.transform-vector{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.transform-vector label{font-size:10px}.transform-vector input{width:100%}#placement-status{margin-top:10px;overflow-wrap:anywhere}";
  document.head.append(style);
  sidebar.insertBefore(panel, sidebar.querySelector(".inspector"));
  function control<T extends HTMLElement>(selector: string): T {
    const element = panel.querySelector<T>(selector);
    if (!element) throw new Error(`Placement inspector control missing: ${selector}`);
    return element;
  }
  const list = control<HTMLSelectElement>("#placement-list");
  const form = control<HTMLFormElement>("#placement-form");
  const grounding = control<HTMLInputElement>("#placement-grounding");
  const status = control<HTMLElement>("#placement-status");
  const clearance = control<HTMLElement>("#placement-clearance");
  const orphans = control<HTMLElement>("#placement-orphans");
  const title = control<HTMLElement>("h3");
  const scaleLegend = control<HTMLElement>("fieldset:nth-of-type(3) legend");
  const groundingLabel = control<HTMLElement>("#placement-grounding-label");
  const fields = [...form.querySelectorAll<HTMLInputElement>("[data-transform-group]")];
  const abort = new AbortController();
  const selection = createEditorSelection({
    gizmo,
    proxy,
    controller,
    surface,
    refreshPose,
    drawFootprint,
    message,
    defaultFootprintSize: 120,
    grounding: () => grounding.checked,
    setSaving: (value) => {
      form.inert = value;
    },
    selectedChanged: (id, isLayer) => {
      list.value = id ? `${isLayer ? "landform" : "placement"}:${id}` : "";
    },
    setNavigation: (value) => {
      orbit.enabled = value;
    },
    restorePlacement(id, value) {
      const instance = instances()?.get(id);
      const query = ground();
      if (instance && query)
        writePropTransform(instance, preparePropTransform(instance, value, query));
    },
    previewPlacement(id, value) {
      const instance = instances()?.get(id);
      const query = ground();
      if (!instance || !query) throw new Error("Selected placement is unavailable");
      writePropTransform(instance, preparePropTransform(instance, value, query));
    },
  });
  function center(id: string): Vector3 | undefined {
    const instance = instances()?.get(id);
    if (!instance) return undefined;
    const pose = readPropTransform(instance);
    instance.geometry.computeBoundingSphere();
    const point = instance.geometry.boundingSphere?.center.clone() ?? new Vector3();
    return editorPlacementCenter(point, pose);
  }
  function pixel(point: Vector3): [number, number] {
    return editorPointToClient(point, ctx.camera, ctx.renderer.domElement.getBoundingClientRect());
  }
  /** One framing path: the validated focus operation the camera panel and a controller share. */
  function focus(target: { kind: "prop" | "region"; id: string }): { diagnostic: string | null } {
    return focusTarget(target);
  }
  function message(text: string): void {
    status.textContent = text;
  }
  function drawFootprint(layer: Layer): void {
    const pose = landformPose(layer, selection.snapshot?.document.recipe.config.size ?? 0, 120);
    if (!pose) return;
    const vertices = pose.rectangular
      ? [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]
      : Array.from({ length: 64 }, (_, i) => [
          Math.cos((i * Math.PI) / 32),
          Math.sin((i * Math.PI) / 32),
        ]);
    const points = vertices.map(([x, z]) => {
      const point = new Vector3(
        (x ?? 0) * pose.scale[0],
        0,
        (z ?? 0) * pose.scale[2],
      ).applyQuaternion(pose.quaternion);
      point.x += pose.position[0];
      point.z += pose.position[2];
      point.y = (surface(point.x, point.z) ?? proxy.position.y) + 0.5;
      return point;
    });
    footprint.geometry.dispose();
    if (points[0]) points.push(points[0].clone());
    footprint.geometry = new BufferGeometry().setFromPoints(points);
    footprint.visible = selection.active;
  }
  function refreshPose(): void {
    const layer = selection.snapshot?.document.recipe.layers.find(
      (l) => l.id === selection.selectedLayer,
    );
    const landformTransform = layer
      ? landformPose(layer, selection.snapshot?.document.recipe.config.size ?? 0, 120)
      : undefined;
    const landform = !!landformTransform && !!layer;
    title.textContent = landform ? "Recipe landform" : "Individual placement";
    scaleLegend.textContent = landform ? "Half-extents X/Z (m), vertical gain Y" : "Scale";
    groundingLabel.hidden = landform;
    control<HTMLButtonElement>("#placement-reset").hidden = landform;
    fields.forEach((input, i) => {
      input.disabled = landform && (i === 3 || i === 5);
    });
    if (landform) {
      form.hidden = false;
      const values = selection.applyPose(layer);
      if (!values) throw new Error("Missing landform pose");
      fields.forEach((input, i) => {
        const value = values[i];
        if (value === undefined) throw new Error("Landform field mismatch");
        input.value = String(Number(value.toFixed(6)));
      });
      clearance.textContent =
        "Y position is recipe offset (m). Y scale is vertical gain. X/Z rotation disabled: heightfields cannot overhang. Terrain rebuilds on commit; the line marks the recipe footprint.";
      drawFootprint(layer);
      return;
    }
    footprint.visible = false; // engine-override: no landform is selected.

    const instance = selection.selected ? instances()?.get(selection.selected) : undefined;
    form.hidden = !instance;
    if (!instance) {
      selection.applyPose();
      clearance.textContent = selection.selected
        ? "Placement no longer evaluates; override retained."
        : "Select a prop.";
      return;
    }
    const pose = readPropTransform(instance);
    const values = selection.applyPose(undefined, pose);
    if (!values) throw new Error("Missing placement pose");
    fields.forEach((input, index) => {
      const value = values[index];
      if (value === undefined) throw new Error("Placement transform field mismatch");
      input.value = String(Number(value.toFixed(6)));
    });
    grounding.checked = pose.grounding;
    clearance.textContent = `Measured clearance: ${instance.clearance === null ? "unknown (outside terrain)" : `${instance.clearance.toFixed(4)} m`} · grounding ${pose.grounding ? "on" : "overridden"}`;
  }
  panel.addEventListener(
    "click",
    (event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>("button");
      const mode = target?.dataset.transformMode;
      if (mode === "translate" || mode === "rotate" || mode === "scale") {
        gizmo.setMode(mode);
        refreshPose();
        for (const button of panel.querySelectorAll<HTMLElement>("[data-transform-mode]"))
          button.classList.toggle("active", button.dataset.transformMode === mode);
      }
      if (target?.id === "placement-reset" && selection.selected)
        void selection.save(selection.selected, undefined);
      if (target?.id === "placement-focus") {
        if (selection.selectedLayer)
          message(focus({ kind: "region", id: selection.selectedLayer }).diagnostic ?? "");
        else if (selection.selected)
          message(focus({ kind: "prop", id: selection.selected }).diagnostic ?? "");
      }
      if (target?.id === "placement-undo")
        void selection.undo().catch((error) => message(String(error)));
    },
    { signal: abort.signal },
  );
  list.addEventListener(
    "change",
    () => {
      const isLayer = list.value.startsWith("landform:");
      selection.select(list.value ? list.value.slice(isLayer ? 9 : 10) : undefined, isLayer);
    },
    { signal: abort.signal },
  );
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      selection.applyFields(
        fields.map((field) => Number(field.value)),
        grounding.checked,
      );
    },
    { signal: abort.signal },
  );
  form.addEventListener(
    "input",
    () => {
      selection.clearDrafts();
    },
    { signal: abort.signal },
  );
  ctx.renderer.domElement.addEventListener(
    "pointerdown",
    (event) => {
      if (!selection.canPick(event)) return;
      selection.select(pick(event.clientX, event.clientY));
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !selection.active ||
        (event.key !== "Escape" &&
          ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as Element).tagName))
      )
        return;
      if (event.key === "Escape") {
        selection.cancel();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void selection.undo().catch((error) => message(String(error)));
      }
    },
    { signal: abort.signal },
  );
  return {
    selectLayer: selection.selectLayer,
    setActive(enabled: boolean): void {
      sidebar.dataset.selecting = String(enabled);
      panel.style.display = enabled ? "block" : "none";
      if (!enabled) footprint.visible = false; // engine-override: selection tooling is inactive.
      selection.setActive(enabled);
    },
    sync: selection.sync,
    refresh(): void {
      const entries = [...(instances()?.values() ?? [])];
      list.replaceChildren(
        new Option("Select a placement or landform", ""),
        ...(selection.snapshot?.document.recipe.layers
          .filter((layer) => ["stamp", "paste", "heightmap"].includes(layer.type))
          .map(
            (layer) => new Option(`Landform · ${layer.name ?? layer.id}`, `landform:${layer.id}`),
          ) ?? []),
        ...entries.map(
          (entry) =>
            new Option(
              `${entry.placement.asset} · ${entry.placement.id}`,
              `placement:${entry.placement.id}`,
            ),
        ),
      );
      list.value = selection.selectedLayer
        ? `landform:${selection.selectedLayer}`
        : selection.selected
          ? `placement:${selection.selected}`
          : "";
      orphans.replaceChildren();
      for (const id of Object.keys(selection.snapshot?.document.placementOverrides ?? {})) {
        if (instances()?.has(id)) continue;
        const row = document.createElement("div");
        const label = document.createElement("p");
        label.textContent = `Unmatched override: ${id}`;
        const remove = document.createElement("button");
        remove.textContent = "Remove override";
        remove.onclick = () => {
          void selection.save(id, undefined);
        };
        const reassign = document.createElement("button");
        reassign.textContent = "Reassign to selected";
        reassign.onclick = () => {
          void selection.reassign(id);
        };
        row.append(label, remove, reassign);
        orphans.append(row);
      }
      if (!selection.drag && !selection.saving) refreshPose();
    },
    inspect() {
      return {
        selected: selection.selected,
        selectedLayer: selection.selectedLayer,
        landformDraft: selection.layerDraft,
        footprintVisible: footprint.visible,
        rotationAxes: { x: gizmo.showX, y: gizmo.showY, z: gizmo.showZ },
        mode: gizmo.getMode(),
        dragging: gizmo.dragging,
        orbitEnabled: orbit.enabled,
        draft: selection.draft,
        saving: selection.saving,
        axis: gizmo.axis,
      };
    },
    project(id: string): [number, number] | undefined {
      const at = center(id);
      return at ? pixel(at) : undefined;
    },
    handles(): { axis: string; at: [number, number] }[] {
      const result: { axis: string; at: [number, number] }[] = [];
      const helper = gizmo.getHelper();
      helper.updateMatrixWorld(true);
      helper.traverseVisible((object) => {
        if (!(object instanceof Mesh) || !["X", "Y", "Z"].includes(object.name)) return;
        object.geometry.computeBoundingBox();
        const at = object.geometry.boundingBox?.getCenter(new Vector3());
        if (at) result.push({ axis: object.name, at: pixel(at.applyMatrix4(object.matrixWorld)) });
        const positions = object.geometry.getAttribute("position");
        for (
          let index = 0;
          index < positions.count;
          index += Math.max(1, Math.floor(positions.count / 8))
        ) {
          const vertex = new Vector3()
            .fromBufferAttribute(positions, index)
            .applyMatrix4(object.matrixWorld);
          result.push({ axis: object.name, at: pixel(vertex) });
        }
      });
      return result;
    },
    dispose(): void {
      abort.abort();
      selection.dispose();
      gizmo.dispose();
      ctx.scene.remove(proxy, gizmo.getHelper(), footprint);
      footprint.geometry.dispose();
      footprint.material.dispose();
      panel.remove();
      style.remove();
      orbit.enabled = true;
    },
  };
}
