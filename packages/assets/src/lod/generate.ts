// PRD-377 §4.3 — error-driven, bounded discrete-LOD generation inside the existing asset cook.
//
// The simplifier is the one already integrated for virtual geometry (`meshoptimizer` via glTF
// Transform); this module adds no new dependency. Every level is derived from the same LOD0
// reference and stored as an index-only view over LOD0's vertices, so nothing moves, nothing is
// reconstructed, and the authored GLB is never overwritten.

import { createHash } from "node:crypto";
import type {
  Accessor,
  Document,
  Node as GltfNode,
  Material,
  Mesh,
  Primitive,
  Scene,
  TypedArray,
} from "@gltf-transform/core";
import {
  compactPrimitive,
  joinPrimitives,
  listNodeScenes,
  transformPrimitive,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { Matrix4 } from "three";
import { type IFoliageCutoutSummary, convertFoliageCutout } from "../foliage.js";
import { TN_VIRTUAL_GEOMETRY } from "../virtual/extension.js";
import { type ICardCopies, type ICardLevelSummary, generateCardChain } from "./cards.js";
import {
  type DiscreteLodSkipReason,
  type LodMinTrianglesScope,
  authoredLodName,
  classifyJoinCandidate,
  classifyPrimitive,
  primitiveTriangleCount,
} from "./eligibility.js";

export type { DiscreteLodSkipReason, LodMinTrianglesScope } from "./eligibility.js";
import {
  type DiscreteLod,
  type IJoinedRungMetadata,
  type ILodArtifactMetadata,
  TNDiscreteLod,
  TN_DISCRETE_LOD,
  attachDiscreteLod,
  discreteLodBytes,
} from "./extension.js";

/** Generation knobs, shared by every preset (PRD-377 §3.2); both are ceilings, not promises. */
export interface IModelLodGenerationOptions {
  /**
   * Versioned increasing geometric-error targets, in normalized mesh-extent units. Each target is
   * simplified from LOD0 independently; a target that cannot reduce is dropped. Default
   * {@link LOD_ERROR_TARGETS}.
   */
  readonly errorTargets?: readonly number[];
  /** Levels in the chain including LOD0; integer 1–8. Default {@link DEFAULT_LOD_MAX_LEVELS}. */
  readonly maxLevels?: number;
  /**
   * Fraction of its predecessor's triangles a derived level must save to be kept. Default
   * {@link LOD_MIN_SAVING}. This is the benefit gate: an inability to reach it is a normal skip.
   */
  readonly minSaving?: number;
  /**
   * Cheap pre-filter floor in triangles. It is not the benefit gate — {@link minSaving} is — and
   * only skips work where the simplifier's fixed per-call cost would dominate. Default
   * {@link DEFAULT_LOD_MIN_TRIANGLES}.
   */
  readonly minTriangles?: number;
  /**
   * What {@link minTriangles} is measured against. Default
   * {@link DEFAULT_LOD_MIN_TRIANGLES_SCOPE}, which floors the whole asset rather than each
   * primitive, so a model split into many small primitives is still measured by its total.
   */
  readonly minTrianglesScope?: LodMinTrianglesScope;
  /**
   * Opt-in far rung that joins a mesh's same-material primitives into one draw per material group
   * (PRD-377 §4.4 extension). **Default `false`: with no option the cook is byte-identical to
   * today.** A join never crosses a material, never touches a skinned, morph-target or animated
   * node, and never leaves the mesh's own node, so authored LOD0, node identity and picking are
   * untouched; the joined geometry is an additional far rung beside LOD0.
   */
  readonly join?: boolean;
}

/** Quality policy for automatic LOD; it selects the projected pixel-error budget (PRD-377 §3.2). */
export type LodPreset = "aggressive" | "balanced" | "quality";

/** Screen-space selection knobs; they change what the runtime picks, never what is baked. */
export interface IModelLodRuntimeOptions {
  /** Projected geometric-error budget in raster pixels; positive finite. */
  readonly maxPixelError?: number;
  /** Fraction in `[0, 0.5)`, default 0.15, that stabilizes coarsening at a boundary. */
  readonly hysteresis?: number;
}

/** A partial override for one asset; nested objects overlay, they never replace. */
export interface IModelLodOverride {
  readonly cutout?: boolean;
  readonly enabled?: boolean;
  readonly generation?: IModelLodGenerationOptions;
  readonly preset?: LodPreset;
  readonly runtime?: IModelLodRuntimeOptions;
}

/**
 * `assets.lod`, as the compile step reads it. Absent or `{}` resolves to enabled/balanced; `false`
 * and `{ enabled: false }` are equivalent absolute kill switches that no per-asset override can
 * re-enable. Resolution is per asset and happens where the asset is known (PRD-377 §3.2, §5).
 */
export interface IModelLodOptions {
  /**
   * Convert eligible `BLEND` foliage to alpha-tested in the cook (PRD-458 §4). Default `true`,
   * because a needle card exported as `BLEND` is refused a chain by rule and the tree then draws
   * LOD0 forever. `false` keeps the authored blending; per asset, `cutout` in an override entry.
   */
  readonly cutout?: boolean;
  readonly enabled?: boolean;
  readonly generation?: IModelLodGenerationOptions;
  readonly overrides?: Readonly<Record<string, boolean | IModelLodOverride>>;
  readonly preset?: LodPreset;
  readonly runtime?: IModelLodRuntimeOptions;
}

export const LOD_GENERATOR = "threenative-discrete-lod";
/**
 * Bumped when the *generated levels* change, so a stale cook cache cannot serve the old chain. The
 * artifact schema stays put: a chain with or without the terminal level reads the same.
 */
export const LOD_GENERATOR_VERSION = 4;
/** Bumped with the output layout so a stale cache entry cannot hide a schema change. */
export const LOD_ARTIFACT_SCHEMA_VERSION = 1;
/** The pinned simplifier this artifact's error metric was produced with. */
export const LOD_TOOLCHAIN = "meshoptimizer@1.1.1";

/**
 * Versioned increasing geometric-error targets, normalized to the mesh extent. Error-driven rather
 * than a forced `100/50/20/5` ladder: the simplifier stops at the topology the error allows, and a
 * level that saves less than {@link LOD_MIN_SAVING} is dropped rather than shipped for its own sake.
 * Overridable through `assets.lod.generation.errorTargets`.
 */
export const LOD_ERROR_TARGETS: readonly number[] = [0.002, 0.006, 0.02, 0.06];

/**
 * A derived level must save at least this fraction of its predecessor's triangles (PRD-377 §4.3).
 * This is the benefit gate the pre-filter only approximates; overridable through
 * `assets.lod.generation.minSaving`.
 */
export const LOD_MIN_SAVING = 0.2;

export const DEFAULT_LOD_MAX_LEVELS = 4;

/**
 * Every chain ends in one terminal coarse level, so a distant instance is never stranded on the
 * error-target ladder's floor. Measured on machinefall, the coarsest error level kept 87% of LOD0,
 * so a far pine cost 16k triangles at 285 m and the shadow levels drew tens of millions.
 *
 * The terminal level is cut by triangle count rather than error — `max` of this floor and
 * {@link LOD_TERMINAL_KEEP_RATIO} of LOD0 — and is exempt from the saving gate. A mesh already
 * under the floor gets no terminal level; there is nothing to gain.
 */
export const LOD_TERMINAL_MIN_TRIANGLES = 1500;
export const LOD_TERMINAL_KEEP_RATIO = 0.05;

/** The triangle target of a chain's terminal coarse level, in triangles. */
export function terminalLevelTriangles(lod0Triangles: number): number {
  return Math.max(LOD_TERMINAL_MIN_TRIANGLES, Math.ceil(LOD_TERMINAL_KEEP_RATIO * lod0Triangles));
}

/**
 * An effectively unbounded error target, used only for the terminal level: the count binds and the
 * simplifier reports the error it measured, which is the field the runtime's distance switch reads.
 */
const TERMINAL_TARGET_ERROR = 1e9;
/**
 * Cheap pre-filter floor in triangles, not the benefit gate.
 *
 * It exists only to avoid the simplifier's fixed per-primitive cost — an attribute pack and one
 * `simplifyWithAttributes` call per target — on units too small for any reduction to be worth the
 * chain bookkeeping. At ~64 quads the whole primitive is smaller than the rounding it would pay for;
 * below that, even a halving of the count is a rounding error against a frame. This is deliberately
 * low because the measured saving rule, not this, decides what ships.
 */
export const DEFAULT_LOD_MIN_TRIANGLES = 128;
/**
 * Default floor scope: the whole asset.
 *
 * A shipped carrier is 347,497 triangles over ~300 primitives of ~1,200, and a 10-15k aircraft is
 * ~600 per primitive; an absolute per-primitive floor below 5,000 made the feature inert on exactly
 * the assets that needed it. Measuring the total is project-agnostic and lets the saving rule reject
 * the primitives where simplification does not pay.
 */
export const DEFAULT_LOD_MIN_TRIANGLES_SCOPE: LodMinTrianglesScope = "asset";
/** Default hysteresis: coarsen only when the cheaper level falls below `(1 - h) * budget`. */
export const DEFAULT_LOD_HYSTERESIS = 0.15;

const LOD_PRESETS: readonly LodPreset[] = ["aggressive", "balanced", "quality"];

/** The preset's policy starting point. These are budgets to be measured against, not guarantees. */
export function presetPixelError(preset: LodPreset): number {
  switch (preset) {
    case "aggressive":
      return 2;
    case "quality":
      return 0.5;
    case "balanced":
      return 1;
  }
}

export function isLodPreset(value: unknown): value is LodPreset {
  return typeof value === "string" && (LOD_PRESETS as readonly string[]).includes(value);
}

export interface IModelLodLevel {
  /** Normalized simplifier error, in mesh-extent units. */
  readonly error: number;
  /** `error * errorScale`, in local-space units. */
  readonly absoluteError: number;
  readonly triangles: number;
}

export interface IModelLodPrimitiveSummary {
  readonly levels: readonly IModelLodLevel[];
  readonly mesh: string;
  readonly primitive: number;
  /**
   * Per-level card report, present only when the chain came from card thinning rather than the
   * triangle reducer (PRD-458 §4). Aligned with `levels`. `cellCoverage` is what the grid guarantees;
   * `areaCoverage` is the honest un-scaled number, equal to the keep ratio, because `TN_discrete_lod`
   * is index-only and cannot carry the per-level scale step — see `cards.ts`.
   */
  readonly cardLevels?: readonly ICardLevelSummary[];
  readonly strategy: "discrete" | "cards";
  readonly trianglesBefore: number;
}

export interface IModelLodSkipSummary {
  readonly mesh: string;
  readonly primitive: number;
  readonly reason: DiscreteLodSkipReason;
}

export interface IModelLodJoinedSource {
  readonly mesh: string;
  readonly primitive: number;
}

/** One material group's far draw inside a joined rung. */
export interface IModelLodJoinedGroup {
  readonly material: string;
  readonly primitives: number;
  readonly triangles: number;
  readonly error: number;
  readonly sources: readonly IModelLodJoinedSource[];
}

/** One mesh's joined far rung: the primitives it collapsed and the draws it produced. */
export interface IModelLodJoinedRungSummary {
  readonly draws: number;
  /** Absolute local-space error of the reduced far geometry; the runtime's coarsest step. */
  readonly error: number;
  readonly mesh: string;
  readonly primitives: number;
  readonly triangles: number;
  readonly trianglesBefore: number;
  readonly groups: readonly IModelLodJoinedGroup[];
}

/**
 * The opt-in join outcome, reported honestly: total draws after joining, the authored primitives
 * collapsed, the triangle counts, and per rung the exact source primitives that were joined.
 */
export interface IModelLodJoined {
  readonly draws: number;
  readonly groups: readonly IModelLodJoinedGroup[];
  readonly primitives: number;
  readonly rungs: readonly IModelLodJoinedRungSummary[];
  readonly triangles: number;
  readonly trianglesBefore: number;
}

export interface IModelLodSummary {
  readonly byteOverhead: number;
  /**
   * The foliage cutout conversion this asset got (PRD-458 §4). Present whenever the policy ran it,
   * including when nothing qualified — an empty list is the honest report of "no eligible `BLEND`".
   */
  readonly cutout: IFoliageCutoutSummary;
  /** Migration/legacy notes the resolver raised; never a silent winner over an explicit setting. */
  readonly diagnostics: readonly ILodDiagnostic[];
  readonly enabled: boolean;
  readonly fingerprint: string;
  readonly generated: number;
  /** The resolved opt-in join policy; its outcome, when anything joined, is in {@link joined}. */
  readonly join: boolean;
  /** Present only when the opt-in join actually produced a far rung. */
  readonly joined?: IModelLodJoined;
  readonly maxLevels: number;
  readonly minTriangles: number;
  readonly minTrianglesScope: LodMinTrianglesScope;
  readonly minSaving: number;
  readonly errorTargets: readonly number[];
  /** Max derived levels on any one primitive. */
  readonly levels: number;
  /** The quality policy the resolver chose; the runtime budget follows from it. */
  readonly preset: LodPreset;
  readonly primitives: readonly IModelLodPrimitiveSummary[];
  readonly reasons: readonly DiscreteLodSkipReason[];
  /** The runtime selection budget this asset ships with, serialized into the manifest. */
  readonly runtime: { readonly hysteresis: number; readonly maxPixelError: number };
  readonly skipped: number;
  readonly trianglesAfter: number;
  readonly trianglesBefore: number;
  readonly generatedSeconds: number;
}

/** One migration note from resolving a new declaration against a legacy one (PRD-377 §3.3). */
export interface ILodDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface ILodLegacyFlags {
  /** `assets.models.simplify` is declared. */
  readonly simplify?: boolean;
  /** `assets.models.virtual` is `"none"`. */
  readonly virtualNone?: boolean;
}

export interface IResolvedLodPolicy {
  /** Whether the cook converts eligible `BLEND` foliage to `MASK` before generation (PRD-458 §4). */
  readonly cutout: boolean;
  readonly diagnostics: readonly ILodDiagnostic[];
  readonly enabled: boolean;
  /** Generation and runtime are separate cache identities (PRD-377 §3.2, §5). */
  readonly fingerprint: { readonly generation: string; readonly runtime: string };
  readonly generation: {
    readonly errorTargets: readonly number[];
    readonly join: boolean;
    readonly maxLevels: number;
    readonly minSaving: number;
    readonly minTriangles: number;
    readonly minTrianglesScope: LodMinTrianglesScope;
  };
  readonly preset: LodPreset;
  readonly reasons: readonly DiscreteLodSkipReason[];
  readonly runtime: { readonly hysteresis: number; readonly maxPixelError: number };
}

/**
 * Asset override, then project, then default — PRD-377 §3.2. The chosen preset's defaults expand
 * once, then explicit project fields overlay, then explicit asset fields; nested objects overlay
 * field by field. The global `false` / `{ enabled: false }` is absolute. Legacy declarations
 * translate here rather than running as a parallel path: `models.virtual: "none"` keeps the asset
 * off unless a new declaration explicitly enables it, and an explicit legacy `simplify` skips
 * generation with `explicit-legacy-simplify`. A new and a legacy declaration for the same asset
 * produce a migration diagnostic, never a silent winner.
 */
export function resolveLodPolicy(
  lod: boolean | IModelLodOptions | "none" | undefined,
  asset: string,
  legacy: ILodLegacyFlags = {},
): IResolvedLodPolicy {
  const project = typeof lod === "object" && lod !== null ? lod : undefined;
  const override = project?.overrides?.[asset];
  const assetBlock = typeof override === "object" && override !== null ? override : undefined;
  const globalOff = lod === false || lod === "none" || project?.enabled === false;

  const preset = assetBlock?.preset ?? project?.preset ?? "balanced";
  const generation: {
    errorTargets: readonly number[];
    join: boolean;
    maxLevels: number;
    minSaving: number;
    minTriangles: number;
    minTrianglesScope: LodMinTrianglesScope;
  } = {
    errorTargets: [...LOD_ERROR_TARGETS],
    join: false,
    maxLevels: DEFAULT_LOD_MAX_LEVELS,
    minSaving: LOD_MIN_SAVING,
    minTriangles: DEFAULT_LOD_MIN_TRIANGLES,
    minTrianglesScope: DEFAULT_LOD_MIN_TRIANGLES_SCOPE,
  };
  const runtime = {
    hysteresis: DEFAULT_LOD_HYSTERESIS,
    maxPixelError: presetPixelError(preset),
  };
  // Project first, then the asset override, so an asset moves only the fields it names and every
  // knob is reachable globally and per asset (PRD-377 §3.2).
  for (const block of [project?.generation, assetBlock?.generation]) {
    if (block?.errorTargets !== undefined) generation.errorTargets = [...block.errorTargets];
    if (block?.join !== undefined) generation.join = block.join;
    if (block?.maxLevels !== undefined) generation.maxLevels = block.maxLevels;
    if (block?.minSaving !== undefined) generation.minSaving = block.minSaving;
    if (block?.minTriangles !== undefined) generation.minTriangles = block.minTriangles;
    if (block?.minTrianglesScope !== undefined)
      generation.minTrianglesScope = block.minTrianglesScope;
  }
  if (project?.runtime?.maxPixelError !== undefined)
    runtime.maxPixelError = project.runtime.maxPixelError;
  if (project?.runtime?.hysteresis !== undefined) runtime.hysteresis = project.runtime.hysteresis;
  if (assetBlock?.runtime?.maxPixelError !== undefined)
    runtime.maxPixelError = assetBlock.runtime.maxPixelError;
  if (assetBlock?.runtime?.hysteresis !== undefined)
    runtime.hysteresis = assetBlock.runtime.hysteresis;

  let enabled = project?.enabled ?? true;
  if (override === false) enabled = false;
  else if (override === true) enabled = true;
  else if (assetBlock?.enabled !== undefined) enabled = assetBlock.enabled;
  // The global kill switch is absolute: nothing above may outlive it.
  if (globalOff) enabled = false;

  const diagnostics: ILodDiagnostic[] = [];
  const reasons: DiscreteLodSkipReason[] = [];
  if (globalOff) {
    reasons.push("disabled");
  } else {
    // Any new declaration — even one that only names a generation knob — is a deliberate opt-in
    // when it conflicts with a legacy declaration (PRD-377 §3.3). An empty block or omission is
    // not a declaration, so the explicit legacy setting keeps its meaning.
    const explicitNewPolicy = lodHasExplicitPolicy(lod) || lodHasExplicitPolicy(override);
    if (legacy.virtualNone === true) {
      if (explicitNewPolicy) {
        diagnostics.push({
          code: "lod-legacy-virtual-none-conflict",
          message:
            'assets.models.virtual is "none" and assets.lod declares an automatic policy; the explicit declaration wins for this asset.',
          path: "assets.lod",
        });
      } else {
        enabled = false;
        reasons.push("virtual-none");
      }
    }
    if (legacy.simplify === true) {
      if (explicitNewPolicy) {
        diagnostics.push({
          code: "lod-legacy-simplify-conflict",
          message:
            "assets.models.simplify is declared and assets.lod declares an automatic policy; the explicit declaration wins for this asset.",
          path: "assets.lod",
        });
      } else {
        enabled = false;
        reasons.push("explicit-legacy-simplify");
      }
    }
  }
  if (!enabled && reasons.length === 0) reasons.push("disabled");

  // Independent of `enabled`: an asset may keep its authored blending while its neighbours get a
  // chain, and the global `false` / `"none"` still turns the whole block off.
  const cutout = !globalOff && (assetBlock?.cutout ?? project?.cutout ?? true);

  const generationFingerprint = lodFingerprint({
    algorithm: `${LOD_GENERATOR}/${String(LOD_GENERATOR_VERSION)}`,
    cutout,
    enabled,
    errorTargets: generation.errorTargets,
    join: generation.join,
    maxLevels: generation.maxLevels,
    minSaving: generation.minSaving,
    minTriangles: generation.minTriangles,
    minTrianglesScope: generation.minTrianglesScope,
    schema: LOD_ARTIFACT_SCHEMA_VERSION,
    toolchain: LOD_TOOLCHAIN,
  });
  return {
    cutout,
    diagnostics,
    enabled,
    fingerprint: {
      generation: generationFingerprint,
      runtime: lodFingerprint({
        enabled,
        generation: generationFingerprint,
        hysteresis: runtime.hysteresis,
        maxPixelError: runtime.maxPixelError,
        preset,
        schema: LOD_ARTIFACT_SCHEMA_VERSION,
      }),
    },
    generation,
    preset,
    reasons,
    runtime,
  };
}

/** True when a `lod` value declares at least one field; `{}` and omission are the same policy. */
function lodHasExplicitPolicy(
  value: boolean | IModelLodOptions | IModelLodOverride | "none" | undefined,
): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === "none") return false;
  return (
    value.enabled !== undefined ||
    value.preset !== undefined ||
    (value.generation !== undefined && Object.keys(value.generation).length > 0) ||
    (value.runtime !== undefined && Object.keys(value.runtime).length > 0) ||
    ("overrides" in value && value.overrides !== undefined)
  );
}

