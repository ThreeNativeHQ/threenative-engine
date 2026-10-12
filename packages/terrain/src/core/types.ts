/**
 * Shared shapes for the recovered Strata evaluator. Every type here is derived from the recovered
 * `src/core/*` implementation and its `PARAMS` allow-lists, with explicit landform transform extensions. A recipe is plain
 * JSON, so the evaluator validates it at runtime and these types only describe what the evaluator
 * accepts.
 */

/** The eight material channels a splat sample carries, in channel order. */
export type MaterialId = "grass" | "dirt" | "rock" | "snow" | "sand" | "mud" | "road" | "moss";

/** Every operation type the evaluator accepts, in the recovered `OPERATION_TYPES` order. */
export type OperationType =
  | "noise"
  | "sculpt"
  | "smooth"
  | "flatten"
  | "ramp"
  | "stamp"
  | "erode"
  | "terrace"
  | "materials"
  | "paint"
  | "biome"
  | "scatter"
  | "clear"
  | "road"
  | "river"
  | "water"
  | "heightmap"
  | "paste";

/** The recoverable mask kinds; a mask is a serializable expression, never a callback. */
export type MaskType =
  | "all"
  | "none"
  | "circle"
  | "rectangle"
  | "height"
  | "slope"
  | "noise"
  | "biome"
  | "material"
  | "and"
  | "or"
  | "not";

/**
 * A serializable mask expression. `type` selects the fields that mean anything; `validateMask`
 * rejects every field the chosen type does not list, so this flat shape is the exact union the
 * evaluator accepts rather than a loose bag.
 */
export interface IMask {
  readonly type: MaskType;
  /** `circle` and `rectangle` centre in world metres as `[x, z]`. */
  readonly at?: readonly [number, number];
  readonly radius?: number;
  readonly size?: number | readonly [number, number];
  readonly rotation?: number;
  readonly falloff?: number;
  /** `height` metres and `slope` degrees. */
  readonly min?: number;
  readonly max?: number;
  readonly fade?: number;
  readonly scale?: number;
  readonly threshold?: number;
  readonly seed?: number;
  /** `biome` rule name or `material` channel. */
  readonly name?: string;
  readonly masks?: readonly IMask[];
  readonly mask?: IMask;
}

/** A mask compiled against one evaluated state: sample index in, weight out. */
export type MaskSampler = (index: number, x: number, z: number) => number;

/** A height block copied in or out of the document, in world metres, row-major. */
export interface IHeightData {
  readonly width: number;
  readonly height: number;
  /** Fluent calls accept a typed array and normalize it to a plain array before validation. */
  readonly values: readonly number[] | Float32Array;
}

/** World-space grid extent; every coordinate runs from `-size / 2` to `+size / 2`, Y is up. */
export interface IGrid {
  readonly size: number;
  readonly resolution: number;
}

/** The grid fields the samplers read. Heights are absolute world elevations in metres. */
export interface ISampledGrid extends IGrid {
  readonly height: Float32Array;
}

/** The subset of a world document the evaluator resolves before any operation runs. */
export interface ITerrainConfig {
  size: number;
  resolution: number;
  seed: number;
}

/** The serializable authoring document: one config plus an ordered, ID-addressable layer stack. */
export interface ITerrainDocument {
  version: 1;
  config: ITerrainConfig;
  layers: Layer[];
}

interface IOperationBase {
  /** Overrides the document seed for this layer only. */
  readonly seed?: number;
}

/** Stroke tools accept one `at` centre or a polyline `points`; `radius` is a radius, not a diameter. */
export interface IBrushParams extends IOperationBase {
  readonly at?: readonly [number, number];
  readonly points?: readonly (readonly [number, number])[];
  readonly radius?: number;
  /** Signed metres for `sculpt`, `0..1` for smoothing, flattening and painting. */
  readonly strength?: number;
  readonly falloff?: number;
  readonly shape?: "circle" | "square";
  readonly rotation?: number;
  readonly spacing?: number;
  readonly jitter?: number;
}

export interface INoiseParams extends IOperationBase {
  readonly amplitude?: number;
  readonly scale?: number;
  readonly octaves?: number;
  readonly persistence?: number;
  readonly lacunarity?: number;
  readonly mode?: "fbm" | "ridged" | "billow";
  readonly warp?: number;
  readonly base?: number;
  readonly blend?: "add" | "replace";
  readonly island?: boolean;
  readonly coastDepth?: number;
}

export interface ISculptParams extends IBrushParams {}

