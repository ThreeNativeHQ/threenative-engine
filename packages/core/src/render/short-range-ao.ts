import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  cos,
  float,
  floor,
  int,
  length,
  max,
  normalize,
  pow,
  rtt,
  sin,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

/** The marker the pass prints once, with the sweep it ran. */
export const SHORT_RANGE_AO_MARKER = "TN_SHORT_RANGE_AO";

/** Half-hemisphere sweeps around the view normal (Unreal's `ShortRangeAO.HorizonSearchSliceCount`, 2 at Epic). */
const SLICE_COUNT = 2;
/** Samples per sweep, at the squared step fraction (Unreal's `HorizonSearchStepCount`, 3 at Epic). */
const STEP_COUNT = 3;
/**
 * Metres the search would cover in the world at the display height, as Unreal states it: twice the screen probe
 * downsample factor, 2 x 16 px (`r.Lumen.ScreenProbeGather.ShortRangeAO`, LumenScreenProbeGather.cpp:2665).
 */
const REACH_PX = 32;
/** The most sweeps the loops may run, so a driver cannot unroll them into a program too large to compile. */
const MAX_SLICES = 8;
const MAX_STEPS = 8;
/** A sample this close to the pixel says nothing about a horizon. */
const MIN_DISTANCE = 1e-5;
const HALF_FLOAT_TYPE = 1016;

/** The scene camera the pass reads: a projection to map the screen and a depth to come back to view space. */
export interface IShortRangeAOCamera {
  readonly projectionMatrix: { readonly elements: readonly number[] };
}

export interface IShortRangeAOOptions {
  /** The camera the scene pass drew with: a post quad's own camera nodes are the quad's, not the scene's. */
  readonly camera: IShortRangeAOCamera;
  /** The drawing buffer, in pixels. The search's reach is a distance on the screen, so it needs the size. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Sweeps around the view normal (`horizonSearchSliceCount`): 2, Unreal's Epic setting. */
  readonly horizonSearchSliceCount?: number;
  /** Samples per sweep (`horizonSearchStepCount`): 3, Unreal's Epic setting. */
  readonly horizonSearchStepCount?: number;
  /** The reach in pixels of the drawing buffer: 32, twice Unreal's 16 px screen probe downsample. */
  readonly reachPx?: number;
  /**
   * Whether the pass also answers the bent normal (`.rgb`), Unreal's Epic-only setting. The occlusion alone is
   * `.a`, so a composite that does not read a bent normal pays one channel, not a second pass.
   */
  readonly bentNormal?: boolean;
  /** How strongly the occlusion applies: 1 keeps the horizon's own answer. */
  readonly intensity?: number;
  /** False silences the `TN_SHORT_RANGE_AO` line, not the report. */
  readonly marker?: boolean;
}

/** What the pass swept, printed once and readable by a tool. */
export interface IShortRangeAOReport {
  readonly horizonSearchSliceCount: number;
  readonly horizonSearchStepCount: number;
  readonly reachPx: number;
  /** Samples each pixel's normal hemisphere took: slices x steps. */
  readonly samplesPerPixel: number;
  readonly bentNormal: boolean;
}

/**
 * Unreal's Short Range AO (PRD-640 Phase 3): a horizon search of `horizonSearchSliceCount` sweeps around the view
 * normal, `horizonSearchStepCount` samples each at the squared fraction of a screen-space reach, at full resolution,
 * with a bent normal at Epic. It is the AO that runs *with* dynamic GI: the contact detail Lumen keeps after the screen
 * probe gather has already answered the wide occlusion, so the frame is not darkened twice by two wide treatments
 * (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenSpaceBentNormal.cpp and
 * Engine/Shaders/Private/Lumen/LumenScreenSpaceBentNormal.usf). GTAO through `ambientOcclusion` stays the AO of the
 * tiers without dynamic GI.
 *
 * The result is one texture: `rgb` the bent normal in view space (the space the normal target and the GI gather work
 * in), `a` the share of the hemisphere left open, which multiplies *indirect* light only — direct light and emission
 * keep their own occlusion, as Unreal's `DiffuseIndirectComposite` applies it. Multi-bounce and the albedo cap belong
 * to the game's composite, because they decide how a surface looks.
 */
export class ShortRangeAO {
  readonly report: IShortRangeAOReport;
  readonly horizonSearchSliceCount: number;
  readonly horizonSearchStepCount: number;
  readonly reachPx: number;
  readonly bentNormal: boolean;
  readonly intensity: number;
  readonly #camera: IShortRangeAOCamera;
  readonly #viewport: { readonly width: number; readonly height: number };