/** A stable 16-hex-character identity over the policy inputs that produced an artifact. */
function lodFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** A candidate level before the 20%-saving and monotonicity rules are applied. */
export interface ILodLevelCandidate {
  readonly error: number;
  readonly triangles: number;
}

/**
 * Applies PRD-377 §4.3's rejection rules to candidates ordered by increasing error: a level must
 * reduce triangles, must save at least `minSaving` of its predecessor, and its error must be no
 * lower than the last kept level's. `minSaving` defaults to {@link LOD_MIN_SAVING} and is the real
 * benefit gate — an inability to reach it is a normal skip, not a failure. A candidate that does not
 * reduce is skipped rather than ending the ladder, because each candidate was derived from LOD0
 * independently. A zero-error level is kept explicitly when it still removes work under the metric.
 */
export function selectDiscreteLevels(
  candidates: readonly ILodLevelCandidate[],
  maxLevels: number,
  referenceTriangles: number,
  minSaving: number = LOD_MIN_SAVING,
): readonly ILodLevelCandidate[] {
  const kept: ILodLevelCandidate[] = [];
  let previousTriangles = referenceTriangles;
  let previousError = -1;
  for (const candidate of candidates) {
    if (kept.length >= Math.max(0, maxLevels - 1)) break;
    if (candidate.triangles <= 0 || candidate.triangles >= previousTriangles) continue;
    const saving = (previousTriangles - candidate.triangles) / previousTriangles;
    if (saving < minSaving) continue;
    if (candidate.error < previousError) continue;
    kept.push(candidate);
    previousTriangles = candidate.triangles;
    previousError = candidate.error;
  }
  return kept;
}

