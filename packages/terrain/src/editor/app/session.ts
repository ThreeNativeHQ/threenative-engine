import type { ITerrainDocument, ITerrainState, Layer } from "../../core/types.js";
import type { Terrain } from "../../index.js";
import type { IFocusRequest } from "../cameras.js";
import type { IEnvironment } from "../environment.js";
import type { IEditorView, TerrainEditorController } from "../index.js";
import type { SaveQueue } from "../saveQueue.js";
import type { IEditorSnapshot } from "../server.js";

import type { createEditorApi } from "./api.js";
export interface IRecoveredEditorOptions {
  initial: IEditorSnapshot;
  providedView: IEditorView;
  materialColours: readonly (readonly [number, number, number])[];
  commit: TerrainEditorController["commit"];
  getSnapshot: TerrainEditorController["snapshot"];
  cameraOperation: TerrainEditorController["camera"];
  environmentOperation: TerrainEditorController["environment"];
  assetOperation: TerrainEditorController["asset"];
  subscribe(listener: (snapshot: IEditorSnapshot) => void): void;
  onEvaluated?(event: { revision: string; state: ITerrainState; ms: number }): void;
}
export interface IEvaluationRequest {
  id: number;
  type: "evaluate" | "export";
  recipe: ITerrainDocument;
  resolution: number;
  kind?: string;
}
export interface IToolOptions {
  flatten: { height: number };
  stamp: { shape: "mountain" | "crater" | "ridge" | "valley" | "mesa" | "dune"; mirrorX: boolean };
  erode: { method: "thermal" | "hydraulic" };
  paint: {
    material: "grass" | "dirt" | "rock" | "snow" | "sand" | "mud" | "road" | "moss";
    mode: string;
    biome: string;
  };
  scatter: { asset: string; count: number; erase: boolean };
  spline: { kind: "road" | "river"; width: number; depth: number };
  water: { kind: "lake" | "ocean"; level: number };
  ramp: { width: number };
}
import { installApi } from "./api.js";
import { attemptAsset, importFile, installAssets, renderAssets, runAsset } from "./assets.js";
import {
  attemptCamera,
  focusTarget,
  installCameras,
  renderCameras,
  selectedCameraId,
} from "./cameras.js";
import {
  attemptEnvironment,
  installEnvironment,
  renderEnvironment,
  runEnvironment,
} from "./environment.js";
import {
  attempt,
  build,
  cancelBuild,
  changed,
  dispatch,
  installEvaluation,
  newWorker,
  setBusy,
  syncAssets,
  toast,
  useSnapshot,
  workerURL,
} from "./evaluation.js";
import { download, exportKind, installExports } from "./exports.js";
import { installLayers, renderInspector, renderLayers, updateHistory } from "./layers.js";
import { addStroke, finishSpline, installStrokes, showPoints } from "./strokes.js";
import { installToolbar, namePreset } from "./toolbar.js";
import {
  brush,
  installTools,
  optionNumber,
  optionSelect,
  renderOptions,
  selectTool,
} from "./tools.js";
export class EditorSession {
  abort!: AbortController;
  disposed!: boolean;
  tools!: [string, string, string][];
  options!: IToolOptions;
  terrain!: Terrain;
  state!: ITerrainState | null;
  renderedRecipe!: string | null;
  view!: IEditorView;
  selected!: string | undefined;
  active!: string;
  preset!: string;
  navigation!: boolean;
  points!: [number, number, number][];
  stroke!: { pointer: number; path: [number, number][]; lower: boolean } | null;
  busy!: boolean;
  sequence!: number;
  workerBusy!: boolean;
  evaluationRequests!: number;
  pending!: IEvaluationRequest | null;
  worker!: Worker | null;
  exportWorker!: Worker | null;
  exportReject!: ((reason: Error) => void) | null;
  timer!: ReturnType<typeof setTimeout> | null;
  announce!: (message: string, blocking?: boolean) => void;
  toastTimer!: ReturnType<typeof setTimeout> | null;
  assetSignature!: string;
  revision!: string;
  renderedRevision!: string | null;
  saveQueue!: SaveQueue;
  unsentSignature!: string;
  saving!: boolean;
  loading!: boolean;
  saved!: IEditorSnapshot;
  host!: HTMLElement;
  passes!: [string, string, () => unknown][];
  keydown!: (e: KeyboardEvent) => void;
  cameraPanel!: HTMLDivElement;
  style!: HTMLStyleElement;
  sidebar!: HTMLElement;
  envFields!: [keyof IEnvironment | null, string, string, string, string?][];
  envId!: (section: string | null, key: string) => string;
  environmentPanel!: HTMLDetailsElement;