  constructor(options: IShortRangeAOOptions) {
    const horizonSearchSliceCount = options.horizonSearchSliceCount ?? SLICE_COUNT;
    const horizonSearchStepCount = options.horizonSearchStepCount ?? STEP_COUNT;
    const reachPx = options.reachPx ?? REACH_PX;
    const intensity = options.intensity ?? 1;
    if (!(Number.isInteger(horizonSearchSliceCount) && horizonSearchSliceCount >= 1))
      throw new RangeError(
        `TN_SHORT_RANGE_AO: horizonSearchSliceCount ${horizonSearchSliceCount} must be a whole number of sweeps, at least 1`,
      );
    if (!(Number.isInteger(horizonSearchStepCount) && horizonSearchStepCount >= 1))
      throw new RangeError(
        `TN_SHORT_RANGE_AO: horizonSearchStepCount ${horizonSearchStepCount} must be a whole number of samples, at least 1`,
      );
    if (horizonSearchSliceCount > MAX_SLICES || horizonSearchStepCount > MAX_STEPS)
      throw new RangeError(
        `TN_SHORT_RANGE_AO: a sweep of ${horizonSearchSliceCount} x ${horizonSearchStepCount} is more than the pass compiles (${MAX_SLICES} x ${MAX_STEPS})`,
      );
    if (!(reachPx > 0))
      throw new RangeError(
        `TN_SHORT_RANGE_AO: reachPx ${reachPx} must be pixels of the drawing buffer beyond 0`,
      );
    if (!(intensity > 0))
      throw new RangeError(`TN_SHORT_RANGE_AO: intensity ${intensity} must be beyond 0`);
    if (!(options.viewport.width > 0 && options.viewport.height > 0))
      throw new RangeError(
        `TN_SHORT_RANGE_AO: viewport ${options.viewport.width}x${options.viewport.height} must be the drawing buffer`,
      );
    if (options.camera?.projectionMatrix === undefined)
      throw new TypeError(
        "TN_SHORT_RANGE_AO_CAMERA: the pass needs the scene camera's projectionMatrix",
      );
    this.horizonSearchSliceCount = horizonSearchSliceCount;
    this.horizonSearchStepCount = horizonSearchStepCount;
    this.reachPx = reachPx;
    this.bentNormal = options.bentNormal ?? true;
    this.intensity = intensity;
    this.#camera = options.camera;
    this.#viewport = options.viewport;
    this.report = {
      horizonSearchSliceCount,
      horizonSearchStepCount,
      reachPx,
      samplesPerPixel: horizonSearchSliceCount * horizonSearchStepCount,
      bentNormal: this.bentNormal,
    };
    if (options.marker !== false)
      console.info(`${SHORT_RANGE_AO_MARKER} ${JSON.stringify(this.report)}`);
  }