/** Tightly packed float positions, the form the simplifier expects. */
function positionsOf(primitive: Primitive): Float32Array | null {
  const position = primitive.getAttribute("POSITION");
  if (position === null || position.getType() !== "VEC3") return null;
  const array = position.getArray();
  if (array === null) return null;
  if (array instanceof Float32Array && !position.getNormalized()) return array;
  const floats = new Float32Array(position.getCount() * 3);
  const element: number[] = [0, 0, 0];
  for (let vertex = 0; vertex < position.getCount(); vertex += 1) {
    position.getElement(vertex, element);
    floats[vertex * 3] = element[0] as number;
    floats[vertex * 3 + 1] = element[1] as number;
    floats[vertex * 3 + 2] = element[2] as number;
  }
  return floats;
}

/** LOD0 indices, or a lossless sequential indexing of suitable non-indexed input (PRD-377 §4.1). */
function sourceIndices(primitive: Primitive, vertexCount: number): Uint32Array {
  const indices = primitive.getIndices();
  if (indices === null) {
    const sequential = new Uint32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) sequential[vertex] = vertex;
    return sequential;
  }
  return Uint32Array.from(indices.getArray() as ArrayLike<number>);
}

interface IAttributePack {
  readonly data: Float32Array;
  readonly stride: number;
  readonly weights: number[];
}