  hex!: (value: unknown) => string;
  lane!: Promise<unknown>;
  inLane<T>(task: () => Promise<T>): Promise<T> {
    const result = this.lane.then(task, task);
    this.lane = result;
    return result;
  }
  assetPanel!: HTMLDetailsElement;
  assetId!: (name: string) => string;
  preview!: HTMLSelectElement;
  resolution!: string;
  api!: ReturnType<typeof createEditorApi>;
  updateHistory = updateHistory.bind(null, this);
  renderLayers = renderLayers.bind(null, this);
  renderInspector = renderInspector.bind(null, this);
  brush = brush.bind(null, this);
  optionSelect = optionSelect.bind(null, this);
  optionNumber = optionNumber.bind(null, this);
  renderOptions = renderOptions.bind(null, this);
  selectTool = selectTool.bind(null, this);
  addStroke = addStroke.bind(null, this);
  showPoints = showPoints.bind(null, this);
  finishSpline = finishSpline.bind(null, this);
  namePreset = namePreset.bind(null, this);
  download = download.bind(null, this);
  exportKind = exportKind.bind(null, this);
  selectedCameraId = selectedCameraId.bind(null, this);
  renderCameras = renderCameras.bind(null, this);
  attemptCamera = attemptCamera.bind(null, this);
  focusTarget = focusTarget.bind(null, this);
  renderEnvironment = renderEnvironment.bind(null, this);
  attemptEnvironment = attemptEnvironment.bind(null, this);
  runEnvironment = runEnvironment.bind(null, this);
  renderAssets = renderAssets.bind(null, this);
  attemptAsset = attemptAsset.bind(null, this);
  runAsset = runAsset.bind(null, this);
  importFile = importFile.bind(null, this);
  toast = toast.bind(null, this);
  attempt = attempt.bind(null, this);
  setBusy = setBusy.bind(null, this);
  workerURL = workerURL.bind(null, this);
  newWorker = newWorker.bind(null, this);
  dispatch = dispatch.bind(null, this);
  build = build.bind(null, this);
  cancelBuild = cancelBuild.bind(null, this);
  syncAssets = syncAssets.bind(null, this);
  useSnapshot = useSnapshot.bind(null, this);
  changed = changed.bind(null, this);
  initial: IRecoveredEditorOptions["initial"];
  providedView: IRecoveredEditorOptions["providedView"];
  materialColours: IRecoveredEditorOptions["materialColours"];
  commit: IRecoveredEditorOptions["commit"];
  getSnapshot: IRecoveredEditorOptions["getSnapshot"];
  cameraOperation: IRecoveredEditorOptions["cameraOperation"];
  environmentOperation: IRecoveredEditorOptions["environmentOperation"];
  assetOperation: IRecoveredEditorOptions["assetOperation"];
  subscribe: IRecoveredEditorOptions["subscribe"];
  onEvaluated: IRecoveredEditorOptions["onEvaluated"];
  constructor(options: IRecoveredEditorOptions) {
    this.initial = options.initial;
    this.providedView = options.providedView;
    this.materialColours = options.materialColours;
    this.commit = options.commit;
    this.getSnapshot = options.getSnapshot;
    this.cameraOperation = options.cameraOperation;
    this.environmentOperation = options.environmentOperation;
    this.assetOperation = options.assetOperation;
    this.subscribe = options.subscribe;
    this.onEvaluated = options.onEvaluated;
    installEvaluation(this);
    installTools(this);
    installStrokes(this);
    installLayers(this);
    installToolbar(this);
    installExports(this);
    installCameras(this);
    installEnvironment(this);
    installAssets(this);
    installApi(this);
  }
}
