/**
 * Per-object geometry cost, measured from what the renderer actually submitted.
 *
 * A total triangle counter cannot name the offender: a main character can cost 500 triangles while
 * a barely visible tree submits two million, and both land in the same number. `FrameBudget` stays
 * authoritative for a frame's per-pass totals; this attributes a slice of those totals to the
 * objects that caused them, and reconciles the two so the difference is visible rather than
 * assumed away.
 *
 * Three properties make it a measurement rather than a guess:
 *
 * 1. **It counts submissions, not scene contents.** The instrument is `onBeforeRender`, which the
 *    renderer calls once per object, per material group, per pass, *after* frustum and projected-
 *    size culling. A `visible` flag is a game's intent; a submission is what the GPU was handed.
 * 2. **It is armed only on request.** Nothing is installed, walked or counted until a consumer asks
 *    for one capture, and every hook is removed when that frame ends, is cancelled, or the scene
 *    exits. An idle game pays nothing.
 * 3. **It says "unavailable" with a reason.** A packed batch's per-member draws, an indirect
 *    counter with no readback, a geometry with no recoverable source detail: each is named, never
 *    reported as zero and never quietly dropped, and the unattributed remainder of every pass is
 *    reported beside the measured total.
 *
 * @situation find out which scene object is submitting the frame's triangles
 * @situation tell a cheap foreground character from an expensive distant prop
 */

import { Frustum, Matrix4, Sphere, Vector3 } from "three";
import type { Camera, Object3D } from "three";
import { markEngineRenderHook } from "./engine-render-hook.js";
import { baseGeometryOf, conservativeViewDepth, lodPixelScale, worldSphere } from "./model-lod.js";
import type { FramePassKind, IRenderPassSample } from "./render-pass-budget.js";

/** Rows returned when a request does not name a limit. */
export const GEOMETRY_CAPTURE_DEFAULT_LIMIT = 50;

/** The most rows one request may ask for. A transport carries a report, not a scene dump. */
export const GEOMETRY_CAPTURE_MAX_LIMIT = 500;

/** The inspection ceiling, shared with scene-node observation so one scene has one limit. */
export const GEOMETRY_CAPTURE_WALK_CAP = 50_000;

/** How long a request waits for a presented world frame before answering "unavailable". */
export const GEOMETRY_CAPTURE_TIMEOUT_MS = 2_000;

/** The `userData` key a loader stamps on a model root so a clone keeps its provenance. */
export const GEOMETRY_ASSET_KEY = "tnAssetPath";

/** The playtest capability a bridge advertises when a geometry capture can be requested. */
export const GEOMETRY_CAPTURE_CAPABILITY = "runtime.geometry" as const;

/** The orderings a request may ask for. Ranking happens over the inspected scope, then slices. */
export const GEOMETRY_CAPTURE_SORTS = ["triangles", "draws", "projected"] as const;

export type GeometryCaptureSort = (typeof GEOMETRY_CAPTURE_SORTS)[number];

export interface IGeometryCaptureRequest {
  /** Rows to return, 1 to `GEOMETRY_CAPTURE_MAX_LIMIT`. */
  readonly limit?: number;
  readonly sort?: GeometryCaptureSort;
  readonly timeoutMs?: number;
}

/** What a rendered object is: the game's own object, or the mirror standing in for some of them. */
export type GeometryOwnershipKind = "exact" | "instancedBatch" | "materialBatch";

export interface IGeometryOwnership {
  readonly kind: GeometryOwnershipKind;
  readonly sources: readonly Object3D[];
}

/** Where a row's triangle number came from, so a derived number is never read as a measured one. */
export type GeometryTriangleSource = "renderer" | "batchMembers";

export interface IGeometryPassCost {
  readonly draws: number;
  readonly triangles: number;
}

export interface IGeometryCapturePass extends IGeometryPassCost {
  readonly kind: FramePassKind;
  /** What the rows below account for. */
  readonly attributedDraws: number;
  readonly attributedTriangles: number;
  /**
   * Measured minus attributed. Negative means the rows over-claim — a derived batch sum, say —
   * which is a finding, not something to clamp away.
   */
  readonly unattributedDraws: number;
  readonly unattributedTriangles: number;
}

export interface IGeometryCaptureMesh {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly type: string;
  /** LOD0 triangles of this mesh, when the source detail is recoverable. */
  readonly fullDetailTriangles?: number;
  /** Triangles in the buffer the renderer was pointed at this frame. */
  readonly selectedDetailTriangles?: number;
  readonly submittedTriangles?: number;
  readonly trianglesSource?: GeometryTriangleSource;
  readonly draws: number;
  readonly materials: number;
  readonly instances?: number;
  readonly submissions: Readonly<Partial<Record<FramePassKind, IGeometryPassCost>>>;
  readonly batchOwner?: string;
  readonly visible: boolean;
  readonly inFrustum?: boolean;
  readonly unavailable?: readonly string[];
}

export interface IGeometryCaptureRow {
  // --- Identity ---------------------------------------------------------------------------------
  readonly id: string;
  readonly generation: number;
  readonly name: string;
  readonly path: string;
  readonly type: string;
  /** The logical asset this row came from, when a loader stamped one. */
  readonly asset?: string;