/**
 * Packs the non-position attributes the simplifier may weight: normals, tangents, UV0/UV1 and
 * vertex colours. A normalized change of `1/weight` over distance `d` is about a change of `d` in
 * position, so normalized attributes get weight 1. Application data (`_` semantics) is left out:
 * its range is the application's own, and every level shares it unchanged.
 */
function packAttributes(primitive: Primitive, vertexCount: number): IAttributePack {
  const semantics = primitive
    .listSemantics()
    .filter((semantic) => semantic !== "POSITION" && !semantic.startsWith("_"));
  const accessors = semantics
    .map((semantic) => ({ accessor: primitive.getAttribute(semantic), semantic }))
    .filter(
      (
        entry,
      ): entry is {
        accessor: NonNullable<ReturnType<Primitive["getAttribute"]>>;
        semantic: string;
      } => entry.accessor !== null,
    );
  let stride = 0;
  for (const { accessor } of accessors) stride += accessor.getElementSize();
  if (stride === 0) return { data: new Float32Array(0), stride: 0, weights: [] };
  const data = new Float32Array(vertexCount * stride);
  const element: number[] = new Array<number>(stride).fill(0);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    let offset = 0;
    for (const { accessor } of accessors) {
      accessor.getElement(vertex, element);
      const size = accessor.getElementSize();
      for (let component = 0; component < size; component += 1)
        data[vertex * stride + offset + component] = element[component] as number;
      offset += size;
    }
  }
  return { data, stride, weights: new Array<number>(stride).fill(1) };
}

interface IGeneratedChain {
  readonly absoluteErrors: number[];
  readonly baselineTriangles: number;
  /** Per-level card report; present only on a card-thinned chain (PRD-458 §4). */
  readonly cardLevels?: readonly ICardLevelSummary[];
  readonly counts: number[];
  readonly errorScale: number;
  readonly errors: number[];
  readonly indices: Uint32Array[];
  readonly lod0Triangles: number;
  /** Scaled card copies the levels' indices point at, appended in level order; card chains only. */
  readonly vertexCopies?: readonly ICardCopies[];
}

/**
 * Every level is derived from the same LOD0 reference — never from the previous level — so the
 * reported error is relative to the authored geometry and a change to one target cannot disturb
 * another level's error budget (PRD-377 §4.3). Targets and the saving rule come from the resolved
 * policy; neither is a module constant the game cannot move.
 */
async function generateChain(
  primitive: Primitive,
  maxLevels: number,
  errorTargets: readonly number[],
  minSaving: number,
): Promise<IGeneratedChain | null> {
  const position = primitive.getAttribute("POSITION");
  if (position === null) return null;
  const positions = positionsOf(primitive);
  if (positions === null) return null;
  const vertexCount = position.getCount();
  const indices = sourceIndices(primitive, vertexCount);
  const lod0Triangles = Math.floor(indices.length / 3);
  if (lod0Triangles <= 0) return null;
  const scale = MeshoptSimplifier.getScale(positions, 3);
  const attributes = packAttributes(primitive, vertexCount);

  const candidates: { error: number; indices: Uint32Array; triangles: number }[] = [];
  for (const targetError of errorTargets) {
    // target_index_count 3 is the smallest triangle list; the error target is the binding
    // constraint, which is what makes this an error-driven chain rather than a ratio ladder.
    const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
      indices,
      positions,
      3,
      attributes.data,
      attributes.stride,
      attributes.weights,
      null,
      3,
      targetError,
      ["LockBorder"],
    );
    candidates.push({
      error,
      indices: Uint32Array.from(simplified),
      triangles: Math.floor(simplified.length / 3),
    });
  }
  const kept = selectDiscreteLevels(candidates, maxLevels, lod0Triangles, minSaving);
  if (kept.length === 0) return null;
  const keptSet = new Set(kept);
  const chain = candidates.filter((candidate) => keptSet.has(candidate));

  const previous = chain[chain.length - 1] as (typeof chain)[number];
  const terminal = terminalLevel(
    positions,
    indices,
    attributes,
    terminalLevelTriangles(lod0Triangles),
    previous.triangles,
    previous.error,
  );
  if (terminal !== null) chain.push(terminal);
  return {
    absoluteErrors: chain.map((level) => level.error * scale),
    baselineTriangles: lod0Triangles,
    counts: chain.map((level) => level.triangles),
    errorScale: scale,
    errors: chain.map((level) => level.error),
    indices: chain.map((level) => level.indices),
    lod0Triangles,
  };
}

/**
 * A position-welded copy of a primitive: compact vertices, plus a map back to LOD0's numbering.
 */
interface IWeldedMesh {
  readonly attributes: Float32Array;
  readonly indices: Uint32Array;
  /** Compacted vertex index to the original LOD0 vertex it was welded from. */
  readonly origin: Uint32Array;
  readonly positions: Float32Array;
}

/**
 * Weld coincident positions into one compact vertex, the form the simplifier can actually reduce.
 *
 * An exported card set is often triangle soup: every triangle's corners are its own vertices and
 * the buffer is not even compact, so the simplifier sees no shared edge and collapses nothing —
 * `Prune` then removes the whole mesh rather than reduce it. Compacting by position gives it the
 * topology the artist drew (the quad, the shared stem); {@link IWeldedMesh.origin} maps the
 * simplified indices back to LOD0's own numbering, so the level stays an index-only view.
 */
