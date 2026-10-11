import type { ICtx } from "@threenative/core";
import {
  type IPlacementOverride,
  type Layer,
  validatePlacementOverrides,
} from "@threenative/terrain";
import type { TerrainEditorController } from "@threenative/terrain/editor";
import type { IEditorSnapshot } from "@threenative/terrain/editor/server";
import {
  BufferGeometry,
  Euler,
  Line,
  LineBasicMaterial,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector2,
  Vector3,
} from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { landformPose, transformedLandform } from "./landforms.js";
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
    <div id="placement-orphans"></div><p id="placement-status" role="status" aria-live="polite"></p>`;
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
  let snapshot: IEditorSnapshot | undefined;
  let selected: string | undefined;
  let selectedLayer: string | undefined;
  let anchor = 0;
  let layerDraft: Layer | undefined;
  let layerHistory: { before: Layer; after: Layer } | undefined;
  let active = false;
  let drag:
    | { id: string; base: IEditorSnapshot; grounding: boolean; layer?: Layer; anchor: number }
    | undefined;
  let cancelled = false;
  let saving = false;
  let draft: { id: string; transform: IPlacementOverride } | undefined;
  let history: { id: string; before?: IPlacementOverride; after?: IPlacementOverride } | undefined;
  function center(id: string): Vector3 | undefined {
    const instance = instances()?.get(id);
    if (!instance) return undefined;
    const pose = readPropTransform(instance);
    instance.mesh.geometry.computeBoundingSphere();
    const point = instance.mesh.geometry.boundingSphere?.center.clone() ?? new Vector3();
    return point
      .multiply(new Vector3().fromArray(pose.scale))
      .applyQuaternion(new Quaternion().fromArray(pose.quaternion))
      .add(new Vector3().fromArray(pose.position));
  }
  function pixel(point: Vector3): [number, number] {
    point.project(ctx.camera);
    const box = ctx.renderer.domElement.getBoundingClientRect();
    const value = new Vector2(
      ((point.x + 1) * box.width) / 2 + box.left,
      ((1 - point.y) * box.height) / 2 + box.top,
    );
    return [value.x, value.y];
  }
  /** One framing path: the validated focus operation the camera panel and a controller share. */
  function focus(target: { kind: "prop" | "region"; id: string }): { diagnostic: string | null } {
    return focusTarget(target);
  }
  function message(text: string): void {
    status.textContent = text;
  }
  function drawFootprint(layer: Layer): void {
    const pose = landformPose(layer, snapshot?.document.recipe.config.size ?? 0);
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
    footprint.visible = active;
  }
  function refreshPose(): void {
    const layer = snapshot?.document.recipe.layers.find((l) => l.id === selectedLayer);
    const landformTransform = layer
      ? landformPose(layer, snapshot?.document.recipe.config.size ?? 0)
      : undefined;
    const landform = !!landformTransform && !!layer;
    title.textContent = landform ? "Recipe landform" : "Individual placement";
    scaleLegend.textContent = landform ? "Half-extents X/Z (m), vertical gain Y" : "Scale";
    groundingLabel.hidden = landform;
    control<HTMLButtonElement>("#placement-reset").hidden = landform;
    fields.forEach((input, i) => {
      input.disabled = landform && (i === 3 || i === 5);
    });
    gizmo.showX = !landform || gizmo.getMode() !== "rotate";
    gizmo.showZ = !landform || gizmo.getMode() !== "rotate";
    if (landform) {
      form.hidden = false;
      anchor =
        (surface(landformTransform.position[0], landformTransform.position[2]) ?? 0) -
        landformTransform.position[1];
      proxy.position.fromArray(landformTransform.position);
      proxy.position.y += anchor;
      proxy.quaternion.copy(landformTransform.quaternion);
      proxy.scale.fromArray(landformTransform.scale);
      proxy.updateMatrixWorld(true);
      if (active) gizmo.attach(proxy);
      const values = [
        ...landformTransform.position,
        0,
        (-2 * Math.atan2(landformTransform.quaternion.y, landformTransform.quaternion.w) * 180) /
          Math.PI,
        0,
        ...landformTransform.scale,
      ];
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

    const instance = selected ? instances()?.get(selected) : undefined;
    form.hidden = !instance;
    if (!instance) {
      gizmo.detach();
      clearance.textContent = selected
        ? "Placement no longer evaluates; override retained."
        : "Select a prop.";
      return;
    }
    const pose = readPropTransform(instance);
    proxy.position.fromArray(pose.position);
    proxy.quaternion.fromArray(pose.quaternion);
    proxy.scale.fromArray(pose.scale);
    proxy.updateMatrixWorld(true);
    if (active) gizmo.attach(proxy);
    const angles = new Euler().setFromQuaternion(proxy.quaternion, "XYZ");
    const values = [
      ...pose.position,
      ...[angles.x, angles.y, angles.z].map((v) => (v * 180) / Math.PI),
      ...pose.scale,
    ];
    fields.forEach((input, index) => {
      const value = values[index];
      if (value === undefined) throw new Error("Placement transform field mismatch");
      input.value = String(Number(value.toFixed(6)));
    });
    grounding.checked = pose.grounding;
    clearance.textContent = `Measured clearance: ${instance.clearance === null ? "unknown (outside terrain)" : `${instance.clearance.toFixed(4)} m`} · grounding ${pose.grounding ? "on" : "overridden"}`;
  }
  function restore(): void {
    if (selectedLayer) {
      refreshPose();
      return;
    }
    const instance = selected ? instances()?.get(selected) : undefined;
    const query = ground();
    if (instance && query)
      writePropTransform(
        instance,
        preparePropTransform(
          instance,
          snapshot?.document.placementOverrides?.[instance.placement.id],
          query,
        ),
      );
    refreshPose();
  }
  function preview(id: string, transform: IPlacementOverride): void {
    const value = validatePlacementOverrides({ [id]: transform })[id];
    const instance = instances()?.get(id);
    const query = ground();
    if (!value || !instance || !query) throw new Error("Selected placement is unavailable");
    writePropTransform(instance, preparePropTransform(instance, value, query));
    draft = { id, transform: value };
    refreshPose();
  }
  async function save(
    id: string,
    value: IPlacementOverride | undefined,
    base = snapshot,
    remember = true,
  ): Promise<void> {
    if (saving || !base) {
      message("Wait for the current transform save.");
      return;
    }
    saving = true;
    form.inert = true;
    gizmo.enabled = false;
    const overrides = { ...base.document.placementOverrides };
    if (value) overrides[id] = value;
    else delete overrides[id];
    try {
      const next = await controller.commit({
        baseRevision: base.revision,
        document: { ...base.document, placementOverrides: overrides },
      });
      if (remember) {
        history = { id, before: base.document.placementOverrides?.[id], after: value };
        layerHistory = undefined;
      }
      if (!snapshot || snapshot.revision === base.revision || snapshot.revision === next.revision)
        snapshot = next;
      draft = undefined;
      restore();
      message(`Saved ${next.revision.slice(0, 8)} · one transform transaction`);
    } catch (error) {
      message(
        `${error instanceof Error ? error.message : String(error)} · draft retained; apply again to rebase explicitly.`,
      );
      try {
        snapshot = await controller.snapshot();
        restore();
      } catch {
        message("Connection interrupted · transform draft retained.");
      }
    } finally {
      saving = false;
      form.inert = false;
      gizmo.enabled = active;
    }
  }
  async function saveLayer(layer: Layer, base = snapshot, remember = true): Promise<void> {
    if (saving || !base) return;
    saving = true;
    form.inert = true;
    gizmo.enabled = false;
    try {
      const before = base.document.recipe.layers.find((l) => l.id === layer.id);
      const next = await controller.commit({
        baseRevision: base.revision,
        commands: [{ op: "upsert", layer }],
      });
      if (remember && before) {
        layerHistory = { before, after: layer };
        history = undefined;
      }
      if (!snapshot || snapshot.revision === base.revision || snapshot.revision === next.revision)
        snapshot = next;
      layerDraft = undefined;
      message(`Saved ${next.revision.slice(0, 8)} · one landform transaction`);
    } catch (error) {
      message(`${String(error)} · landform draft retained; apply again to rebase explicitly.`);
      snapshot = await controller.snapshot();
    } finally {
      saving = false;
      form.inert = false;
      gizmo.enabled = active;
      refreshPose();
    }
  }
  function select(id: string | undefined, isLayer = false): void {
    if (gizmo.dragging || saving) return;
    if (selected !== id) {
      restore();
      draft = undefined;
    }
    selectedLayer = isLayer ? id : undefined;
    selected = selectedLayer ? undefined : id;
    layerDraft = undefined;
    list.value = id ? `${isLayer ? "landform" : "placement"}:${id}` : "";
    refreshPose();
  }
  async function undo(): Promise<void> {
    if (saving) return;
    if (selectedLayer && layerHistory) {
      const entry = layerHistory;
      const current = await controller.snapshot();
      const layer = current.document.recipe.layers.find((l) => l.id === entry.after.id);
      const keys = ["at", "radius", "size", "rotation", "scale", "offset"];
      const after = entry.after.params as Record<string, unknown>;
      const before = entry.before.params as Record<string, unknown>;
      const params = { ...layer?.params } as Record<string, unknown>;
      if (
        !layer ||
        layer.type !== entry.after.type ||
        keys.some((key) => JSON.stringify(params[key]) !== JSON.stringify(after[key]))
      ) {
        message("Undo conflict: another actor changed this landform; their edit is retained.");
        return;
      }
      for (const key of keys) {
        if (before[key] === undefined) delete params[key];
        else params[key] = before[key];
      }
      await saveLayer({ ...layer, params } as Layer, current, false);
      if (!layerDraft) layerHistory = undefined;
      return;
    }
    if (!history) return;
    const entry = history;
    const current = await controller.snapshot();
    if (
      JSON.stringify(current.document.placementOverrides?.[entry.id]) !==
      JSON.stringify(entry.after)
    ) {
      message("Undo conflict: another actor changed this placement; their edit is retained.");
      return;
    }
    await save(entry.id, entry.before, current, false);
    if (!draft) history = undefined;
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
      if (target?.id === "placement-reset" && selected) void save(selected, undefined);
      if (target?.id === "placement-focus") {
        if (selectedLayer) message(focus({ kind: "region", id: selectedLayer }).diagnostic ?? "");
        else if (selected) message(focus({ kind: "prop", id: selected }).diagnostic ?? "");
      }
      if (target?.id === "placement-undo") void undo().catch((error) => message(String(error)));
    },
    { signal: abort.signal },
  );
  list.addEventListener(
    "change",
    () => {
      const isLayer = list.value.startsWith("landform:");
      select(list.value ? list.value.slice(isLayer ? 9 : 10) : undefined, isLayer);
    },
    { signal: abort.signal },
  );
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (selectedLayer && snapshot) {
        const layer = snapshot.document.recipe.layers.find((l) => l.id === selectedLayer);
        if (!layer) return;
        try {
          const values = fields.map((field) => Number(field.value));
          const [
            x = Number.NaN,
            y = Number.NaN,
            z = Number.NaN,
            ,
            ry = Number.NaN,
            ,
            sx = Number.NaN,
            sy = Number.NaN,
            sz = Number.NaN,
          ] = values;
          const position = new Vector3(x, y + anchor, z);
          const rotation = new Quaternion().setFromAxisAngle(
            new Vector3(0, 1, 0),
            (-ry * Math.PI) / 180,
          );
          const next = layerDraft
            ? ({
                ...layer,
                params: {
                  ...layer.params,
                  ...Object.fromEntries(
                    Object.entries(layerDraft.params).filter(([key]) =>
                      ["at", "radius", "size", "rotation", "scale", "offset"].includes(key),
                    ),
                  ),
                },
              } as Layer)
            : transformedLandform(layer, position, rotation, new Vector3(sx, sy, sz), anchor);
          layerDraft = next;
          void saveLayer(next);
        } catch (error) {
          message(String(error));
        }
        return;
      }
      if (!selected) return;
      try {
        const values = fields.map((field) => Number(field.value));
        const position = values.slice(0, 3) as IPlacementOverride["position"];
        const rotation = values.slice(3, 6).map((v) => (v * Math.PI) / 180);
        const quaternion = new Quaternion()
          .setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ"))
          .toArray();
        const scale = values.slice(6, 9) as IPlacementOverride["scale"];
        const value =
          draft?.id === selected
            ? draft.transform
            : { position, quaternion, scale, grounding: grounding.checked };
        preview(selected, value);
        void save(selected, value);
      } catch (error) {
        message(String(error));
      }
    },
    { signal: abort.signal },
  );
  form.addEventListener(
    "input",
    () => {
      draft = undefined;
      layerDraft = undefined;
    },
    { signal: abort.signal },
  );
  gizmo.addEventListener("dragging-changed", ({ value }) => {
    orbit.enabled = !value;
  });
  gizmo.addEventListener("mouseDown", () => {
    const id = selectedLayer ?? selected;
    if (!id || !snapshot || saving) {
      cancelled = true;
      gizmo.pointerUp(null);
      return;
    }
    if (selectedLayer && gizmo.getMode() === "rotate" && gizmo.axis !== "Y") {
      cancelled = true;
      gizmo.pointerUp(null);
      message("Only Y rotation is supported: a heightfield cannot overhang.");
      return;
    }
    drag = {
      id,
      base: snapshot,
      layer: snapshot.document.recipe.layers.find((l) => l.id === selectedLayer),
      anchor,
      grounding:
        grounding.checked && !(gizmo.getMode() === "translate" && gizmo.axis?.includes("Y")),
    };
    cancelled = false;
  });
  gizmo.addEventListener("objectChange", () => {
    if (!drag || cancelled) return;
    try {
      if (drag.layer) {
        layerDraft = transformedLandform(
          drag.layer,
          proxy.position,
          proxy.quaternion,
          proxy.scale,
          drag.anchor,
        );
        drawFootprint(layerDraft);
        return;
      }
      preview(drag.id, {
        position: proxy.position.toArray(),
        quaternion: proxy.quaternion.clone().normalize().toArray(),
        scale: proxy.scale.toArray(),
        grounding: drag.grounding,
      });
    } catch (error) {
      message(String(error));
      cancelled = true;
      restore();
    }
  });
  gizmo.addEventListener("mouseUp", () => {
    const gesture = drag;
    drag = undefined;
    if (!cancelled && gesture?.layer && layerDraft) {
      void saveLayer(layerDraft, gesture.base);
      return;
    }
    if (cancelled || !gesture || !draft) {
      restore();
      return;
    }
    void save(gesture.id, draft.transform, gesture.base);
  });
  ctx.renderer.domElement.addEventListener(
    "pointerdown",
    (event) => {
      if (!active || event.button !== 0 || event.altKey || gizmo.axis || gizmo.dragging) return;
      select(pick(event.clientX, event.clientY));
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!active || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as Element).tagName))
        return;
      if (event.key === "Escape") {
        cancelled = true;
        draft = undefined;
        layerDraft = undefined;
        gizmo.reset();
        restore();
        message("Drag cancelled · no transaction");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo().catch((error) => message(String(error)));
      }
    },
    { signal: abort.signal },
  );
  return {
    selectLayer(id: string): void {
      const layer = snapshot?.document.recipe.layers.find((entry) => entry.id === id);
      if (active && layer && landformPose(layer, snapshot?.document.recipe.config.size ?? 0))
        select(id, true);
    },
    setActive(enabled: boolean): void {
      active = enabled;
      sidebar.dataset.selecting = String(enabled);
      panel.style.display = enabled ? "block" : "none";
      gizmo.enabled = enabled;
      if (!enabled) {
        cancelled = true;
        draft = undefined;
        layerDraft = undefined;
        gizmo.pointerUp(null);
        footprint.visible = false; // engine-override: selection tooling is inactive.
        gizmo.reset();
        restore();
        gizmo.detach();
        orbit.enabled = true;
      } else refreshPose();
    },
    sync(next: IEditorSnapshot, matchesPreview: boolean): void {
      snapshot = next;
      if (matchesPreview && !drag && !saving) restore();
    },
    refresh(): void {
      const entries = [...(instances()?.values() ?? [])];
      list.replaceChildren(
        new Option("Select a placement or landform", ""),
        ...(snapshot?.document.recipe.layers
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
      list.value = selectedLayer
        ? `landform:${selectedLayer}`
        : selected
          ? `placement:${selected}`
          : "";
      orphans.replaceChildren();
      for (const id of Object.keys(snapshot?.document.placementOverrides ?? {})) {
        if (instances()?.has(id)) continue;
        const row = document.createElement("div");
        const label = document.createElement("p");
        label.textContent = `Unmatched override: ${id}`;
        const remove = document.createElement("button");
        remove.textContent = "Remove override";
        remove.onclick = () => {
          void save(id, undefined);
        };
        const reassign = document.createElement("button");
        reassign.textContent = "Reassign to selected";
        reassign.onclick = async () => {
          if (!selected || !snapshot || saving) return;
          const current = snapshot;
          const value = current.document.placementOverrides?.[id];
          if (!value || current.document.placementOverrides?.[selected]) {
            message("Choose a placement without an existing override.");
            return;
          }
          const overrides = { ...current.document.placementOverrides, [selected]: value };
          delete overrides[id];
          try {
            await controller.commit({
              baseRevision: current.revision,
              document: { ...current.document, placementOverrides: overrides },
            });
          } catch (error) {
            message(String(error));
          }
        };
        row.append(label, remove, reassign);
        orphans.append(row);
      }
      if (!drag && !saving) refreshPose();
    },
    inspect() {
      return {
        selected,
        selectedLayer,
        landformDraft: layerDraft,
        footprintVisible: footprint.visible,
        rotationAxes: { x: gizmo.showX, y: gizmo.showY, z: gizmo.showZ },
        mode: gizmo.getMode(),
        dragging: gizmo.dragging,
        orbitEnabled: orbit.enabled,
        draft,
        saving,
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
