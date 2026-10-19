import type { PatchCommand } from "../core/terrain.js";
import type { ITerrainState } from "../core/types.js";
import { mountRecoveredEditor } from "./app.js";
import type { IAssetOperation, IAssetResult } from "./assets.js";
import type {
  ICameraOperation,
  ICameraResult,
  IFocusBounds,
  IFocusOutcome,
  IFocusRequest,
  ISavedCamera,
} from "./cameras.js";
import type { IEnvironment, IEnvironmentOperation, IEnvironmentResult } from "./environment.js";
import type { IAuthoringDocument, IEditorActivation, IEditorSnapshot } from "./server.js";
import { editorShell } from "./shell.js";
import type { ISpatialObservation, ISpatialQuery } from "./spatialInspector.js";

export {
  focusCamera,
  runCameraOperation,
  validateCamera,
  validateCameras,
} from "./cameras.js";
export type {
  ICameraOperation,
  ICameraPose,
  ICameraResult,
  ICameraSet,
  IFocusBounds,
  IFocusFraming,
  IFocusOutcome,
  IFocusRequest,
  IFocusResolver,
  IFocusTarget,
  ISavedCamera,
} from "./cameras.js";
export { sniff, surfaceSpace, validateAsset, validateAssets, validateSurfaces } from "./assets.js";
export { SURFACE_CHANNELS, inspectImage } from "./images.js";
export type { IImageReport, ISurfaceChannel } from "./images.js";
export type {
  IAssetAdjust,
  IAssetBounds,
  IAssetKind,
  IAssetLimits,
  IAssetOperation,
  IAssetResult,
  IProjectAsset,
  ISurfaceMapping,
  ISurfaceMappings,
} from "./assets.js";
export {
  checkEnvironmentAssets,
  runEnvironmentOperation,
  validateEnvironment,
} from "./environment.js";
export type {
  IEnvironment,
  IEnvironmentOperation,
  IEnvironmentResult,
  IHexColour,
} from "./environment.js";
export {
  inspectSpatial,
  probeTerrain,
  validateSpatialReference,
} from "./spatialInspector.js";
export type {
  IPointObservation,
  IProfileObservation,
  IProfileSample,
  IReferenceObservation,
  ISavedSpatialReference,
  ISpatialControlPoint,
  ISpatialObservation,
  ISpatialQuery,
  ISpatialReference,
  ISurfaceReading,
} from "./spatialInspector.js";

/** The live view's own camera surface, shared by the GUI list and a controller. */
export interface IViewCamera {
  /** The actual current viewer pose, not the last saved bookmark. */
  read(): IViewerPose;
  /** Apply a saved pose to the real camera, or the ordinary editor camera when given null. */
  apply(camera: ISavedCamera | null): void;
  /**
   * Frame a target for the live viewport; an unknown target keeps the last valid camera and
   * reports why. The view measures the aspect itself, so a caller cannot save a stale one.
   */
  focus(request: Omit<IFocusRequest, "aspect">): IFocusOutcome;
  /** Resolves a non-point target against the live world; the view owns the world matrices. */
  resolve(target: { kind: "prop" | "landmark" | "region"; id: string }): IFocusBounds | undefined;
  /** Clip-square extent of bounds under the live camera, so a framing can be measured, not assumed. */
  measure(bounds: IFocusBounds): { x: number; y: number; z: boolean };
}

/** The live view's environment surface: bind saved overrides to the project's own render source. */
export interface IViewEnvironment {
  /**
   * Apply saved overrides to the real lights, haze, sky, exposure and sea. Absent fields restore
   * the project's own value; a field this source cannot honour throws by name and the scene keeps
   * its last valid look.
   */
  apply(environment: IEnvironment | undefined): void;
  /** The effective values now in use: the project's own, with the saved overrides on top. */
  read(): IEnvironment;
}

export interface IViewerPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly projection: "perspective" | "orthographic";
  readonly fov: number | null;
  readonly extent: number | null;
  readonly zoom: number | null;
  readonly near: number;
  readonly far: number;
  readonly aspect: number;
  readonly activeCamera: string | null;
}