function weldMesh(
  positions: Float32Array,
  indices: Uint32Array,
  attributes: IAttributePack,
): IWeldedMesh {
  const vertexCount = Math.floor(positions.length / 3);
  const seen = new Map<string, number>();
  const remap = new Uint32Array(vertexCount);
  const origin: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const key = `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
    const compact = seen.get(key);
    if (compact === undefined) {
      seen.set(key, origin.length);
      remap[vertex] = origin.length;
      origin.push(vertex);
    } else remap[vertex] = compact;
  }
  const compactPositions = new Float32Array(origin.length * 3);
  const compactAttributes = new Float32Array(origin.length * attributes.stride);
  for (let compact = 0; compact < origin.length; compact += 1) {
    const source = origin[compact] as number;
    for (let axis = 0; axis < 3; axis += 1)
      compactPositions[compact * 3 + axis] = positions[source * 3 + axis] as number;
    for (let slot = 0; slot < attributes.stride; slot += 1)
      compactAttributes[compact * attributes.stride + slot] = attributes.data[
        source * attributes.stride + slot
      ] as number;
  }
  const compactIndices = new Uint32Array(indices.length);
  for (let index = 0; index < indices.length; index += 1)
    compactIndices[index] = remap[indices[index] as number] as number;
  return {
    attributes: compactAttributes,
    indices: compactIndices,
    origin: Uint32Array.from(origin),
    positions: compactPositions,
  };
}

/**
 * One terminal level past the error ladder, cut by triangle count rather than error and exempt from
 * the saving gate: the far instance needs *some* coarse step to reach, and a ladder that stalls at
 * 87% of LOD0 never gives it one. It drops the border lock — a level this far out owes no stitch
 * fidelity — while the target count binds and the measured error is recorded exactly as the
 * error-target levels' is, so the runtime's distance switch reads it the same way.
 *
 * Two passes: `Prune` with the attribute weights when the mesh has real topology, then a position
 * weld with unweighted attributes for the triangle soup an exporter leaves behind.
 */
function terminalLevel(
  positions: Float32Array,
  indices: Uint32Array,
  attributes: IAttributePack,
  terminalTriangles: number,
  previousTriangles: number,
  previousError: number,
): { error: number; indices: Uint32Array; triangles: number } | null {
  if (terminalTriangles >= previousTriangles) return null;
  const target = terminalTriangles * 3;
  // `Prune` spends whole isolated components and keeps the attribute weights, so a mesh with real
  // topology reduces without smearing.
  if (attributes.stride > 0) {
    const [pruned, pruneError] = MeshoptSimplifier.simplifyWithAttributes(
      indices,
      positions,
      3,
      attributes.data,
      attributes.stride,
      attributes.weights,
      null,
      target,
      TERMINAL_TARGET_ERROR,
      ["Prune"],
    );
    const triangles = Math.floor(pruned.length / 3);
    // Accept only a prune that actually reached the target: a reduction that stalls above it is
    // exactly the stall the terminal exists to break, and the weld below is the fallback for it.
    if (triangles > 0 && triangles <= terminalTriangles && triangles < previousTriangles)
      return {
        error: Math.max(pruneError, previousError),
        indices: Uint32Array.from(pruned),
        triangles,
      };
  }
  // A triangle soup has no component to spend that is not the whole mesh, so it falls back to a
  // position weld with the attributes unweighted for this far level only — the seam can no longer
  // block a collapse it cannot be seen through. The simplified indices map back to LOD0's own.
  const welded = weldMesh(positions, indices, attributes);
  let compacted: Uint32Array;
  let weldedError: number;
  if (attributes.stride === 0) {
    [compacted, weldedError] = MeshoptSimplifier.simplify(
      welded.indices,
      welded.positions,
      3,
      target,
      TERMINAL_TARGET_ERROR,
      [],
    );
  } else {
    [compacted, weldedError] = MeshoptSimplifier.simplifyWithAttributes(
      welded.indices,
      welded.positions,
      3,
      welded.attributes,
      attributes.stride,
      new Array<number>(attributes.stride).fill(0),
      null,
      target,
      TERMINAL_TARGET_ERROR,
      [],
    );
  }
  const triangles = Math.floor(compacted.length / 3);
  if (triangles <= 0 || triangles >= previousTriangles) return null;
  const mapped = new Uint32Array(compacted.length);
  for (let index = 0; index < compacted.length; index += 1)
    mapped[index] = welded.origin[compacted[index] as number] as number;
  return {
    error: Math.max(weldedError, previousError),
    indices: mapped,
    triangles,
  };
}

/**
 * The terminal level alone, for a primitive whose error ladder kept nothing.
 *
 * `LockBorder` on an all-border shape — every foliage card, a trunk of separate quads — refuses
 * every error-target collapse, so `generateChain` returns `null` and the primitive was left at LOD0
 * in every runtime level. The terminal pass is the one that exists for exactly this shape: it drops
 * the border lock, so a tree's bark and trunk get a coarse step too, not only its needle cards.
 */
function generateTerminalChain(primitive: Primitive): IGeneratedChain | null {
  const position = primitive.getAttribute("POSITION");
  if (position === null) return null;
  const positions = positionsOf(primitive);
  if (positions === null) return null;
  const vertexCount = position.getCount();
  const indices = sourceIndices(primitive, vertexCount);
  const lod0Triangles = Math.floor(indices.length / 3);
  if (lod0Triangles <= 0) return null;
  const scale = MeshoptSimplifier.getScale(positions, 3);
  const attributes = packAttributes(primitive, vertexCount);
  const terminal = terminalLevel(
    positions,
    indices,
    attributes,
    terminalLevelTriangles(lod0Triangles),
    lod0Triangles,
    0,
  );
  if (terminal === null) return null;
  return {
    absoluteErrors: [terminal.error * scale],
    baselineTriangles: lod0Triangles,
    counts: [terminal.triangles],
    errorScale: scale,
    errors: [terminal.error],
    indices: [terminal.indices],
    lod0Triangles,
  };
}

/**
 * The card ladder for a primitive the triangle reducer could not improve (PRD-458 §4).
 *
 * Two gates, both from the primitive itself rather than from a setting: the material must be `MASK`
 * (an alpha-tested card is a hole you can see, so a `BLEND` primitive keeps its `BLEND` refusal no
 * matter how card-shaped its index buffer is), and the index buffer must decompose into cards. The
 * chain it returns is the same shape as the triangle chain's, so everything downstream — the
 * attachment, the writer, the runtime, the validation — is the same code path.
 */
function generateCardsChain(
  primitive: Primitive,
  maxLevels: number,
  minSaving: number,
): IGeneratedChain | null {
  if (primitive.getMaterial()?.getAlphaMode() !== "MASK") return null;
  const positions = positionsOf(primitive);
  if (positions === null) return null;
  const vertexCount = Math.floor(positions.length / 3);
  const indices = sourceIndices(primitive, vertexCount);
  const scale = MeshoptSimplifier.getScale(positions, 3);
  const chain = generateCardChain(
    positions,
    indices,
    maxLevels,
    minSaving,
    scale,
    undefined,
    terminalLevelTriangles(Math.floor(indices.length / 3)),
  );
  if (chain === null) return null;
  return {
    absoluteErrors: [...chain.absoluteErrors],
    baselineTriangles: chain.lod0Triangles,
    cardLevels: chain.levels,
    counts: [...chain.counts],
    errorScale: scale,
    errors: [...chain.errors],
    indices: [...chain.indices],
    lod0Triangles: chain.lod0Triangles,
    vertexCopies: chain.copies,
  };
}

/**
 * Appends a card chain's scaled copies to every attribute of `primitive`, in level order, so the
 * levels' indices resolve. Each attribute gets a new accessor: another primitive sharing the old one
 * keeps its own vertex count. LOD0's indices are untouched and never reach a copy.
 */
function appendCardCopies(primitive: Primitive, copies: readonly ICardCopies[]): void {
  const base = primitive.getAttribute("POSITION")?.getCount() ?? 0;
  let added = 0;
  for (const level of copies) added += level.source.length;
  if (added === 0) return;
  for (const semantic of primitive.listSemantics()) {
    const accessor = primitive.getAttribute(semantic) as Accessor;
    const size = accessor.getElementSize();
    const array = accessor.getArray() as TypedArray;
    const grown = new (array.constructor as new (length: number) => TypedArray)(
      (base + added) * size,
    );
    grown.set(array.subarray(0, base * size));
    let at = base;
    for (const level of copies)
      for (const vertex of level.source) {
        grown.set(array.subarray(vertex * size, vertex * size + size), at * size);
        at += 1;
      }
    const extended = accessor.clone().setArray(grown);
    if (semantic === "POSITION") {
      at = base;
      for (const level of copies)
        for (let copy = 0; copy < level.source.length; copy += 1, at += 1)
          extended.setElement(at, Array.from(level.positions.subarray(copy * 3, copy * 3 + 3)));
    }
    primitive.setAttribute(semantic, extended);
  }
}

function reachableNodes(document: Document): GltfNode[] {
  const visited = new Set<GltfNode>();
  const nodes: GltfNode[] = [];
  const walk = (node: GltfNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    nodes.push(node);
    node.listChildren().forEach(walk);
  };
  document
    .getRoot()
    .listScenes()
    .flatMap((scene) => scene.listChildren())
    .forEach(walk);
  return nodes;
}

interface IMeshFlags {
  animated: boolean;
  authoredLod: boolean;
  skinned: boolean;
}

/**
 * Nodes targeted by an animation channel. A joined rung has no rig and no per-node channels, so a
 * transform clip on the node would drive the authored mesh while leaving the joined rung behind;
 * those nodes are refused outright rather than guessed about.
 */
function animatedNodes(document: Document): Set<GltfNode> {
  const targeted = new Set<GltfNode>();
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode();
      if (node !== null) targeted.add(node);
    }
  }
  return targeted;
}

function meshFlags(document: Document, animated: Set<GltfNode>): Map<Mesh, IMeshFlags> {
  const flags = new Map<Mesh, IMeshFlags>();
  const levelNamed = new Set<Mesh>();
  let levelNodes = 0;
  for (const node of reachableNodes(document)) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    const current = flags.get(mesh) ?? { animated: false, authoredLod: false, skinned: false };
    current.skinned ||= node.getSkin() !== null;
    current.animated ||= animated.has(node);
    if (authoredLodName(node.getName()) || authoredLodName(mesh.getName())) {
      levelNamed.add(mesh);
      levelNodes += 1;
    }
    flags.set(mesh, current);
  }
  // An authored chain is two or more level-named nodes in one asset. A lone level name (a pack's
  // `_LOD2` exported as a model of its own) has no sibling for anything to select, so it is this
  // asset's LOD0 and gets a generated chain like any other mesh.
  if (levelNodes > 1)
    for (const mesh of levelNamed) (flags.get(mesh) as IMeshFlags).authoredLod = true;
  return flags;
}

function emptySummary(
  policy: IResolvedLodPolicy,
  generatedSeconds: number,
  cutout: IFoliageCutoutSummary = { converted: [], kept: [] },
): IModelLodSummary {
  return {
    byteOverhead: 0,
    cutout,
    diagnostics: [...policy.diagnostics],
    enabled: policy.enabled,
    errorTargets: [...policy.generation.errorTargets],
    fingerprint: policy.fingerprint.generation,
    generated: 0,
    join: policy.generation.join,
    levels: 0,
    maxLevels: policy.generation.maxLevels,
    minSaving: policy.generation.minSaving,
    minTriangles: policy.generation.minTriangles,
    minTrianglesScope: policy.generation.minTrianglesScope,
    preset: policy.preset,
    primitives: [],
    reasons: [...policy.reasons],
    runtime: { ...policy.runtime },
    skipped: 0,
    trianglesAfter: 0,
    trianglesBefore: 0,
    generatedSeconds,
  };
}

/** Stable signature of "these primitives can be joined": same material, mode and attribute layout. */
function joinGroupKey(primitive: Primitive, materials: Map<Material, number>): string {
  const material = primitive.getMaterial();
  const materialKey = material === null ? "none" : String(materials.get(material) ?? -1);
  const attributes = [...primitive.listSemantics()]
    .sort()
    .map((semantic) => {
      const accessor = primitive.getAttribute(semantic);
      return accessor === null
        ? semantic
        : `${semantic}:${String(accessor.getComponentType())}:${accessor.getType()}:${accessor.getNormalized() ? 1 : 0}`;
    })
    .join(",");
  return `${materialKey}|${String(primitive.getMode())}|${attributes}`;
}

interface IJoinedBuild {
  readonly joined: IModelLodJoined;
  readonly metadata: readonly IJoinedRungMetadata[];
}

/** A sibling mesh node eligible for a joined rung, under one container. */
interface IJoinMember {
  readonly animated: boolean;
  readonly mesh: Mesh;
  readonly node: GltfNode;
  readonly skinned: boolean;
}

const IDENTITY_MATRIX = new Matrix4();

/**
 * True when `node` or any ancestor strictly below `container` is animation-targeted. The container
 * itself may move: the rung is baked in container space and rides along with it.
 */
function movableUnder(
  node: GltfNode,
  container: GltfNode | Scene,
  animated: ReadonlySet<GltfNode>,
): boolean {
  let current: GltfNode | null = node;
  while (current !== null && (current as unknown) !== container) {
    if (animated.has(current)) return true;
    current = current.getParentNode();
  }
  return false;
}

/** The local-to-`container` transform of `node`, composed from the local matrices on the path. */
function relativeMatrix(node: GltfNode, container: GltfNode | Scene): Matrix4 {
  const matrix = new Matrix4();
  let current: GltfNode | null = node;
  while (current !== null && (current as unknown) !== container) {
    matrix.premultiply(new Matrix4().fromArray(current.getMatrix()));
    current = current.getParentNode();
  }
  return matrix;
}

/** A copy of `primitive` with `matrix` baked into its vertex streams, leaving the authored one alone. */
function isolateTransformed(primitive: Primitive, matrix: Matrix4): Primitive {
  // `compactPrimitive` rewrites its input in place; clone first so the authored LOD0 keeps its own
  // accessors and only the detached copy is compacted and transformed.
  const isolated = primitive.clone();
  compactPrimitive(isolated);
  transformPrimitive(isolated, matrix.elements);
  return isolated;
}

/**
 * The opt-in join (PRD-377 §4.4 extension). Groups every eligible primitive under one shared
 * container by material and attribute layout and merges each group into one primitive — across
 * sibling meshes, not just within one. `joinPrimitives` already refuses incompatible groups, so a
 * join can never cross a material; the sibling's transform-relative-to-container is baked into its
 * vertices first, and the detached far mesh never replaces the authored one, so LOD0, node identity,
 * picking and per-node visibility are untouched.
 *
 * Only a site where a group actually collapses two or more primitives gets a rung: single-primitive
 * material groups gain nothing and are left alone when nothing collapses. Structural refusals are per
 * member — an animated, skinned, morphed or node-instanced part is left authored and a site that
 * loses enough members collapses nothing. Returns `null` when nothing joined.
 */
async function buildJoinedRungs(
  document: Document,
  policy: IResolvedLodPolicy,
  reason: (reason: DiscreteLodSkipReason) => void,
): Promise<IJoinedBuild | null> {
  const root = document.getRoot();
  const buffer = root.listBuffers()[0] ?? document.createBuffer();
  const materials = new Map<Material, number>();
  for (const material of root.listMaterials()) materials.set(material, materials.size);

  const animated = animatedNodes(document);
  const nodes = reachableNodes(document);
  // A mesh referenced by more than one node is instanced by the node graph: its local transform is
  // not single-valued, so it is left authored rather than guessed about.
  const meshRefs = new Map<Mesh, number>();
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh !== null) meshRefs.set(mesh, (meshRefs.get(mesh) ?? 0) + 1);
  }
  // A leaf mesh node has no mesh anywhere below it: nested mesh nodes are skipped so a rung never
  // overlaps a rung deeper in the graph and a primitive belongs to exactly one site.
  const hasMeshBelow = new Set<GltfNode>();
  const markMeshBelow = (node: GltfNode): boolean => {
    let found = false;
    for (const child of node.listChildren()) {
      if (child.getMesh() !== null || markMeshBelow(child)) {
        found = true;
        break;
      }
    }
    if (found) hasMeshBelow.add(node);
    return found;
  };
  for (const node of nodes) if (node.getMesh() !== null) markMeshBelow(node);

  const sites = new Map<object, { container: GltfNode | Scene; members: IJoinMember[] }>();
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh === null || hasMeshBelow.has(node)) continue;
    // An `EXT_mesh_gpu_instancing` node draws its mesh once per instance; joining it would
    // collapse every placed copy onto the batch node's own transform, so it stays authored.
    if (node.getExtension("EXT_mesh_gpu_instancing") !== null) {
      reason("boundary-unsafe");
      continue;
    }
    if ((meshRefs.get(mesh) ?? 0) > 1) {
      reason("boundary-unsafe");
      continue;
    }
    const container =
      node.getParentNode() ?? (listNodeScenes(node)[0] as Scene | undefined) ?? null;
    if (container === null) continue;
    const site = sites.get(container) ?? { container, members: [] };
    site.members.push({
      animated: movableUnder(node, container, animated),
      mesh,
      node,
      skinned: node.getSkin() !== null,
    });
    sites.set(container, site);
  }

  const rungs: IModelLodJoinedRungSummary[] = [];
  const metadata: IJoinedRungMetadata[] = [];
  const usedNames = new Set<string>();
  let unnamed = 0;

  for (const site of sites.values()) {
    const { container } = site;
    const grouped = new Map<
      string,
      { primitives: Primitive[]; sources: IModelLodJoinedSource[]; trianglesBefore: number }
    >();
    for (const member of site.members) {
      if (member.animated) {
        reason("animated");
        continue;
      }
      if (member.skinned || member.mesh.listPrimitives().some((p) => p.listTargets().length > 0)) {
        reason("deforming");
        continue;
      }
      const transform = relativeMatrix(member.node, container);
      const identity = transform.equals(IDENTITY_MATRIX);
      member.mesh.listPrimitives().forEach((primitive, index) => {
        const eligibility = classifyJoinCandidate(primitive, {
          alreadyCooked: primitive.getExtension(TN_DISCRETE_LOD) !== null,
          animated: false,
          skinned: false,
          virtualOwned: primitive.getExtension(TN_VIRTUAL_GEOMETRY) !== null,
        });
        if (!eligibility.eligible) {
          if (eligibility.reason !== undefined) reason(eligibility.reason);
          return;
        }
        const joined = identity ? primitive : isolateTransformed(primitive, transform);
        const key = joinGroupKey(primitive, materials);
        const entry = grouped.get(key) ?? { primitives: [], sources: [], trianglesBefore: 0 };
        entry.primitives.push(joined);
        entry.sources.push({ mesh: member.mesh.getName(), primitive: index });
        entry.trianglesBefore += primitiveTriangleCount(primitive);
        grouped.set(key, entry);
      });
    }
    if (![...grouped.values()].some((entry) => entry.primitives.length >= 2)) continue;

    const meshNames = [...new Set(site.members.map((member) => member.mesh))];
    const single = meshNames.length === 1 ? (meshNames[0] as Mesh) : null;
    const baseName =
      (single !== null ? single.getName() : container.getName()) || `mesh${String(unnamed)}`;
    let farName = `${baseName}__lod_join`;
    while (usedNames.has(farName)) {
      unnamed += 1;
      farName = `${baseName}${String(unnamed)}__lod_join`;
    }
    usedNames.add(farName);
    const farMesh = document.createMesh(farName);
    const groups: IModelLodJoinedGroup[] = [];
    let rungTriangles = 0;
    let rungBefore = 0;
    for (const entry of grouped.values()) {
      let joined: Primitive;
      try {
        joined = joinPrimitives(entry.primitives);
      } catch {
        // An attribute layout glTF-Transform refuses to merge inside one material is left authored.
        reason("boundary-unsafe");
        continue;
      }
      farMesh.addPrimitive(joined);
      const position = joined.getAttribute("POSITION");
      let triangles = Math.floor(
        (joined.getIndices()?.getCount() ?? position?.getCount() ?? 0) / 3,
      );
      let error = 0;
      // Combined with the discrete chain: reduce the joined geometry to its coarsest accepted level.
      if (policy.generation.maxLevels > 1) {
        const chain = await generateChain(
          joined,
          policy.generation.maxLevels,
          policy.generation.errorTargets,
          policy.generation.minSaving,
        );
        if (chain !== null) {
          const level = chain.indices[chain.indices.length - 1] as Uint32Array;
          joined.setIndices(
            document
              .createAccessor()
              .setArray(Uint32Array.from(level))
              .setType("SCALAR")
              .setBuffer(buffer),
          );
          triangles = chain.counts[chain.counts.length - 1] as number;
          error = chain.absoluteErrors[chain.absoluteErrors.length - 1] as number;
        }
      }
      groups.push({
        error,
        material: entry.primitives[0]?.getMaterial()?.getName() ?? "",
        primitives: entry.primitives.length,
        sources: entry.sources,
        triangles,
      });
      rungTriangles += triangles;
      rungBefore += entry.trianglesBefore;
    }
    if (farMesh.listPrimitives().length === 0) {
      farMesh.dispose();
      continue;
    }
    const rung: IModelLodJoinedRungSummary = {
      draws: farMesh.listPrimitives().length,
      // The conservative rung error: the coarsest group's, since the runtime picks or rejects the
      // whole joined object as one step, not one material at a time.
      error: groups.reduce((worst, group) => Math.max(worst, group.error), 0),
      groups,
      mesh: farName,
      primitives: groups.reduce((total, group) => total + group.primitives, 0),
      triangles: rungTriangles,
      trianglesBefore: rungBefore,
    };
    rungs.push(rung);
    metadata.push({
      draws: rung.draws,
      error: rung.error,
      mesh: farName,
      meshes: [...new Set(groups.flatMap((group) => group.sources.map((source) => source.mesh)))],
      primitives: rung.primitives,
      sources: groups.flatMap((group) =>
        group.sources.map((source) => `${source.mesh}#${String(source.primitive)}`),
      ),
      triangles: rung.triangles,
    });
  }

  if (rungs.length === 0) return null;
  return {
    joined: {
      draws: rungs.reduce((total, rung) => total + rung.draws, 0),
      groups: rungs.flatMap((rung) => rung.groups),
      primitives: rungs.reduce((total, rung) => total + rung.primitives, 0),
      rungs,
      triangles: rungs.reduce((total, rung) => total + rung.triangles, 0),
      trianglesBefore: rungs.reduce((total, rung) => total + rung.trianglesBefore, 0),
    },
    metadata,
  };
}

