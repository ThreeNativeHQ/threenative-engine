import {
  MATERIAL_IDS,
  Mask,
  Terrain,
  applyPlacementOverrides,
  bakeTerrain,
  decodeHeightPNG,
  decodeRAW16,
  makeExport,
} from "../../index.js";
import type { IAssetOperation } from "../assets.js";
import type { ICameraOperation, IFocusBounds, IFocusRequest, IFocusTarget } from "../cameras.js";
import type { IEnvironmentOperation } from "../environment.js";
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import type { ISpatialQuery } from "../spatialInspector.js";
import { inspectSpatial } from "../spatialInspector.js";
import { $, errorMessage } from "./dom.js";
import type { EditorSession } from "./session.js";

export function createEditorApi(c: EditorSession) {
  return {
    Terrain,
    Mask,
    get revision() {
      return c.revision;
    },
    get renderedRevision() {
      return c.renderedRevision;
    },
    get terrain() {
      return c.terrain;
    },
    get state() {
      return c.state;
    },
    get workerBusy() {
      return c.workerBusy;
    },
    get evaluationRequests() {
      return c.evaluationRequests;
    },
    get busy() {
      return c.busy;
    },
    get view() {
      return c.view;
    },
    rebuild: c.build,
    cancel: c.cancelBuild,
    // The same camera operations the GUI list and the controller endpoint use.
    cameras: {
      list: () => c.saved.document.cameras ?? [],
      active: () => c.saved.document.activeCamera ?? null,
      read: () => c.view.cameras?.().read(),
      operate: (operation: ICameraOperation) => c.attemptCamera(operation),
      focus: (target: IFocusTarget, options: Omit<IFocusRequest, "aspect" | "target"> = {}) =>
        c.view.cameras?.().focus({ ...options, target }),
      resolve: (target: { kind: "prop" | "landmark" | "region"; id: string }) =>
        c.view.cameras?.().resolve(target),
      measure: (bounds: IFocusBounds) => c.view.cameras?.().measure(bounds),
    },
    assets: {
      list: () => c.saved.document.assets ?? [],
      operate: (operation: IAssetOperation) => c.attemptAsset(operation),
    },
    // The same environment operations the GUI fields and the controller endpoint use.
    environment: {
      saved: () => c.saved.document.environment ?? {},
      read: () => c.view.environment?.().read(),
      operate: (operation: IEnvironmentOperation) => c.attemptEnvironment(operation),
    },
    // Same read-only dispatch the headless API serves, bound to the revision actually rendered.
    inspect: (query: ISpatialQuery) => {
      if (!c.state) throw Error("Wait for initial build");
      return inspectSpatial(c.state, c.renderedRevision ?? c.revision, query);
    },
    dispose: () => {
      c.disposed = true;
      c.abort.abort();
      clearTimeout(c.timer ?? undefined);
      clearTimeout(c.toastTimer ?? undefined);
      c.worker?.terminate();
      c.exportWorker?.terminate();
      c.exportReject?.(new Error("Editor disposed"));
    },
    export: c.exportKind,
    bake: (opts?: Parameters<typeof bakeTerrain>[1]) => {
      if (!c.state) throw Error("Wait for initial build");
      return bakeTerrain(c.state, opts);
    },
    registerAsset: (id: string, object: unknown) => {
      if (!c.view.registerAsset) throw Error("Three.js renderer is not active");
      return c.view.registerAsset(id, object);
    },
  };
}
export function installApi(c: EditorSession): void {
  window.addEventListener("keydown", c.keydown, { signal: c.abort.signal });
  c.api = createEditorApi(c);
  window.strata = c.api;
  $("view-angle").value = "perspective";
  $("view-angle").disabled = false;
  c.preview = $<HTMLSelectElement>("preview-resolution");
  c.resolution = String(c.terrain.config.resolution);
  if (![...c.preview.options].some((option) => option.value === c.resolution))
    c.preview.add(new Option(`${c.resolution}²`, c.resolution));
  c.preview.value = c.resolution;
  $("world-size").value = String(c.terrain.config.size);
  $("seed-input").value = String(c.terrain.config.seed);
  $("landscape-title").textContent = "Project terrain";
  $("landscape-subtitle").textContent = `${c.terrain.config.size} m · shared authoring document`;
  $("landscape-tag").textContent = "LANDSCAPE / PROJECT";
  c.selectTool("sculpt");
  c.renderLayers();
  c.renderCameras(c.initial.document);
  c.view.setDocument(c.initial.document, c.initial.revision);
  c.renderEnvironment();
  c.renderAssets();
  c.build();
  $("renderer-badge").textContent = c.view.backend;
}

declare global {
  interface Window {
    strata: ReturnType<typeof createEditorApi>;
  }
}