  // --- Geometry ---------------------------------------------------------------------------------
  readonly fullDetailTriangles?: number;
  readonly selectedDetailTriangles?: number;
  readonly submittedTriangles?: number;
  readonly trianglesSource?: GeometryTriangleSource;
  readonly lod?: { readonly level?: number; readonly levels?: number };

  // --- Camera contribution ----------------------------------------------------------------------
  /** Estimated projected diameter in drawing-buffer pixels. An estimate, never a pixel count. */
  readonly projectedPixels?: number;
  /**
   * Where those bounds landed, in drawing-buffer pixels from the top-left. An overlay outlines
   * this; it is the estimated bounds' centre, not a silhouette.
   */
  readonly projectedCenter?: readonly [number, number];
  readonly viewportFraction?: number;
  readonly cameraDistance?: number;
  readonly inFrustum?: boolean;
  readonly visibility: "submitted" | "notSubmitted";

  // --- Repetition -------------------------------------------------------------------------------
  /** Submitted copies of this row's geometry, instances included. */
  readonly copies: number;
  readonly instances?: number;
  /** Triangles counted once per distinct geometry, for a unique-inventory reading. */
  readonly uniqueTriangles?: number;

  // --- Submission -------------------------------------------------------------------------------
  readonly draws: number;
  readonly materials: number;
  readonly submissions: Readonly<Partial<Record<FramePassKind, IGeometryPassCost>>>;
  readonly batch?: {
    readonly kind: GeometryOwnershipKind;
    readonly owner: string;
    readonly members: number;
    readonly perMemberDrawsAvailable: boolean;
  };
  readonly unavailable?: readonly string[];
  readonly meshes: readonly IGeometryCaptureMesh[];
}

export interface IGeometryCaptureAsset {
  readonly asset: string;
  readonly objects: number;
  readonly submittedTriangles?: number;
  readonly draws: number;
  /** Triangles of the distinct geometries this asset contributed, counted once each. */
  readonly uniqueTriangles?: number;
  readonly unavailable?: readonly string[];
}

export interface IGeometryCaptureReport {
  readonly status: "captured" | "unavailable";
  /** Set when `status` is `unavailable`. A stale capture is never returned as a fresh one. */
  readonly reason?: string;
  readonly capturedAtMs?: number;
  readonly durationMs?: number;
  readonly generation?: number;
  readonly tick?: number;
  readonly frame?: number;
  readonly backend?: string;
  readonly camera?: {
    readonly type: "perspective" | "orthographic" | "unknown";
    readonly position: readonly [number, number, number];
    readonly fov?: number;
    readonly zoom?: number;
    readonly near?: number;
    readonly far?: number;
  };
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly sort?: GeometryCaptureSort;
  readonly limit?: number;
  /** Rows the inspected scope produced before the limit sliced them. */
  readonly matched?: number;
  readonly returned?: number;
  /** True when the limit cut rows; distinct from an incomplete inspection. */
  readonly rowsTruncated?: boolean;
  /** False when the walk cap stopped the inspection, so no ranking is a global claim. */
  readonly inspectionComplete?: boolean;
  readonly partialRanking?: boolean;
  readonly inspectedNodes?: number;
  readonly passes?: readonly IGeometryCapturePass[];
  readonly objects?: readonly IGeometryCaptureRow[];
  readonly assets?: readonly IGeometryCaptureAsset[];
}

/** What the owner of the render loop hands the capture for the frame it is about to draw. */
export interface IGeometryCaptureFrame {
  /** The object actually rendered — the projection's mirror when there is one, not the authored scene. */
  readonly root: Object3D;
  readonly camera: Camera;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly generation: number;
  readonly tick?: number;
  readonly frame?: number;
  readonly backend?: string;
  /** Who owns each rendered object, when a mirror stands between the scene and the renderer. */
  readonly ownership?: ReadonlyMap<Object3D, IGeometryOwnership>;
  /** The innermost active render pass, so a shadow submission does not read as main. */
  readonly activePassKind?: () => FramePassKind | undefined;
}

// --- Structural views of three's objects ---------------------------------------------------------
//
// Structural, not `instanceof`: the same shape has to accept a real `Mesh`, the mirror's stand-in
// and a unit test's minimal double, exactly as the projection and the pass budget already do.

interface IAttributeLike {
  readonly count?: number;
}

interface IGeometryLike {
  readonly attributes?: Record<string, IAttributeLike | undefined>;
  readonly index?: IAttributeLike | null;
  readonly drawRange?: { readonly start: number; readonly count: number };
  readonly boundingSphere?: Sphere | null;
  computeBoundingSphere?: () => void;
}

interface IRenderedLike {
  readonly isMesh?: boolean;
  readonly isPoints?: boolean;
  readonly isLine?: boolean;
  readonly isLineSegments?: boolean;
  readonly isLineLoop?: boolean;
  readonly isInstancedMesh?: boolean;
  readonly isBatchedMesh?: boolean;
  readonly isLOD?: boolean;
  readonly count?: number;
  readonly levels?: readonly unknown[];
  readonly geometry?: IGeometryLike;
  readonly material?: unknown;
  onBeforeRender?: RenderCallback;
}