export interface ISmoothParams extends IBrushParams {
  readonly iterations?: number;
}

export interface IFlattenParams extends IBrushParams {
  /** Absolute metres; omitted or null levels the pad to the ground already under it. */
  readonly height?: number | null;
}

export interface IPaintParams extends IBrushParams {
  readonly material?: MaterialId;
}

export interface IStampParams extends IOperationBase {
  readonly at?: readonly [number, number];
  /** One radius, or `[x, z]` half-extents. */
  readonly radius?: number | readonly [number, number];
  readonly size?: number | readonly [number, number];
  readonly amplitude?: number;
  readonly shape?: "mountain" | "crater" | "ridge" | "valley" | "mesa" | "dune";
  readonly rotation?: number;
  readonly mirrorX?: boolean;
  readonly mirrorZ?: boolean;
  readonly blend?: "add" | "replace" | "min" | "max";
  readonly roughness?: number;
  /** Positive vertical gain, applied before offset; defaults to 1. */
  readonly scale?: number;
  /** Metres added to the scaled landform, including additive blends. */
  readonly offset?: number;
  readonly data?: IHeightData;
  readonly falloff?: number;
}

export interface IPasteParams extends Omit<IStampParams, "shape" | "roughness" | "amplitude"> {}

export interface IErodeParams extends IBrushParams {
  readonly method?: "thermal" | "hydraulic";
  readonly iterations?: number;
  /** Maximum stable slope in degrees. */
  readonly talus?: number;
  readonly rate?: number;
  readonly droplets?: number;
  readonly maxSteps?: number;
  readonly inertia?: number;
  readonly capacity?: number;
  readonly erosion?: number;
  readonly deposition?: number;
  readonly evaporation?: number;
}

export interface ITerraceParams extends IOperationBase {
  readonly step?: number;
  readonly softness?: number;
  readonly strength?: number;
  readonly offset?: number;
}

/** One ordered surface rule; a later rule can override an earlier one. */
export interface IMaterialRule {
  readonly material: MaterialId;
  readonly mask?: IMask;
  readonly strength?: number;
}

export interface IMaterialsParams extends IOperationBase {
  readonly base?: MaterialId;
  readonly rules: IMaterialRule[];
  readonly reset?: boolean;
}

export interface IBiomeParams extends IBrushParams {
  /** The biome key the mask's `biome` type reads, not a display name. */
  readonly name?: string;
  readonly value?: number;
}

export interface IScatterParams extends IOperationBase {
  readonly asset?: string;
  readonly count?: number;
  /** Guaranteed within one rule, never across rules. */
  readonly minDistance?: number;
  readonly scale?: number | readonly [number, number];
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly minSlope?: number;
  readonly maxSlope?: number;
  readonly avoidWater?: boolean;
  readonly offsetY?: number;
  readonly alignToNormal?: boolean;
}

export interface IClearParams extends IOperationBase {
  readonly target: "scatter" | "paint" | "biome" | "all";
  readonly asset?: string;
  readonly name?: string;
}

/** A spline control point; a null elevation means the spline reads the ground it crosses there. */
export type SplinePoint = readonly [number, number | null, number];

/**
 * Grading shared by roads, rivers and ramps. A following spline takes its elevation from the
 * terrain it crosses — low-passed along arc length, then held inside the grade and cut/fill limits
 * — so a corridor is a bench cut into a hillside rather than a causeway pinned above it.
 */
export interface IGradeParams {
  /** Defaults to true when a control point omits its elevation; absolute points keep their meaning. */
  readonly followTerrain?: boolean;
  /** Maximum rise per metre travelled along the centreline; default 0.12. */
  readonly maxGrade?: number;
  /** Maximum metres the centreline may cut below the ground it crosses; default 2.5. */
  readonly maxCut?: number;
  /** Maximum metres it may fill above it; default 1.5. */
  readonly maxFill?: number;
}

export interface IRoadParams extends IOperationBase, IGradeParams {
  readonly points: readonly SplinePoint[];
  readonly width?: number;
  readonly shoulder?: number;
  readonly material?: MaterialId;
  readonly smooth?: boolean;
}

export interface IRiverParams extends IRoadParams {
  readonly depth?: number;
  readonly water?: boolean;
  readonly waterWidth?: number;
  readonly color?: string | number;
  /** Validates non-increasing control-point Y instead of rewriting the profile. */
  readonly enforceDownhill?: boolean;
}

