import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { float, max, normalize, uniform, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";
import type { TracedReflections } from "./traced-reflections.js";

/** The marker a gather prints once, with the grid it placed and the tier below it reads. */
export const SCREEN_PROBE_GATHER_MARKER = "TN_SCREEN_PROBE_GATHER";

/** The gather's pass groups, in the order they draw (the engine's own, `three-native/src/addons/screen-space.ts`). */
export const SCREEN_PROBE_PASSES = ["trace", "filter", "gather"] as const;
export type ScreenProbePass = (typeof SCREEN_PROBE_PASSES)[number];

/** Unreal's real-time Epic grid: one probe per 16 x 16 pixels (`r.Lumen.ScreenProbeGather.DownsampleFactor`). */
const DEFAULT_DOWNSAMPLE = 16;
/** Unreal's 8 x 8 octahedron at Epic (`r.Lumen.ScreenProbeGather.TracingOctahedronResolution`). */
const DEFAULT_OCTAHEDRON = 8;
/**
 * How far a ray that leaves the screen walks the packed scene before it reads the radiance cache, in metres: the cache's
 * own cell. A longer walk reads cells the ray cannot see, which is the per-pixel look this gather replaces.
 */
const DEFAULT_CELL_SIZE = 1;
/** A ray starts this far off its surface, and this much more per metre of depth, so it cannot hit the pixel it left. */
const START_OFFSET = 0.01;
const START_OFFSET_PER_METRE = 0.004;

/** The camera the scene pass draws with: a projection to map the screen, and a world matrix to leave it. */
export interface IScreenProbeCamera {
  readonly near: number;
  readonly projectionMatrix: { readonly elements: readonly number[] };
  readonly matrixWorld: { readonly elements: readonly number[] };
}

export interface IScreenProbeGatherOptions {
  /** The camera the scene pass draws with. */
  readonly camera: IScreenProbeCamera;
  /** The drawing buffer, in pixels. It fixes the probe grid; a resize needs a new gather. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Pixels between probes: Unreal's `DownsampleFactor`, 16 at Epic and 32 at High. */
  readonly downsampleFactor?: number;
  /** Rays on a side of each probe's octahedron: Unreal's `TracingOctahedronResolution`, 8 at Epic. */
  readonly tracingOctahedronResolution?: number;
  /**
   * The tier below the screen along a ray that hits, in view space, exactly as the engine asks it: the light the radiance
   * cache would have returned along that ray, which the gather subtracts so the two tiers never add the same light twice.
   * A game with its own tier passes it here; without either tier a hit keeps the frame's own light, as three's SSGINode.
   */
  readonly fallback?: (
    position: Node<"vec3">,
    direction: Node<"vec3">,
    normal: Node<"vec3">,
  ) => Node<"vec3">;
  /**
   * The radiance cache in world space, in the frame's units: the light arriving along a direction at a point. It answers
   * the tier past the screen, where a ray that leaves it reads the cache. With no `fallback`, it also answers the tier
   * below along each ray. Unreal reads its cache per ray direction the same way (UE 5.8.3:
   * Engine/Shaders/Private/Lumen/LumenScreenProbeTracing.usf, SampleRadianceCacheAndApply).
   */
  readonly radiance?: (position: Node<"vec3">, direction: Node<"vec3">) => Node<"vec3">;
  /**
   * The packed scene a ray that leaves the screen walks before it reads `radiance`: Unreal continues the ray in the
   * distance field up to the cache's coverage and reads the cache where it ended, so a miss is a direction's radiance
   * and not the pixel's mean over the hemisphere. Without it there is no walk and no miss tier.
   */
  readonly trace?: Pick<TracedReflections, "trace">;
  /** Metres a ray that left the screen walks the packed scene before it reads `radiance`. 1: the cache's cell. */
  readonly cacheCellSize?: number;
  /**
   * Diagnosis: label only this pass group as the `SSGI` GPU stage, so `info.engine.gpuStages.SSGI` times it alone.
   * Omit to label every pass; `null` labels none (another stage is being timed).
   */
  readonly timedPass?: ScreenProbePass | null;
  /** False silences the `TN_SCREEN_PROBE_GATHER` line, not the report. */
  readonly marker?: boolean;
}

/** What the gather placed, printed once and readable by a tool: Unreal's grid, in pixels and probes. */
export interface IScreenProbeGatherReport {
  readonly downsampleFactor: number;
  readonly tracingOctahedronResolution: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Probes over the whole grid: one per tile, the last row and column rounded up. */
  readonly probes: number;
  readonly raysPerProbe: number;
  /** Whether a ray that leaves the screen walks the scene, or reads the cache at its cell with none. */
  readonly worldTrace: boolean;
}

/**
 * The engine's gather node: three's declaration of `ssgi` carries neither the probes option nor the node's own readers, so
 * the class holds the engine's shape once here instead of casting at every use.
 */
type ScreenProbeNode = Node<"vec4"> & {
  getGINode(): Node<"vec4">;
  getAONode(): Node<"vec4">;
};

/** The engine's call shape: the camera and the tiers in an options object, where three names a camera inline. */
type ScreenProbeSignature = (
  color: Node,
  depth: Node,
  normal: Node,
  options: object,
) => ScreenProbeNode;

const gatherScreenProbes = ssgi as unknown as ScreenProbeSignature; // quality-allow: the engine extends three's ssgi with probes and the tiers below the screen, which its declaration does not carry

/** The world matrix of the scene camera as uniforms refreshed every render, and the view -> world map they build. */
function defineWorldMapping(camera: IScreenProbeCamera) {
  const live = (index: number): Node<"float"> =>
    uniform(camera.matrixWorld.elements[index] ?? 0).onRenderUpdate(
      () => camera.matrixWorld.elements[index] ?? 0,
    );
  const column = (first: number): Node<"vec3"> =>
    vec3(live(first), live(first + 1), live(first + 2));
  const [right, up, back, at] = [column(0), column(4), column(8), column(12)];
  return {
    /** A view-space vector in world space: the camera's rotation, which is all a direction needs. */
    direction: (value: Node<"vec3">): Node<"vec3"> =>
      right.mul(value.x).add(up.mul(value.y)).add(back.mul(value.z)),
    /** A view-space point in world space. */
    position: (value: Node<"vec3">): Node<"vec3"> =>
      right.mul(value.x).add(up.mul(value.y)).add(back.mul(value.z)).add(at),
  };
}

/**
 * Lumen's Screen Probe Gather (PRD-640): one probe per `downsampleFactor` pixel tile traces an octahedron of rays
 * instead of every pixel tracing its own, the probes' radiance is filtered into an irradiance octahedron each, and a
 * pixel blends the four nearest probes it can see. The engine owns the three passes
 * (`three-native/src/addons/screen-space.ts`); this composes the tier below them, which every game repeats:
 *
 *   a ray that hits on screen returns the lit frame minus the cache along it (`fallback`), so the two never add the
 *   same light twice;
 *   a ray that leaves the screen continues through the packed scene (`trace`) up to `cacheCellSize` and reads the
 *   radiance cache where it ended (`miss`), so the light it brings is that direction's, not the pixel's mean.
 *
 * The result is the incident radiance the traces add to what the game's composite already holds, E / pi units: multiply
 * it by the receiver's albedo (`mrt({ diffuseColor })`) and add it after the scene pass.
 *
 * The owned engine only: on `engine: "threejs"` the upstream node takes the camera as its fourth argument and has no
 * probes, which `gather()` refuses rather than drawing a frame with no bounce light.
 */
export class ScreenProbeGather {
  readonly report: IScreenProbeGatherReport;
  readonly downsampleFactor: number;
  readonly tracingOctahedronResolution: number;
  readonly cacheCellSize: number;
  readonly #camera: IScreenProbeCamera;
  readonly #viewport: { readonly width: number; readonly height: number };
  readonly #fallback: IScreenProbeGatherOptions["fallback"];
  readonly #radiance: IScreenProbeGatherOptions["radiance"];
  readonly #trace: IScreenProbeGatherOptions["trace"];
  readonly #timedPass: ScreenProbePass | null | undefined;
  #node: ScreenProbeNode | undefined;

  constructor(options: IScreenProbeGatherOptions) {
    const downsampleFactor = options.downsampleFactor ?? DEFAULT_DOWNSAMPLE;
    const tracingOctahedronResolution = options.tracingOctahedronResolution ?? DEFAULT_OCTAHEDRON;
    const cacheCellSize = options.cacheCellSize ?? DEFAULT_CELL_SIZE;
    if (!(Number.isInteger(downsampleFactor) && downsampleFactor >= 1))
      throw new RangeError(
        `TN_SCREEN_PROBE_GATHER: downsampleFactor ${downsampleFactor} must be a whole number of pixels, at least 1`,
      );
    if (!(Number.isInteger(tracingOctahedronResolution) && tracingOctahedronResolution >= 2))
      throw new RangeError(
        `TN_SCREEN_PROBE_GATHER: tracingOctahedronResolution ${tracingOctahedronResolution} must be a whole number of rays, at least 2`,
      );
    if (!(options.viewport.width > 0 && options.viewport.height > 0))
      throw new RangeError(
        `TN_SCREEN_PROBE_GATHER: viewport ${options.viewport.width}x${options.viewport.height} must be the drawing buffer`,
      );
    if (
      options.timedPass != null &&
      !SCREEN_PROBE_PASSES.includes(options.timedPass as ScreenProbePass)
    )
      throw new TypeError(
        `TN_SCREEN_PROBE_GATHER: timedPass ${String(options.timedPass)} is not one of ${SCREEN_PROBE_PASSES.join(", ")}`,
      );
    if (options.trace !== undefined && !(cacheCellSize > 0))
      throw new RangeError(
        `TN_SCREEN_PROBE_GATHER: cacheCellSize ${cacheCellSize} must be metres beyond 0`,
      );
    if (options.trace !== undefined && options.radiance === undefined)
      throw new TypeError(
        "TN_SCREEN_PROBE_GATHER_RADIANCE: a ray that leaves the screen reads options.radiance, and none was given",
      );
    if (
      (options.radiance !== undefined || options.trace !== undefined) &&
      options.camera?.matrixWorld === undefined
    )
      throw new TypeError(
        "TN_SCREEN_PROBE_GATHER_CAMERA: a gather that leaves the screen needs the scene camera's matrixWorld",
      );
    this.downsampleFactor = downsampleFactor;
    this.tracingOctahedronResolution = tracingOctahedronResolution;
    this.cacheCellSize = cacheCellSize;
    this.#camera = options.camera;
    this.#viewport = options.viewport;
    this.#fallback = options.fallback;
    this.#radiance = options.radiance;
    this.#trace = options.trace;
    this.#timedPass = options.timedPass;
    const tilesX = Math.ceil(options.viewport.width / downsampleFactor);
    const tilesY = Math.ceil(options.viewport.height / downsampleFactor);
    this.report = {
      downsampleFactor,
      tracingOctahedronResolution,
      viewportWidth: options.viewport.width,
      viewportHeight: options.viewport.height,
      probes: tilesX * tilesY,
      raysPerProbe: tracingOctahedronResolution * tracingOctahedronResolution,
      worldTrace: options.trace !== undefined,
    };
    if (options.marker !== false)
      console.info(`${SCREEN_PROBE_GATHER_MARKER} ${JSON.stringify(this.report)}`);
  }

  /**
   * The gather itself: `ssgi(base, depth, normal, { camera, probes, fallback, miss })`, with `base` the lit frame the
   * traces read and the depth and normal of the scene pass. `getGINode()` and `getAONode()` read what it built.
   */
  gather(colorNode: Node, depthNode: Node, normalNode: Node): Node<"vec4"> {
    const { fallback, miss } = this.#tiers();
    const node = gatherScreenProbes(colorNode, depthNode, normalNode, {
      camera: this.#camera,
      probes: {
        downsampleFactor: this.downsampleFactor,
        tracingOctahedronResolution: this.tracingOctahedronResolution,
        viewport: this.#viewport,
        ...(this.#timedPass === undefined ? {} : { timedPass: this.#timedPass }),
      },
      ...(fallback === undefined ? {} : { fallback }),
      ...(miss === undefined ? {} : { miss }),
    });
    this.#node = node;
    return node;
  }

  /** The gather's radiance, E / pi: multiply by the receiver's albedo and add it after the scene pass. */
  getGINode(): Node<"vec4"> {
    return this.#built().getGINode();
  }

  /** The share of the gather's rays that found nothing, as the occlusion the caller applies to the lit frame. */
  getAONode(): Node<"vec4"> {
    return this.#built().getAONode();
  }

  #built(): ScreenProbeNode {
    if (this.#node === undefined)
      throw new Error("TN_SCREEN_PROBE_GATHER_UNBUILT: call gather() before reading its nodes");
    return this.#node;
  }

  /**
   * The two tiers below the screen. Both are asked in view space, because the screen pass works there: the mapping to
   * the world is this class's, so a game answers one question in world space (what light arrives along this direction
   * at this point) and not two in two spaces.
   */
  #tiers(): {
    fallback?: (
      position: Node<"vec3">,
      direction: Node<"vec3">,
      normal: Node<"vec3">,
    ) => Node<"vec3">;
    miss?: (position: Node<"vec3">, direction: Node<"vec3">, normal: Node<"vec3">) => Node<"vec3">;
  } {
    const radiance = this.#radiance;
    const trace = this.#trace;
    const given = this.#fallback;
    if (radiance === undefined) return given === undefined ? {} : { fallback: given };
    const mapping = defineWorldMapping(this.#camera);
    const cellSize = this.cacheCellSize;
    // A game that already maps its own tier hands it over untouched; one with a world-space cache gets it here.
    const fallback =
      given ??
      ((position: Node<"vec3">, direction: Node<"vec3">) =>
        radiance(mapping.position(position), normalize(mapping.direction(direction))));
    // Without a packed scene there is no walk, so a ray that leaves the screen adds nothing: the pixel keeps the mean.
    if (trace === undefined) return { fallback };
    return {
      // The tier below the screen along a ray that hit: what the cache holds there, which the composite already adds.
      fallback,
      // The tier past the screen along a ray that missed: the distance field continued to the cache's cell, then the
      // cache read where the ray ended, less the light this pixel already receives (the composite adds that too).
      miss: (position, direction, normal) => {
        const at = mapping.position(position);
        const towards = normalize(mapping.direction(direction));
        const facing = normalize(mapping.direction(normal));
        const offset = max(float(START_OFFSET), position.z.abs().mul(START_OFFSET_PER_METRE));
        const reached = at.add(towards.mul(cellSize));
        const found = trace.trace({
          origin: at.add(facing.mul(offset)),
          direction: towards,
          far: cellSize,
        });
        const end = found.hit.greaterThan(0).select(found.position, reached);
        return radiance(end, towards).sub(radiance(at, facing));
      },
    };
  }
}