export interface IEditorView {
  readonly backend: string;
  update(state: ITerrainState): ITerrainState | undefined;
  setDocument(document: IAuthoringDocument, revision: string): void;
  pick(clientX: number, clientY: number): [number, number, number] | null;
  setMode(mode: string): void;
  setBrush(
    brush: { at: [number, number]; radius: number; rotation?: number; shape?: string } | null,
  ): void;
  showSpline(points: readonly [number, number, number][]): void;
  setNavigation(enabled: boolean): void;
  setSelection?(enabled: boolean): void;
  selectLayer?(id: string): void;
  setView(view: string): void;
  frame(): void;
  registerAsset?(id: string, object: unknown): void;
  /**
   * The asset IDs this project can place and scatter. The recovered palette asks the view rather
   * than shipping a starter list, so a game's own props and its registered imports are what the
   * scatter and clear controls offer.
   */
  propAssets?(): readonly string[];
  /**
   * Settles once every registered model the view started loading is placeable or has failed. The
   * preview waits on it before drawing a revision, so a placement of a model still arriving is
   * not reported as a missing asset.
   */
  assetsReady?(): Promise<void>;
  /**
   * The texture inputs of this project's render source that an imported image can replace, named
   * `<surface>.<channel>`. The project decides what exists; the GUI offers exactly this list.
   */
  surfaceInputs?(): readonly { input: string; channel: string }[];
  cameras?(): IViewCamera;
  environment?(): IViewEnvironment;
  /**
   * The whole rendered revision as a portable GLB: terrain, resolved models with their final
   * transforms, this game's baked water and its portable PBR surfaces. Optional because a headless
   * or DOM-free view has nothing to encode from; the export card then says so rather than quietly
   * falling back to the terrain-only worker export.
   */
  exportCurrentWorld?(): Promise<{ name: string; mime: string; bytes: Uint8Array }>;
  dispose(): void;
}

/**
 * HTTP controller for the project-local terrain editor.
 * @requires npm i -D @threenative/terrain
 * @situation inspect and atomically edit the terrain editor from an agent
 * @constraint optional tooling; only subscribe/mount touches DOM; stale revisions fail explicitly
 * @example const controller = new TerrainEditorController(editorUrl); const snapshot = await controller.snapshot();
 * @override editorUrl is the activation-returned project URL
 */
export class TerrainEditorController {
  readonly baseUrl: string;
  constructor(editorUrl: string) {
    const url = new URL(editorUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Expected an HTTP(S) terrain editor URL");
    this.baseUrl = new URL("api/", url).href;
  }
  async #request<T>(route: string, transaction?: unknown): Promise<T> {
    const response = await fetch(
      new URL(route, this.baseUrl),
      transaction === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(transaction),
          },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
    return result as T;
  }
  activate(): Promise<IEditorActivation> {
    return this.#request("activate");
  }
  snapshot(): Promise<IEditorSnapshot> {
    return this.#request("document");
  }
  /**
   * Answer a read-only spatial query against one exact revision, GUI or headless.
   * @param query a `point`, `profile` or `reference` query from the saved document revision
   */
  inspect(query: ISpatialQuery, baseRevision: string): Promise<{ result: ISpatialObservation }> {
    return this.#request("inspect", { baseRevision, query });
  }
  /**
   * Run one create / get / list / update / delete / activate camera operation against one exact
   * revision. Editor observation cameras only: gameplay cameras belong to the consuming game.
   * @param operation a camera operation from {@link ICameraOperation}
   */
  camera(
    operation: ICameraOperation,
    baseRevision: string,
  ): Promise<ICameraResult & { revision: string }> {
    return this.#request("cameras", { baseRevision, operation });
  }
  /**
   * Run one get / patch / reset against the saved preview environment at one exact revision.
   * Appearance only: terrain, collision and placements are never re-evaluated.
   * @param operation an environment operation from {@link IEnvironmentOperation}
   */
  environment(
    operation: IEnvironmentOperation,
    baseRevision: string,
  ): Promise<IEnvironmentResult & { revision: string }> {
    return this.#request("environment", { baseRevision, operation });
  }
  /**
   * Register, upload, adjust, remove or list project assets at one exact revision. `register`
   * takes a local file path, the shape an asset-MCP download returns; `upload` takes bytes a
   * browser read. Both store the file under a content-hashed name and measure it.
   * @param operation an asset operation from {@link IAssetOperation}
   */
  asset(
    operation: IAssetOperation,
    baseRevision: string,
  ): Promise<IAssetResult & { revision: string }> {
    return this.#request("assets", { baseRevision, operation });
  }
  commit(
    transaction:
      | { baseRevision: string; document: IAuthoringDocument }
      | { baseRevision: string; commands: readonly PatchCommand[] },
  ): Promise<IEditorSnapshot> {
    return this.#request("document", transaction);
  }
  subscribe(listener: (snapshot: IEditorSnapshot) => void, onError: () => void): () => void {
    const events = new EventSource(new URL("events", this.baseUrl));
    events.onmessage = ({ data }) => {
      try {
        listener(JSON.parse(data) as IEditorSnapshot);
      } catch {
        onError();
      }
    };
    events.onerror = onError;
    return () => events.close();
  }
}