export interface IRampParams extends IOperationBase, IGradeParams {
  readonly from: SplinePoint;
  readonly to: SplinePoint;
  readonly width?: number;
  readonly shoulder?: number;
  readonly material?: MaterialId;
}

export interface IWaterParams extends IOperationBase {
  readonly kind?: "lake" | "ocean";
  readonly at?: readonly [number, number];
  readonly radius?: number;
  readonly level?: number;
  readonly color?: string | number;
}

export interface IHeightmapParams extends IOperationBase {
  readonly data: IHeightData;
  /** Optional footprint centre in metres; without footprint fields the map fills the world. */
  readonly at?: readonly [number, number];
  /** Full footprint width/depth in metres; defaults to the world size. */
  readonly size?: number | readonly [number, number];
  /** Degrees in the terrain X/Z plane, matching stamp/paste. */
  readonly rotation?: number;
  readonly falloff?: number;
  /** Positive vertical gain, applied before offset. */
  readonly scale?: number;
  readonly offset?: number;
  readonly blend?: "add" | "replace";
}

/** One recipe layer: a stable semantic `id`, its operation type, and that type's parameters. */
export interface ILayer<T extends OperationType = OperationType> {
  readonly id: string;
  readonly type: T;
  readonly params: LayerParams[T];
  /** Human-readable name; the fluent calls spell this `label`. */
  readonly name?: string;
  readonly enabled?: boolean;
  readonly opacity?: number;
  readonly mask?: IMask;
}

/** Parameters accepted per operation type, exactly the recovered `PARAMS` allow-lists. */
export interface LayerParams {
  noise: INoiseParams;
  sculpt: ISculptParams;
  smooth: ISmoothParams;
  flatten: IFlattenParams;
  ramp: IRampParams;
  stamp: IStampParams;
  erode: IErodeParams;
  terrace: ITerraceParams;
  materials: IMaterialsParams;
  paint: IPaintParams;
  biome: IBiomeParams;
  scatter: IScatterParams;
  clear: IClearParams;
  road: IRoadParams;
  river: IRiverParams;
  water: IWaterParams;
  heightmap: IHeightmapParams;
  paste: IPasteParams;
}

/** The layer union, discriminated by `type`, so `params` narrows with the operation. */
export type Layer =
  | ILayer<"noise">
  | ILayer<"sculpt">
  | ILayer<"smooth">
  | ILayer<"flatten">
  | ILayer<"ramp">
  | ILayer<"stamp">
  | ILayer<"erode">
  | ILayer<"terrace">
  | ILayer<"materials">
  | ILayer<"paint">
  | ILayer<"biome">
  | ILayer<"scatter">
  | ILayer<"clear">
  | ILayer<"road">
  | ILayer<"river">
  | ILayer<"water">
  | ILayer<"heightmap">
  | ILayer<"paste">;

/** A scatter rule deferred until the final heights exist: masks re-evaluate against them. */
export interface IScatterRule extends IScatterParams {
  readonly id: string;
  readonly mask?: IMask;
  readonly opacity: number;
  readonly clear: IScatterClear[];
}

export interface IScatterClear {
  readonly mask: IMask;
  readonly opacity: number;
}

export interface IWaterRule extends IWaterParams {
  readonly id: string;
  readonly mask?: IMask;
  readonly opacity: number;
}

/** A flooded water body: the resolved rule, with its authoring mask replaced by the sample mask. */
export interface IWaterBody extends Omit<IWaterRule, "mask"> {
  readonly level: number;
  readonly mask: Uint8Array;
}

/** A river ribbon for rendering; authoring extents, not a flow simulation. */
export interface IRiver {
  readonly id: string;
  readonly points: readonly (readonly [number, number, number])[];
  readonly width: number;
  readonly color?: string | number;
  readonly opacity: number;
}

/** One accepted scatter candidate. `rotation` is yaw in radians. */
export interface IPlacement {
  /** Layer/seed/candidate key, independent of acceptance order; changing the seed changes identity. */
  readonly id: string;
  readonly layer: string;
  readonly asset: string;
  readonly position: [number, number, number];
  readonly rotation: number;
  readonly scale: number;
  readonly normal: [number, number, number];
  readonly alignToNormal: boolean;
  /** Authored transform; absent means the original scatter pose, with grounding enabled. */
  readonly transform?: IPlacementOverride;
}

/** A manual edit of one stable scatter candidate; model bounds remain game-owned. */
export interface IPlacementOverride {
  readonly position: [number, number, number];
  /** Unit quaternion in Three.js x/y/z/w order. */
  readonly quaternion: [number, number, number, number];
  readonly scale: [number, number, number];
  /** False retains requested Y; clearance is still measured by the game. */
  readonly grounding: boolean;
}