type RenderCallback = (
  renderer: unknown,
  scene: unknown,
  camera: unknown,
  geometry: unknown,
  material: unknown,
  group: unknown,
) => void;

interface IGroupLike {
  readonly count?: number;
}

interface ISubmissionRecord {
  readonly object: Object3D;
  draws: number;
  triangles: number;
  trianglesAvailable: boolean;
  instances: number;
  readonly byPass: Map<FramePassKind, { draws: number; triangles: number }>;
  readonly materials: Set<unknown>;
  readonly unavailable: Set<string>;
}

interface IArmedFrame extends IGeometryCaptureFrame {
  readonly restore: (() => void)[];
  readonly records: Map<Object3D, ISubmissionRecord>;
  inspected: number;
  complete: boolean;
}

interface IPendingRequest {
  readonly limit: number;
  readonly sort: GeometryCaptureSort;
  readonly requestedAtMs: number;
  readonly settle: (report: IGeometryCaptureReport) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const NO_OP_RENDER: RenderCallback = () => undefined;

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function isTriangleObject(object: IRenderedLike): boolean {
  if (object.isPoints === true) return false;
  if (object.isLine === true || object.isLineSegments === true || object.isLineLoop === true) {
    return false;
  }
  return true;
}

/** Triangles in a buffer, honouring the index, the draw range and a material group. */
function geometryTriangles(
  geometry: IGeometryLike | undefined,
  group?: IGroupLike,
): number | undefined {
  if (geometry === undefined) return undefined;
  const available = geometry.index?.count ?? geometry.attributes?.position?.count;
  if (available === undefined) return undefined;
  const requested = group?.count ?? geometry.drawRange?.count;
  const count =
    requested === undefined || !Number.isFinite(requested)
      ? available
      : Math.max(0, Math.min(requested, available));
  return Math.floor(count / 3);
}

/** The name a row shows. A name is a label, never an identity or an asset key. */
function displayName(object: Object3D): string {
  return object.name === "" ? object.type : object.name;
}

function nodePath(object: Object3D, root: Object3D): string {
  const parts: string[] = [];
  let node: Object3D | null = object;
  while (node !== null && node !== root) {
    parts.push(node.name === "" ? node.type : node.name);
    node = node.parent;
  }
  parts.reverse();
  return `/${parts.join("/")}`;
}

function assetOf(object: Object3D): string | undefined {
  let node: Object3D | null = object;
  while (node !== null) {
    const stamped = (node.userData as Record<string, unknown> | undefined)?.[GEOMETRY_ASSET_KEY];
    if (typeof stamped === "string" && stamped !== "") return stamped;
    node = node.parent;
  }
  return undefined;
}

/**
 * The object a row is about: the nearest ancestor carrying asset provenance, otherwise the
 * top-level child of the rendered root. A carrier's ninety-four meshes belong to the carrier.
 */
function rowRootOf(object: Object3D, root: Object3D): Object3D {
  let node: Object3D = object;
  let candidate: Object3D = object;
  while (node.parent !== null && node !== root) {
    const stamped = (node.userData as Record<string, unknown> | undefined)?.[GEOMETRY_ASSET_KEY];
    if (typeof stamped === "string" && stamped !== "") return node;
    if (node.parent === root) candidate = node;
    node = node.parent;
  }
  return candidate;
}

const sphereScratch = new Sphere();
const centreScratch = new Vector3();
const projectScratch = new Vector3();

/** The world bounding sphere of one rendered object, or undefined when it has no measurable bounds. */
function objectSphere(object: Object3D, into: Sphere): boolean {
  const geometry = (object as IRenderedLike).geometry;
  if (geometry === undefined) return false;
  if (geometry.boundingSphere === undefined || geometry.boundingSphere === null) {
    geometry.computeBoundingSphere?.();
  }
  const local = geometry.boundingSphere;
  if (local === undefined || local === null) return false;
  if (!Number.isFinite(local.radius)) return false;
  worldSphere(local, object, into);
  return Number.isFinite(into.radius);
}

interface ICameraLike {
  readonly isOrthographicCamera?: boolean;
  readonly isPerspectiveCamera?: boolean;
  readonly fov?: number;
  readonly zoom?: number;
  readonly near?: number;
  readonly far?: number;
}

/** Where a world point lands in drawing-buffer pixels, measured from the top-left. */
function projectedCenter(
  centre: Vector3,
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number,
): readonly [number, number] | undefined {
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return undefined;
  const ndc = projectScratch.copy(centre).project(camera);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return undefined;
  return [(ndc.x * 0.5 + 0.5) * viewportWidth, (-ndc.y * 0.5 + 0.5) * viewportHeight];
}

/**
 * Projected diameter in raster pixels, and the camera distance it was derived from.
 *
 * A camera at or inside the bounds has no meaningful projected size, so the estimate is the whole
 * viewport rather than a small number: an unknown must never read as a confident small object.
 */
function projectedSize(
  sphere: Sphere,
  camera: Camera,
  viewportHeight: number,
): { readonly pixels: number; readonly distance: number } | undefined {
  if (!(viewportHeight > 0)) return undefined;
  const like = camera as ICameraLike;
  const near = like.near ?? 0.1;
  const distance = centreScratch
    .copy(sphere.center)
    .distanceTo(camera.getWorldPosition(new Vector3()));
  let depth: number;
  let degenerate: boolean;
  try {
    const view = conservativeViewDepth(camera, sphere.center, sphere.radius, near);
    depth = view.depth;
    degenerate = view.degenerate;
  } catch {
    return undefined;
  }
  if (like.isOrthographicCamera !== true && degenerate) {
    return { distance, pixels: viewportHeight };
  }
  try {
    const scale = lodPixelScale(camera, viewportHeight, Math.max(depth, near));
    if (!Number.isFinite(scale)) return { distance, pixels: viewportHeight };
    return { distance, pixels: 2 * sphere.radius * scale };
  } catch {
    return undefined;
  }
}

/**
 * The renderer's backend, for the report's stamp. A capture that does not say which backend
 * produced it cannot be compared against one from another platform.
 */
export function rendererBackendIdentity(raw: unknown): string | undefined {
  const backend = (raw as { backend?: object } | undefined)?.backend;
  const name = (backend?.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * One on-demand per-object geometry capture. One instance lives for the life of a game; it holds
 * no hooks and does no work between requests.
 */
export class GeometryCapture {
  #pending: IPendingRequest | undefined;
  #armed: IArmedFrame | undefined;

  /**
   * Arms one capture and answers its report. A malformed request throws rather than quietly
   * choosing a scope the caller did not ask for. Concurrent requests coalesce onto one frame.
   */
  request(request: IGeometryCaptureRequest = {}): Promise<IGeometryCaptureReport> {
    const limit = request.limit ?? GEOMETRY_CAPTURE_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > GEOMETRY_CAPTURE_MAX_LIMIT) {
      throw new Error(
        `TN_GEOMETRY_CAPTURE_LIMIT: limit must be an integer from 1 to ${String(GEOMETRY_CAPTURE_MAX_LIMIT)}, got ${String(request.limit)}.`,
      );
    }
    const sort = request.sort ?? "triangles";
    if (!GEOMETRY_CAPTURE_SORTS.includes(sort)) {
      throw new Error(
        `TN_GEOMETRY_CAPTURE_SORT: sort must be one of ${GEOMETRY_CAPTURE_SORTS.join(", ")}, got ${String(request.sort)}.`,
      );
    }
    const timeoutMs = request.timeoutMs ?? GEOMETRY_CAPTURE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `TN_GEOMETRY_CAPTURE_TIMEOUT: timeoutMs must be a positive number, got ${String(request.timeoutMs)}.`,
      );
    }
    const existing = this.#pending;
    if (existing !== undefined) {
      // Coalesce: one frame answers both, on the widest scope asked for.
      return new Promise<IGeometryCaptureReport>((resolve) => {
        const previous = existing.settle;
        const merged: IPendingRequest = {
          ...existing,
          limit: Math.max(existing.limit, limit),
          settle: (report) => {
            previous(report);
            resolve(report);
          },
        };
        this.#pending = merged;
      });
    }
    return new Promise<IGeometryCaptureReport>((resolve) => {
      const pending: IPendingRequest = {
        limit,
        requestedAtMs: now(),
        settle: resolve,
        sort,
      };
      pending.timer = setTimeout(() => {
        // Never answer with the previous capture as if it were this one's frame.
        this.#restore();
        this.#pending = undefined;
        resolve({
          reason: `TN_GEOMETRY_CAPTURE_NO_FRAME: no world frame was presented within ${String(timeoutMs)} ms.`,
          status: "unavailable",
        });
      }, timeoutMs);
      pending.timer.unref?.();
      this.#pending = pending;
    });
  }