  /**
   * The occlusion of one frame: `rgb` the bent normal in view space, `a` the share of the hemisphere left open. `depth`
   * is the scene pass's depth target and `normal` its view-space normal target.
   */
  occlusion(depthNode: TextureNode, normalNode: TextureNode): Node<"vec4"> {
    const element = (index: number): Node<"float"> =>
      uniform(this.#camera.projectionMatrix.elements[index] ?? 0).onRenderUpdate(
        () => this.#camera.projectionMatrix.elements[index] ?? 0,
      ) as Node<"float">;
    const [p0, p5, p8, p9, p10, p14] = [0, 5, 8, 9, 10, 14].map(element) as [
      Node<"float">,
      Node<"float">,
      Node<"float">,
      Node<"float">,
      Node<"float">,
      Node<"float">,
    ];
    // Depth is (A z + B) / -z, so z = -B / (depth + A): the same mapping the gather and the reflections use.
    const viewPosition = (coordinate: Node<"vec2">, depth: Node<"float">): Node<"vec3"> => {
      const z = p14.negate().div(depth.add(p10));
      const ndc = vec2(coordinate.x.mul(2).sub(1), float(1).sub(coordinate.y).mul(2).sub(1));
      return vec3(z.negate().mul(ndc.x.add(p8)).div(p0), z.negate().mul(ndc.y.add(p9)).div(p5), z);
    };
    const slices = uniform(this.horizonSearchSliceCount);
    const steps = uniform(this.horizonSearchStepCount);
    // The reach is a distance on the screen, so one step is that many pixels of the drawing buffer, in uv.
    const stepOffset = vec2(
      this.reachPx / this.#viewport.width,
      this.reachPx / this.#viewport.height,
    );
    const intensity = uniform(this.intensity);
    const bent = this.bentNormal;

    const graph = Fn(() => {
      const coordinate = uv();
      const result = vec4(0, 0, 1, 1).toVar();
      const centreDepth = depthNode.sample(coordinate).r;
      const centreNormal = normalNode.sample(coordinate).xyz;
      // The sky and a draw the normal pass skips (an unlit material) take no occlusion.
      If(centreDepth.lessThan(1).and(centreNormal.dot(centreNormal).greaterThan(0.25)), () => {
        const position = viewPosition(coordinate, centreDepth);
        const normal = normalize(centreNormal);
        // A frame around the normal, so a sweep turns in the surface's tangent plane.
        const helper = normal.y
          .abs()
          .lessThan(0.99)
          .select(vec3(0, 1, 0), vec3(1, 0, 0));
        const tangent = normalize(helper.cross(normal));
        const bitangent = normal.cross(tangent);
        // Each pixel turns its sweeps by its own angle (interleaved gradient noise on a fixed lattice of the uv), so
        // two sweeps do not leave the pattern of the sweep set on the frame.
        const cell = coordinate.mul(2048).floor();
        const noise = cell.x
          .mul(0.06711056)
          .add(cell.y.mul(0.00583715))
          .fract()
          .mul(52.9829189)
          .fract();
        const open = float(0).toVar();
        const direction = vec3(0, 0, 1).toVar();
        const bentNormal = vec3(0, 0, 0).toVar();
        Loop(
          { start: int(0), end: int(MAX_SLICES), type: "int", condition: "<" },
          ({ i: slice }) => {
            If(float(slice).greaterThanEqual(slices), () => {
              Break();
            });
            const angle = float(slice).add(noise).div(slices).mul(Math.PI);
            direction.assign(normalize(tangent.mul(cos(angle)).add(bitangent.mul(sin(angle)))));
            // The horizon starts at the surface itself: nothing beyond it is above the plane.
            const horizon = float(-1).toVar();
            Loop(
              { start: int(0), end: int(MAX_STEPS), type: "int", condition: "<" },
              ({ i: step }) => {
                If(float(step).greaterThanEqual(steps), () => {
                  Break();
                });
                // Unreal lands each step at the squared step fraction of the reach (LumenScreenSpaceBentNormal.usf:355).
                const fraction = float(step).add(1).div(steps);
                const sampleCoordinate = coordinate.add(
                  stepOffset.mul(direction.xy).mul(fraction.mul(fraction)),
                );
                const sampleDepth = depthNode.sample(sampleCoordinate).r;
                const inside = sampleCoordinate.x
                  .greaterThanEqual(0)
                  .and(sampleCoordinate.x.lessThanEqual(1))
                  .and(sampleCoordinate.y.greaterThanEqual(0))
                  .and(sampleCoordinate.y.lessThanEqual(1))
                  .and(sampleDepth.lessThan(1));
                const delta = viewPosition(sampleCoordinate, sampleDepth).sub(position);
                // How far above the tangent plane the sample stands: its sine, which is the horizon's angle.
                const sine = delta.dot(normal).div(max(length(delta), float(MIN_DISTANCE)));
                horizon.assign(max(horizon, inside.select(sine, float(-1))));
              },
            );
            const kept = clamp(float(1).sub(max(horizon, float(0))), float(0), float(1));
            open.assign(open.add(kept));
            if (bent)
              bentNormal.assign(
                bentNormal.add(direction.mul(kept)).add(normal.mul(kept.mul(0.5).add(0.25))),
              );
          },
        );
        const visibility = pow(clamp(open.div(slices), float(0), float(1)), intensity);
        // A bent normal alone can point along the geometric one or degenerate in a fully open pixel: adding the
        // geometric normal and normalising once keeps the axis well behaved at both ends.
        const axis = bent ? normalize(normalize(bentNormal).add(normal)) : normal;
        result.assign(vec4(axis, visibility));
      });
      return result;
    })();

    const node = rtt(graph, null, null, { type: HALF_FLOAT_TYPE });
    return Object.defineProperties(node, {
      bentNormal: { value: bent },
      reachPx: { value: this.reachPx },
      slices: { value: this.horizonSearchSliceCount },
      steps: { value: this.horizonSearchStepCount },
    }) as Node<"vec4">;
  }
}