/**
 * Mount recovered terrain controls around the project-owned ThreeNative view.
 * @requires npm i -D @threenative/terrain
 * @situation open the terrain brush and layer GUI around game-owned rendering
 * @constraint browser authoring only; createView and materialColours are required game choices
 * @example await mountTerrainEditor({ createView: createEditorView, materialColours: terrainPalette });
 * @override createView owns the renderer scene, materials, lighting and camera
 */
export async function mountTerrainEditor(options: {
  createView(host: HTMLElement, controller: TerrainEditorController): Promise<IEditorView>;
  materialColours: readonly (readonly [number, number, number])[];
  onEvaluated?(event: { revision: string; state: ITerrainState; ms: number }): void;
}): Promise<{ controller: TerrainEditorController; dispose(): void }> {
  document.body.innerHTML = editorShell;
  const lock = document.createElement("style");
  lock.textContent =
    'body[data-saving="true"] button,body[data-saving="true"] input,body[data-saving="true"] select,body[data-saving="true"] textarea{pointer-events:none}';
  document.head.append(lock);
  const host = document.getElementById("viewport");
  if (!host) throw new Error("Recovered editor has no viewport");
  const controller = new TerrainEditorController(new URL("./", location.href).href);
  const initial = await controller.snapshot();
  const view = await options.createView(host, controller);
  let unsubscribe = () => {};
  const controls = mountRecoveredEditor({
    initial,
    providedView: view,
    materialColours: options.materialColours,
    commit: (transaction: Parameters<typeof controller.commit>[0]) =>
      controller.commit(transaction),
    getSnapshot: () => controller.snapshot(),
    cameraOperation: (operation: unknown, baseRevision: string) =>
      controller.camera(operation as ICameraOperation, baseRevision),
    assetOperation: (operation: unknown, baseRevision: string) =>
      controller.asset(operation as IAssetOperation, baseRevision),
    environmentOperation: (operation: unknown, baseRevision: string) =>
      controller.environment(operation as IEnvironmentOperation, baseRevision),
    subscribe: (listener: (snapshot: IEditorSnapshot) => void) => {
      unsubscribe = controller.subscribe(listener, () => {
        const status = document.getElementById("save-status");
        if (status) status.textContent = "Connection interrupted · waiting for project";
      });
    },
    onEvaluated: options.onEvaluated,
  });
  const title = document.getElementById("project-name");
  if (title) title.textContent = "Project terrain";
  return {
    controller,
    dispose: () => {
      unsubscribe();
      controls.dispose();
      view.dispose();
      lock.remove();
    },
  };
}