  /** True while a request is waiting, which is the only condition the render loop needs to test. */
  armed(): boolean {
    return this.#pending !== undefined;
  }

  /**
   * Installs the frame's submission hooks. Called immediately before the world render, and only
   * while `armed()`; an idle game never reaches it.
   */
  beginFrame(frame: IGeometryCaptureFrame): void {
    if (this.#pending === undefined) return;
    this.#restore();
    const armed: IArmedFrame = {
      ...frame,
      complete: true,
      inspected: 0,
      records: new Map(),
      restore: [],
    };
    this.#armed = armed;
    frame.root.traverse((object) => {
      if (!armed.complete) return;
      const rendered = object as IRenderedLike;
      if (rendered.geometry === undefined && rendered.isBatchedMesh !== true) return;
      armed.inspected += 1;
      if (armed.inspected > GEOMETRY_CAPTURE_WALK_CAP) {
        armed.complete = false;
        return;
      }
      this.#hook(armed, object);
    });
  }

  /**
   * Ends the frame: removes every hook, reconciles the rows against the measured pass totals and
   * answers the waiting request.
   */
  finishFrame(passes: readonly IRenderPassSample[]): void {
    const armed = this.#armed;
    const pending = this.#pending;
    this.#restore();
    if (armed === undefined || pending === undefined) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.settle(buildReport(armed, passes, pending));
  }

  /** Drops a pending capture and every hook. A scene exit is not a reason to report a stale frame. */
  cancel(reason: string): void {
    const pending = this.#pending;
    this.#restore();
    this.#pending = undefined;
    if (pending === undefined) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.settle({ reason, status: "unavailable" });
  }

  #hook(armed: IArmedFrame, object: Object3D): void {
    const rendered = object as IRenderedLike;
    const own = Object.hasOwn(object, "onBeforeRender")
      ? (rendered.onBeforeRender as RenderCallback | undefined)
      : undefined;
    const previous = own ?? NO_OP_RENDER;
    const record: ISubmissionRecord = {
      byPass: new Map(),
      draws: 0,
      instances: 1,
      materials: new Set(),
      object,
      triangles: 0,
      trianglesAvailable: true,
      unavailable: new Set(),
    };
    armed.records.set(object, record);
    const instrumented: RenderCallback = function instrumentedOnBeforeRender(
      this: unknown,
      renderer,
      scene,
      camera,
      geometry,
      material,
      group,
    ) {
      const kind = armed.activePassKind?.() ?? "main";
      const pass = record.byPass.get(kind) ?? { draws: 0, triangles: 0 };
      pass.draws += 1;
      record.draws += 1;
      record.materials.add(material);
      if (rendered.isInstancedMesh === true) {
        record.instances = Math.max(record.instances, Math.max(0, rendered.count ?? 0));
      }
      if (rendered.isBatchedMesh === true) {
        // One render object, many `drawIndexed` commands, and no per-member draw the renderer
        // reports. The batch's own cost is derived from its members below, never guessed here.
        record.trianglesAvailable = false;
        record.unavailable.add("TN_GEOMETRY_BATCHED_MESH_SUBDRAWS");
      } else if (!isTriangleObject(rendered)) {
        // A line or a point submits a draw and no triangles. Counting its vertices as triangles is
        // how a total starts disagreeing with the renderer.
      } else {
        const triangles = geometryTriangles(
          geometry as IGeometryLike | undefined,
          group as IGroupLike | undefined,
        );
        if (triangles === undefined) {
          record.trianglesAvailable = false;
          record.unavailable.add("TN_GEOMETRY_NO_POSITION_COUNT");
        } else {
          const instances =
            rendered.isInstancedMesh === true ? Math.max(0, rendered.count ?? 0) : 1;
          const submitted = triangles * instances;
          record.triangles += submitted;
          pass.triangles += submitted;
        }
      }
      record.byPass.set(kind, pass);
      previous.call(this, renderer, scene, camera, geometry, material, group);
    };
    // Engine bookkeeping, exactly as the world's prewarm borrow is: the capture counts the draws
    // the frame really submits, so it claims no object and the scene render projection may fold
    // the scene away underneath it. Unmarked, an armed capture declined the projection on every
    // frame and the counter then reported the collapse it had prevented.
    markEngineRenderHook(instrumented);
    rendered.onBeforeRender = instrumented;
    armed.restore.push(() => {
      if (rendered.onBeforeRender !== instrumented) return;
      // Deleted, not set to undefined: three calls `object.onBeforeRender(...)` unconditionally,
      // so an own `undefined` shadows the prototype's no-op and throws on the next frame.
      // quality-allow: delete is the restoration, not a leak; an own `undefined` would shadow the prototype no-op and throw
      // biome-ignore lint/performance/noDelete: restoring the prototype lookup is the point.
      if (own === undefined) delete rendered.onBeforeRender;
      else rendered.onBeforeRender = own;
    });
  }