/** The disposable result of one evaluation: arrays the caller owns, plus its diagnostics. */
export interface ITerrainState {
  size: number;
  resolution: number;
  seed: number;
  height: Float32Array;
  /** Sample-major: eight channels per sample, weights summing to one. */
  splat: Float32Array;
  biomes: Record<string, Float32Array>;
  scatterRules: IScatterRule[];
  waterRules: IWaterRule[];
  rivers: IRiver[];
  instances: IPlacement[];
  waters: IWaterBody[];
  diagnostics: string[];
  /** Measured transport summed over erosion passes, on the canonical vertex grid. */
  erosion?: IErosionMaps;
}

export interface IErosionMaps {
  /** Droplet water visits, bilinearly distributed at each step. */
  flow: Float32Array;
  /** Carried sediment visits, in metres of equivalent terrain height. */
  sediment: Float32Array;
  /** Hydraulic material deposited, in metres. */
  deposition: Float32Array;
  /** Thermal material received from unstable neighbours, in metres. */
  talus: Float32Array;
}

/** Options for one evaluation call. */
export interface IEvaluateOptions {
  /** Vertices per side; one of 17, 33, 65, 129, 257, 513, 1025. Defaults to the document's. */
  readonly resolution?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { index: number; total: number; id: string }) => void;
}

/** What `inspect()` reports about an evaluation. */
export interface ITerrainInspection {
  size: number;
  resolution: number;
  layers: number;
  vertices: number;
  triangles: number;
  minHeight: number;
  maxHeight: number;
  instances: number;
  diagnostics: string[];
}

/** Options for `copyRegion()`. */
export interface ICopyRegionOptions {
  readonly at?: readonly [number, number];
  readonly size?: number;
  readonly resolution?: number;
}

/** One baked mesh: indexed arrays in world space, no Three.js types. */
export interface IBakedMesh {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  colors?: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  side: number;
  topVertexCount: number;
  bounds: { x: number; z: number; cells: number; step: number };
  skirtDepth: number;
}

export interface IBakeMeshOptions {
  /** Optional sRGB colours per material channel, chosen by the game. */
  readonly palette?: readonly (readonly [number, number, number])[];
  /** Power-of-two sample step within the chunk. */
  readonly step?: number;
  readonly x?: number;
  readonly z?: number;
  readonly cells?: number;
  readonly skirtDepth?: number;
}

export interface IBakeTerrainOptions {
  readonly palette?: readonly (readonly [number, number, number])[];
  readonly chunkCells?: number;
  readonly lodSteps?: readonly number[];
  readonly skirtDepth?: number;
}

/** The baked runtime archive: LOD chunks, collision samples and resolved placements. */
export interface IBakedTerrain {
  version: 1;
  size: number;
  resolution: number;
  lods: { step: number; chunks: IBakedMesh[] }[];
  collision: {
    type: "heightfield";
    size: number;
    resolution: number;
    cellSize: number;
    /** Southwest corner in world metres. Not a `Heightfield` centre. */
    origin: [number, number, number];
    heights: Float32Array;
  };
  instances: IPlacement[];
  materialChannels: MaterialId[];
}

/** One file inside an export archive. */
export interface IExportFile {
  name: string;
  bytes: Uint8Array;
}

/** An export result: `name`, MIME `type`, and the bytes. */
export interface IExportArchive {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** The recoverable export kinds. */
export type ExportKind = "project" | "png" | "raw" | "splat" | "glb" | "runtime";

export interface IHeightRange {
  min: number;
  max: number;
}

export interface IRaw16Options extends Partial<IHeightRange> {
  readonly littleEndian?: boolean;
}

export interface IDecodeRaw16Options extends IHeightRange {
  readonly width: number;
  readonly height: number;
  readonly littleEndian?: boolean;
}

export interface IDecodeHeightPngOptions extends Partial<IHeightRange> {}

export interface IDecodedHeightPng extends IHeightData {
  readonly min: number;
  readonly max: number;
  readonly bitDepth: number;
  readonly hasEmbeddedRange: boolean;
}

export interface ISplatPng {
  /** The four material channels this packed image carries. */
  channels: readonly MaterialId[];
  bytes: Uint8Array;
}

/** The recovered encoder's `StrataHeightRange` PNG metadata. */
export interface IHeightPngMetadata extends IHeightRange {}