/**
 * Generates a discrete chain on every eligible primitive and attaches `TN_discrete_lod`.
 *
 * Runs after `reorder` (the last stage that moves a vertex) and before `quantize` (which changes
 * what a position *is*, never which vertex it is), and after the virtual bake so an already-owned
 * primitive is never also discretely generated (PRD-377 §4.2).
 */
export async function generateDiscreteLod(
  document: Document,
  lod: boolean | IModelLodOptions | "none" | undefined,
  logicalPath: string,
  sourceDigest: string,
  legacy: ILodLegacyFlags = {},
  now: () => number = () => Date.now(),
): Promise<IModelLodSummary> {
  const started = now();
  const policy = resolveLodPolicy(lod, logicalPath, legacy);
  const fingerprint = policy.fingerprint.generation;
  // Before every early return: a `BLEND` needle card is refused a chain by rule, so the conversion
  // is what makes one possible at all — and an asset can opt into it with `enabled: false`.
  const cutout = policy.cutout
    ? await convertFoliageCutout(document)
    : { converted: [], kept: [] as const };
  if (!policy.enabled) return emptySummary(policy, (now() - started) / 1000, cutout);
  const joinRequested = policy.generation.join;
  const discrete = policy.generation.maxLevels > 1;
  // The join is orthogonal to the discrete ladder: a game can join with no discrete levels at all.
  if (!discrete && !joinRequested) return emptySummary(policy, (now() - started) / 1000, cutout);

  await MeshoptSimplifier.ready;

  const animated = animatedNodes(document);
  const flags = meshFlags(document, animated);
  const reasons = new Set<DiscreteLodSkipReason>(policy.reasons);
  // Join before the discrete chains attach: a joined rung must see the authored primitives, not the
  // cooked ones, and it shares none of the per-primitive `TN_discrete_lod` payloads.
  const joined = joinRequested
    ? await buildJoinedRungs(document, policy, (reason) => reasons.add(reason))
    : null;
  // The whole-asset total, computed once: the default floor scope compares every primitive against
  // it so a model split into many small primitives is measured by the asset, not the split.
  const assetTriangles = document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, primitive) => total + primitiveTriangleCount(primitive), 0);
  let extension: TNDiscreteLod | null = null;
  const primitives: IModelLodPrimitiveSummary[] = [];
  const skipped: IModelLodSkipSummary[] = [];
  let levels = 0;
  let byteOverhead = 0;
  let trianglesBefore = 0;
  let trianglesAfter = 0;

  for (const mesh of discrete ? document.getRoot().listMeshes() : []) {
    const meshState = flags.get(mesh) ?? { animated: false, authoredLod: false, skinned: false };
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const eligibility = classifyPrimitive(primitive, {
        alreadyCooked: primitive.getExtension(TN_DISCRETE_LOD) !== null,
        assetTriangles,
        authoredLod: meshState.authoredLod,
        legacySimplify: legacy.simplify === true,
        legacyVirtualNone: false,
        minTriangles: policy.generation.minTriangles,
        minTrianglesScope: policy.generation.minTrianglesScope,
        skinned: meshState.skinned,
        virtualOwned: primitive.getExtension(TN_VIRTUAL_GEOMETRY) !== null,
      });
      if (!eligibility.eligible) {
        const reason = eligibility.reason ?? "disabled";
        reasons.add(reason);
        skipped.push({ mesh: mesh.getName(), primitive: primitiveIndex, reason });
        continue;
      }
      const before = primitiveTriangleCount(primitive);
      trianglesBefore += before;
      // A needle card is two triangles, which the triangle reducer cannot cut without punching a
      // hole, so it declines — and a tree is a bark trunk plus needle cards. When that happens the
      // cards themselves are the unit to spend (PRD-458 §4), and the level it produces is an
      // index-only view over the very same vertices, on the primitive's own material.
      let chain = await generateChain(
        primitive,
        policy.generation.maxLevels,
        policy.generation.errorTargets,
        policy.generation.minSaving,
      );
      const thinned =
        chain === null
          ? generateCardsChain(primitive, policy.generation.maxLevels, policy.generation.minSaving)
          : null;
      chain ??= thinned;
      // A shape the error ladder declines and the card reducer cannot spend — the bark and trunk
      // beside a tree's cards — still gets its terminal coarse step. Otherwise it sits at LOD0 in
      // every runtime level and dominates the asset's far triangle count (PRD-473).
      let strategy: "cards" | "discrete" = thinned === null ? "discrete" : "cards";
      if (chain === null) {
        chain = generateTerminalChain(primitive);
        strategy = "discrete";
      }
      if (chain === null) {
        // No reducer could reach the configured saving: a normal skip, not a failure, and named
        // distinctly from the cheap pre-filter's `too-small`.
        reasons.add("insufficient-reduction");
        skipped.push({
          mesh: mesh.getName(),
          primitive: primitiveIndex,
          reason: "insufficient-reduction",
        });
        trianglesAfter += before;
        continue;
      }
      if (chain.vertexCopies !== undefined) appendCardCopies(primitive, chain.vertexCopies);
      extension ??= document.createExtension(TNDiscreteLod).setRequired(false);
      const property = attachDiscreteLod(document, extension, primitive, {
        ...chain,
        strategy,
      });
      byteOverhead += discreteLodBytes(property);
      levels = Math.max(levels, chain.counts.length);
      const finest = chain.counts[chain.counts.length - 1] ?? before;
      trianglesAfter += finest;
      primitives.push({
        levels: chain.counts.map((triangles, index) => ({
          absoluteError: chain.absoluteErrors[index] as number,
          error: chain.errors[index] as number,
          triangles,
        })),
        mesh: mesh.getName(),
        primitive: primitiveIndex,
        ...(chain.cardLevels === undefined ? {} : { cardLevels: chain.cardLevels }),
        strategy,
        trianglesBefore: before,
      });
    }
  }

  // The joined rung is recorded in the same extension's document metadata; when it is the only
  // output, the extension exists solely to carry that record.
  if (joined !== null) extension ??= document.createExtension(TNDiscreteLod).setRequired(false);
  const metadata: ILodArtifactMetadata = {
    generator: `${LOD_GENERATOR}/${String(LOD_GENERATOR_VERSION)}`,
    generationFingerprint: fingerprint,
    schemaVersion: LOD_ARTIFACT_SCHEMA_VERSION,
    sourceDigest,
    sourcePath: logicalPath,
    toolchain: LOD_TOOLCHAIN,
    ...(joined === null ? {} : { joined: joined.metadata }),
  };
  extension?.setMetadata(metadata);

  return {
    byteOverhead,
    cutout,
    diagnostics: [...policy.diagnostics],
    enabled: true,
    errorTargets: [...policy.generation.errorTargets],
    fingerprint,
    generated: primitives.length,
    join: joinRequested,
    ...(joined === null ? {} : { joined: joined.joined }),
    levels,
    maxLevels: policy.generation.maxLevels,
    minSaving: policy.generation.minSaving,
    minTriangles: policy.generation.minTriangles,
    minTrianglesScope: policy.generation.minTrianglesScope,
    preset: policy.preset,
    primitives,
    reasons: [...reasons],
    runtime: { ...policy.runtime },
    skipped: skipped.length,
    trianglesAfter,
    trianglesBefore,
    generatedSeconds: (now() - started) / 1000,
  };
}