  #restore(): void {
    const armed = this.#armed;
    if (armed === undefined) return;
    for (const restore of armed.restore) restore();
    armed.restore.length = 0;
    this.#armed = undefined;
  }
}

// --- Report assembly -----------------------------------------------------------------------------

interface IMeshDraft {
  readonly record: ISubmissionRecord;
  readonly source: Object3D;
  readonly batchOwner?: string;
  readonly trianglesSource: GeometryTriangleSource;
  readonly triangles?: number;
  readonly draws: number;
}

function meshDraftsOf(armed: IArmedFrame): IMeshDraft[] {
  const drafts: IMeshDraft[] = [];
  for (const record of armed.records.values()) {
    const ownership = armed.ownership?.get(record.object);
    if (ownership === undefined) {
      drafts.push({
        draws: record.draws,
        record,
        source: record.object,
        trianglesSource: "renderer",
        ...(record.trianglesAvailable ? { triangles: record.triangles } : {}),
      });
      continue;
    }
    if (ownership.kind === "exact") {
      const source = ownership.sources[0] ?? record.object;
      drafts.push({
        draws: record.draws,
        record,
        source,
        trianglesSource: "renderer",
        ...(record.trianglesAvailable ? { triangles: record.triangles } : {}),
      });
      continue;
    }
    // A batch is one draw however many sources it folded. Charging a whole draw to each member is
    // how a merged batch reads as more expensive than the objects it replaced.
    const owner = displayName(record.object);
    for (const source of ownership.sources) {
      const geometry = (source as IRenderedLike).geometry;
      const own = geometryTriangles(geometry);
      drafts.push({
        batchOwner: owner,
        draws: 0,
        record,
        source,
        trianglesSource: ownership.kind === "materialBatch" ? "batchMembers" : "renderer",
        ...(own === undefined ? {} : { triangles: own }),
      });
    }
  }
  return drafts;
}

