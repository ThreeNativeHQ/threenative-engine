import { Euler, type EventListener, type Object3D, Quaternion, Vector3 } from "three";
import type {
  TransformControls,
  TransformControlsEventMap,
} from "three/addons/controls/TransformControls.js";
import { validatePlacementOverrides } from "../core/placements.js";
import type { IPlacementOverride } from "../core/types.js";
import type { Layer } from "../core/types.js";
import type { TerrainEditorController } from "./index.js";
import { landformPose, transformedLandform } from "./landforms.js";
import type { IEditorSnapshot } from "./server.js";

/**
 * Gesture and transaction mechanics; the caller owns the controls, proxy and all rendering.
 * @requires npm i -D @threenative/terrain
 * @situation drive terrain-editor selection, gizmo drags, undo and saved transactions
 * @constraint the caller supplies the TransformControls, proxy, controller and every drawing callback
 * @example const selection = createEditorSelection({ gizmo, proxy, controller, grounding, surface, defaultFootprintSize, refreshPose, drawFootprint, restorePlacement, previewPlacement, setSaving, selectedChanged, setNavigation, message });
 */
export function createEditorSelection({
  gizmo,
  proxy,
  controller,
  grounding,
  surface,
  defaultFootprintSize,
  refreshPose,
  drawFootprint,
  restorePlacement,
  previewPlacement,
  setSaving,
  selectedChanged,
  setNavigation,
  message,
}: {
  gizmo: TransformControls;
  proxy: Object3D;
  controller: Pick<TerrainEditorController, "commit" | "snapshot">;
  grounding(): boolean;
  surface(x: number, z: number): number | undefined;
  defaultFootprintSize: number;
  refreshPose(): void;
  drawFootprint(layer: Layer): void;
  restorePlacement(id: string, value: IPlacementOverride | undefined): void;
  previewPlacement(id: string, value: IPlacementOverride): void;
  setSaving(value: boolean): void;
  selectedChanged(id: string | undefined, isLayer: boolean): void;
  setNavigation(value: boolean): void;
  message(text: string): void;
}) {
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
  function applyPose(layer?: Layer, placement?: IPlacementOverride) {
    const landform = layer
      ? landformPose(layer, snapshot?.document.recipe.config.size ?? 0, defaultFootprintSize)
      : undefined;
    gizmo.showX = !landform || gizmo.getMode() !== "rotate";
    gizmo.showZ = !landform || gizmo.getMode() !== "rotate";
    if (landform) {
      anchor = (surface(landform.position[0], landform.position[2]) ?? 0) - landform.position[1];
      proxy.position.fromArray(landform.position);
      proxy.position.y += anchor;
      proxy.quaternion.copy(landform.quaternion);
      proxy.scale.fromArray(landform.scale);
    } else if (placement) {
      proxy.position.fromArray(placement.position);
      proxy.quaternion.fromArray(placement.quaternion);
      proxy.scale.fromArray(placement.scale);
    } else {
      gizmo.detach();
      return;
    }
    proxy.updateMatrixWorld(true);
    if (active) gizmo.attach(proxy);
    const angles = new Euler().setFromQuaternion(proxy.quaternion, "XYZ");
    return landform
      ? [
          ...landform.position,
          0,
          (-2 * Math.atan2(landform.quaternion.y, landform.quaternion.w) * 180) / Math.PI,
          0,
          ...landform.scale,
        ]
      : [
          ...proxy.position.toArray(),
          ...[angles.x, angles.y, angles.z].map((v) => (v * 180) / Math.PI),
          ...proxy.scale.toArray(),
        ];
  }
  const listeners: (() => void)[] = [];
  function listen<K extends "dragging-changed" | "mouseDown" | "objectChange" | "mouseUp">(
    type: K,
    listener: EventListener<TransformControlsEventMap[K], K, TransformControls>,
  ) {
    gizmo.addEventListener(type, listener);
    listeners.push(() => gizmo.removeEventListener(type, listener));
  }
  function restore(): void {
    if (selectedLayer) {
      refreshPose();
      return;
    }
    if (selected) restorePlacement(selected, snapshot?.document.placementOverrides?.[selected]);
    refreshPose();
  }
  function preview(id: string, transform: IPlacementOverride): void {
    const value = validatePlacementOverrides({ [id]: transform })[id];
    if (!value) throw new Error("Selected placement is unavailable");
    previewPlacement(id, value);
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
    setSaving(true);
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
      setSaving(false);
      gizmo.enabled = active;
    }
  }
  async function saveLayer(layer: Layer, base = snapshot, remember = true): Promise<void> {
    if (saving || !base) return;
    saving = true;
    setSaving(true);
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
      setSaving(false);
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
    selectedChanged(id, isLayer);
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
  function applyFields(values: number[], grounded: boolean): void {
    if (selectedLayer && snapshot) {
      const layer = snapshot.document.recipe.layers.find((l) => l.id === selectedLayer);
      if (!layer) return;
      try {
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
      const position = values.slice(0, 3) as IPlacementOverride["position"];
      const rotation = values.slice(3, 6).map((v) => (v * Math.PI) / 180);
      const quaternion = new Quaternion()
        .setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ"))
        .toArray();
      const scale = values.slice(6, 9) as IPlacementOverride["scale"];
      const value =
        draft?.id === selected
          ? draft.transform
          : { position, quaternion, scale, grounding: grounded };
      preview(selected, value);
      void save(selected, value);
    } catch (error) {
      message(String(error));
    }
  }
  listen("dragging-changed", ({ value }) => {
    setNavigation(!value);
  });
  listen("mouseDown", () => {
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
      grounding: grounding() && !(gizmo.getMode() === "translate" && gizmo.axis?.includes("Y")),
    };
    cancelled = false;
  });
  listen("objectChange", () => {
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
  listen("mouseUp", () => {
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
  return {
    get snapshot() {
      return snapshot;
    },
    get selected() {
      return selected;
    },
    get selectedLayer() {
      return selectedLayer;
    },
    get anchor() {
      return anchor;
    },
    get layerDraft() {
      return layerDraft;
    },
    get active() {
      return active;
    },
    get drag() {
      return drag;
    },
    get saving() {
      return saving;
    },
    get draft() {
      return draft;
    },
    applyPose,
    save,
    select,
    undo,
    applyFields,
    async reassign(id: string): Promise<void> {
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
    },
    clearDrafts(): void {
      draft = undefined;
      layerDraft = undefined;
    },
    cancel(): void {
      cancelled = true;
      draft = undefined;
      layerDraft = undefined;
      gizmo.reset();
      restore();
      message("Drag cancelled · no transaction");
    },
    canPick(event: { button: number; altKey: boolean }): boolean {
      return active && event.button === 0 && !event.altKey && !gizmo.axis && !gizmo.dragging;
    },
    dispose(): void {
      for (const remove of listeners) remove();
    },
    selectLayer(id: string): void {
      const layer = snapshot?.document.recipe.layers.find((entry) => entry.id === id);
      if (
        active &&
        layer &&
        landformPose(layer, snapshot?.document.recipe.config.size ?? 0, defaultFootprintSize)
      )
        select(id, true);
    },
    setActive(enabled: boolean): void {
      active = enabled;
      gizmo.enabled = enabled;
      if (!enabled) {
        cancelled = true;
        draft = undefined;
        layerDraft = undefined;
        gizmo.pointerUp(null);
        gizmo.reset();
        restore();
        gizmo.detach();
        setNavigation(true);
      } else refreshPose();
    },
    sync(next: IEditorSnapshot, matchesPreview: boolean): void {
      snapshot = next;
      if (matchesPreview && !drag && !saving) restore();
    },
  };
}