/**
 * Validates a decoded artifact's `TN_discrete_lod` payload: version (in `read`), index ranges,
 * count/error monotonicity and the LOD0 triangle identity. Fails closed — a malformed chain must
 * stop the build here, not a game (PRD-377 §5, §7).
 */
export function validateDiscreteLod(root: ReturnType<Document["getRoot"]>): void {
  for (const mesh of root.listMeshes()) {
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const property = primitive.getExtension<DiscreteLod>(TN_DISCRETE_LOD);
      if (property === null) continue;
      const position = primitive.getAttribute("POSITION");
      if (position === null)
        throw new Error(
          `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} has a chain but no POSITION.`,
        );
      const vertices = position.getCount();
      const indices = property.getIndices();
      const counts = property.getCounts();
      const errors = property.getErrors();
      if (indices.length !== counts.length || counts.length !== errors.length)
        throw new Error(
          `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} has mismatched level arrays.`,
        );
      let previousTriangles = property.getLod0Triangles();
      let previousError = -1;
      for (const [level, accessor] of indices.entries()) {
        const array = accessor.getArray();
        if (array === null)
          throw new Error(
            `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} level ${String(level)} has no indices.`,
          );
        if (array.length % 3 !== 0)
          throw new Error(
            `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} level ${String(level)} is not a triangle list.`,
          );
        for (let index = 0; index < array.length; index += 1) {
          const value = array[index] as number;
          if (value < 0 || value >= vertices)
            throw new Error(
              `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} level ${String(level)} index ${String(value)} is out of range for ${String(vertices)} vertices.`,
            );
        }
        const triangles = Math.floor(array.length / 3);
        if (triangles <= 0 || triangles >= previousTriangles)
          throw new Error(
            `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} level ${String(level)} is not a reduction (${String(previousTriangles)} -> ${String(triangles)}).`,
          );
        const error = errors[level] as number;
        if (!Number.isFinite(error) || error < previousError)
          throw new Error(
            `TN_DISCRETE_LOD_INVALID: '${mesh.getName()}'#${String(primitiveIndex)} level ${String(level)} has non-monotonic error.`,
          );
        previousTriangles = triangles;
        previousError = error;
      }
    }
  }
}