/**
 * What one draft contributed to one pass.
 *
 * An ordinary object's per-pass triangles are the ones that pass measured. A batch member owns no
 * pass record of its own — the batch does — so its own geometry is what it contributed to each
 * pass the batch was drawn in, and never the batch's whole total.
 */
function passTrianglesOf(draft: IMeshDraft, cost: { readonly triangles: number }): number {
  if (draft.batchOwner === undefined) return cost.triangles;
  return draft.triangles ?? 0;
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  let any = false;
  for (const value of values) {
    if (value === undefined) continue;
    total += value;
    any = true;
  }
  return any ? total : undefined;
}

function buildReport(
  armed: IArmedFrame,
  passes: readonly IRenderPassSample[],
  pending: IPendingRequest,
): IGeometryCaptureReport {
  const drafts = meshDraftsOf(armed);
  const frustum = frustumOf(armed.camera);
  const groups = new Map<Object3D, IMeshDraft[]>();
  for (const draft of drafts) {
    const root = rowRootOf(draft.source, armed.root);
    const bucket = groups.get(root);
    if (bucket === undefined) groups.set(root, [draft]);
    else bucket.push(draft);
  }

  const rows: IGeometryCaptureRow[] = [];
  let index = 0;
  for (const [root, members] of groups) {
    rows.push(rowOf(root, members, armed, index, frustum));
    index += 1;
  }

  const sorted = rankRows(rows, pending.sort);
  const returned = sorted.slice(0, pending.limit);
  const asset = assetRowsOf(rows);
  const passRows = reconcile(passes, drafts);

  // Every optional field is omitted rather than set to `undefined`: this report crosses the
  // playtest transport, which fails closed on a key whose value is not JSON — an explicit
  // `frame: undefined` took a real browser run down before it was a conditional spread.
  return {
    assets: asset,
    camera: cameraOf(armed.camera),
    capturedAtMs: now(),
    durationMs: now() - pending.requestedAtMs,
    generation: armed.generation,
    ...(armed.backend === undefined ? {} : { backend: armed.backend }),
    ...(armed.frame === undefined ? {} : { frame: armed.frame }),
    inspectedNodes: Math.min(armed.inspected, GEOMETRY_CAPTURE_WALK_CAP),
    inspectionComplete: armed.complete,
    limit: pending.limit,
    matched: rows.length,
    objects: returned,
    partialRanking: !armed.complete || rows.length > pending.limit,
    passes: passRows,
    returned: returned.length,
    rowsTruncated: rows.length > pending.limit,
    sort: pending.sort,
    status: "captured",
    viewport: { height: armed.viewportHeight, width: armed.viewportWidth },
    ...(armed.tick === undefined ? {} : { tick: armed.tick }),
  };
}

function rankRows(
  rows: readonly IGeometryCaptureRow[],
  sort: GeometryCaptureSort,
): IGeometryCaptureRow[] {
  const key = (row: IGeometryCaptureRow): number | undefined =>
    sort === "draws"
      ? row.draws
      : sort === "projected"
        ? row.projectedPixels
        : row.submittedTriangles;
  // An unknown cost is not a small cost. Unknowns sort after every measured row rather than
  // pretending to a zero that would park the frame's worst offender at the bottom.
  return [...rows].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    if (a === undefined && b === undefined) return left.path.localeCompare(right.path);
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (a === b) return left.path.localeCompare(right.path);
    return b - a;
  });
}

function rowOf(
  root: Object3D,
  members: readonly IMeshDraft[],
  armed: IArmedFrame,
  index: number,
  frustum: Frustum | undefined,
): IGeometryCaptureRow {
  const meshes: IGeometryCaptureMesh[] = [];
  const submissions: Partial<Record<FramePassKind, { draws: number; triangles: number }>> = {};
  const unavailable = new Set<string>();
  const materials = new Set<unknown>();
  const uniqueGeometries = new Map<unknown, number>();
  const bounds = new Sphere();
  let boundsKnown = false;
  let draws = 0;
  let copies = 0;
  let instances: number | undefined;
  let submitted: number | undefined;
  let selected: number | undefined;
  let full: number | undefined;
  let trianglesSource: GeometryTriangleSource = "renderer";
  let batch: IGeometryCaptureRow["batch"];

  for (const member of members) {
    const source = member.source;
    const rendered = source as IRenderedLike;
    let memberTriangles: number | undefined;
    for (const [kind, cost] of member.record.byPass) {
      const into = submissions[kind] ?? { draws: 0, triangles: 0 };
      // A batch member owns no draw of its own; the batch row below carries it.
      into.draws += member.batchOwner === undefined ? cost.draws : 0;
      const contributed = member.triangles === undefined ? 0 : passTrianglesOf(member, cost);
      into.triangles += contributed;
      if (member.triangles !== undefined) memberTriangles = (memberTriangles ?? 0) + contributed;
      submissions[kind] = into;
    }
    for (const reason of member.record.unavailable) unavailable.add(reason);
    for (const material of member.record.materials) materials.add(material);
    draws += member.draws;
    copies += member.batchOwner === undefined ? member.record.instances : 1;
    if (rendered.isInstancedMesh === true) {
      instances = (instances ?? 0) + Math.max(0, rendered.count ?? 0);
    }
    if (memberTriangles !== undefined) submitted = (submitted ?? 0) + memberTriangles;
    if (member.trianglesSource === "batchMembers") trianglesSource = "batchMembers";
    const geometry = rendered.geometry;
    const own = geometryTriangles(geometry);
    if (own !== undefined) {
      selected = (selected ?? 0) + own;
      if (geometry !== undefined && !uniqueGeometries.has(geometry))
        uniqueGeometries.set(geometry, own);
    }
    const base = baseTriangles(rendered);
    if (base !== undefined) full = (full ?? 0) + base;
    if (member.batchOwner !== undefined) {
      batch = {
        kind: member.trianglesSource === "batchMembers" ? "materialBatch" : "instancedBatch",
        members: members.length,
        owner: member.batchOwner,
        perMemberDrawsAvailable: false,
      };
    }
    if (objectSphere(source, sphereScratch)) {
      if (boundsKnown) bounds.union(sphereScratch);
      else {
        bounds.copy(sphereScratch);
        boundsKnown = true;
      }
    }
    meshes.push({
      draws: member.draws,
      id: `${String(armed.generation)}:${String(index)}:${String(meshes.length)}`,
      materials: member.record.materials.size,
      name: displayName(source),
      path: nodePath(source, armed.root),
      submissions: Object.fromEntries(
        [...member.record.byPass].map(([kind, cost]) => [
          kind,
          {
            draws: member.batchOwner === undefined ? cost.draws : 0,
            triangles: member.triangles === undefined ? 0 : passTrianglesOf(member, cost),
          },
        ]),
      ),
      type: source.type,
      visible: source.visible,
      ...(member.batchOwner === undefined ? {} : { batchOwner: member.batchOwner }),
      ...(own === undefined ? {} : { selectedDetailTriangles: own }),
      ...(base === undefined ? {} : { fullDetailTriangles: base }),
      ...(memberTriangles === undefined ? {} : { submittedTriangles: memberTriangles }),
      ...(memberTriangles === undefined ? {} : { trianglesSource: member.trianglesSource }),
      ...(rendered.isInstancedMesh === true ? { instances: Math.max(0, rendered.count ?? 0) } : {}),
      ...(member.record.unavailable.size === 0
        ? {}
        : { unavailable: [...member.record.unavailable] }),
    });
  }

  const projected = boundsKnown
    ? projectedSize(bounds, armed.camera, armed.viewportHeight)
    : undefined;
  const centre = boundsKnown
    ? projectedCenter(bounds.center, armed.camera, armed.viewportWidth, armed.viewportHeight)
    : undefined;
  // Frustum membership of the union bounds. Unknown bounds leave it unstated rather than false:
  // "not in the frustum" and "we could not tell" are different answers.
  const inFrustum =
    boundsKnown && frustum !== undefined ? frustum.intersectsSphere(bounds) : undefined;
  if (!boundsKnown) unavailable.add("TN_GEOMETRY_NO_BOUNDS");
  const viewportArea = armed.viewportWidth * armed.viewportHeight;
  const lod = lodOf(root);

  return {
    copies,
    draws,
    generation: armed.generation,
    id: `${String(armed.generation)}:${String(index)}`,
    materials: materials.size,
    meshes,
    name: displayName(root),
    path: nodePath(root, armed.root),
    submissions,
    type: root.type,
    // Submission is a draw the renderer made, never a cost that happens to be known. A hidden
    // mesh's triangle buffer is still countable; it was not drawn.
    visibility: members.some((member) => member.record.draws > 0) ? "submitted" : "notSubmitted",
    ...(batch === undefined ? {} : { batch }),
    ...(assetOf(root) === undefined ? {} : { asset: assetOf(root) as string }),
    ...(full === undefined ? {} : { fullDetailTriangles: full }),
    ...(selected === undefined ? {} : { selectedDetailTriangles: selected }),
    ...(submitted === undefined ? {} : { submittedTriangles: submitted }),
    ...(submitted === undefined ? {} : { trianglesSource }),
    ...(instances === undefined ? {} : { instances }),
    ...(inFrustum === undefined ? {} : { inFrustum }),
    ...(lod === undefined ? {} : { lod }),
    ...(uniqueGeometries.size === 0
      ? {}
      : {
          uniqueTriangles: [...uniqueGeometries.values()].reduce(
            (total, value) => total + value,
            0,
          ),
        }),
    ...(projected === undefined
      ? {}
      : {
          cameraDistance: projected.distance,
          projectedPixels: projected.pixels,
          ...(centre === undefined ? {} : { projectedCenter: centre }),
          ...(viewportArea > 0
            ? { viewportFraction: (Math.PI * (projected.pixels / 2) ** 2) / viewportArea }
            : {}),
        }),
    ...(unavailable.size === 0 ? {} : { unavailable: [...unavailable] }),
  };
}

/** LOD0 triangles, when the discrete chain can still name the source detail. */
function baseTriangles(rendered: IRenderedLike): number | undefined {
  if (rendered.geometry === undefined) return undefined;
  try {
    const base = baseGeometryOf(rendered as Parameters<typeof baseGeometryOf>[0]);
    return geometryTriangles(base as IGeometryLike);
  } catch {
    return undefined;
  }
}

/** The capture camera's frustum, or undefined when the camera cannot be projected. */
function frustumOf(camera: Camera): Frustum | undefined {
  const matrix = new Matrix4();
  const projection = camera.projectionMatrix;
  if (projection === undefined) return undefined;
  matrix.multiplyMatrices(projection, camera.matrixWorldInverse);
  return new Frustum().setFromProjectionMatrix(matrix);
}

function lodOf(object: Object3D): IGeometryCaptureRow["lod"] {
  const rendered = object as IRenderedLike;
  if (rendered.isLOD !== true) return undefined;
  const levels = rendered.levels?.length;
  return levels === undefined ? undefined : { levels };
}

function cameraOf(camera: Camera): NonNullable<IGeometryCaptureReport["camera"]> {
  const like = camera as ICameraLike;
  const position = camera.getWorldPosition(new Vector3());
  return {
    position: [position.x, position.y, position.z],
    type:
      like.isOrthographicCamera === true
        ? "orthographic"
        : like.isPerspectiveCamera === true
          ? "perspective"
          : "unknown",
    ...(like.fov === undefined ? {} : { fov: like.fov }),
    ...(like.zoom === undefined ? {} : { zoom: like.zoom }),
    ...(like.near === undefined ? {} : { near: like.near }),
    ...(like.far === undefined ? {} : { far: like.far }),
  };
}

function assetRowsOf(rows: readonly IGeometryCaptureRow[]): IGeometryCaptureAsset[] {
  const byAsset = new Map<string, IGeometryCaptureRow[]>();
  for (const row of rows) {
    // Procedural and unknown geometry stays explicitly unattributed. A matching display name is
    // never grounds for merging two assets.
    const key = row.asset ?? "unattributed";
    const bucket = byAsset.get(key);
    if (bucket === undefined) byAsset.set(key, [row]);
    else bucket.push(row);
  }
  return [...byAsset]
    .map(([asset, group]) => {
      const unavailable = new Set<string>();
      for (const row of group) for (const reason of row.unavailable ?? []) unavailable.add(reason);
      return {
        asset,
        draws: group.reduce((total, row) => total + row.draws, 0),
        objects: group.length,
        ...(sum(group.map((row) => row.submittedTriangles)) === undefined
          ? {}
          : { submittedTriangles: sum(group.map((row) => row.submittedTriangles)) as number }),
        ...(sum(group.map((row) => row.uniqueTriangles)) === undefined
          ? {}
          : { uniqueTriangles: sum(group.map((row) => row.uniqueTriangles)) as number }),
        ...(unavailable.size === 0 ? {} : { unavailable: [...unavailable] }),
      };
    })
    .sort((left, right) => (right.submittedTriangles ?? -1) - (left.submittedTriangles ?? -1));
}

/**
 * Attributed rows against the frame's measured pass totals. The remainder is reported, not hidden:
 * a report whose rows quietly account for a third of the frame is worse than one that says so.
 */
function reconcile(
  passes: readonly IRenderPassSample[],
  drafts: readonly IMeshDraft[],
): IGeometryCapturePass[] {
  const measured = new Map<FramePassKind, { draws: number; triangles: number }>();
  for (const pass of passes) {
    const into = measured.get(pass.kind) ?? { draws: 0, triangles: 0 };
    into.draws += pass.draws;
    into.triangles += pass.triangles;
    measured.set(pass.kind, into);
  }
  const attributed = new Map<FramePassKind, { draws: number; triangles: number }>();
  const seen = new Set<ISubmissionRecord>();
  for (const draft of drafts) {
    for (const [kind, cost] of draft.record.byPass) {
      const into = attributed.get(kind) ?? { draws: 0, triangles: 0 };
      // A record's own draws are counted once however many sources it folded.
      if (!seen.has(draft.record)) into.draws += cost.draws;
      into.triangles += draft.triangles === undefined ? 0 : passTrianglesOf(draft, cost);
      attributed.set(kind, into);
    }
    seen.add(draft.record);
  }
  const kinds = new Set<FramePassKind>([...measured.keys(), ...attributed.keys()]);
  return [...kinds].map((kind) => {
    const total = measured.get(kind) ?? { draws: 0, triangles: 0 };
    const rows = attributed.get(kind) ?? { draws: 0, triangles: 0 };
    return {
      attributedDraws: rows.draws,
      attributedTriangles: rows.triangles,
      draws: total.draws,
      kind,
      triangles: total.triangles,
      unattributedDraws: total.draws - rows.draws,
      unattributedTriangles: total.triangles - rows.triangles,
    };
  });
}
