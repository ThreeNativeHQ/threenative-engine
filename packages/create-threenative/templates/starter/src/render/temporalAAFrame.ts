// Generated user source: the per-frame GPU work behind `createTemporalAA` — display-sized history and
// resolve targets, an input-sized depth history, the jitter lattice, and the measured rejection count.
// Upstream's `_quadMesh` is module private, so the quad is ours too.
import { HalfFloatType, type OrthographicCamera, type PerspectiveCamera, Vector2 } from "three";
import { Fn, float, int, ivec2, max, min, texture, uv, vec2, vec4 } from "three/tsl";
import {
  DepthTexture,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Renderer,
  RendererUtils,
  type TextureNode,
} from "three/webgpu";
import { createTemporalAAInput } from "./temporalAAInput.js";
import {
  type ITemporalRejectionCounter,
  type ITemporalRejectionMeasurement,
  createTemporalRejectionCounter,
} from "./temporalRejectionCounter.js";

export type {
  ITemporalAANode,
  TemporalDepthRejection,
} from "./temporalResolveDepth.js";
import {
  type ITemporalAANode,
  type TemporalDepthRejection,
  guardTemporalAASeams,
} from "./temporalResolveDepth.js";

/** Mitchell–Netravali, B = C = 1/3, at distance x (UE 5.8.3: Engine/Shaders/Private/
 * TemporalSuperResolution/TSRResolveHistory.usf:82-83). */
function mitchell(x: number): number {
  const b = 1 / 3;
  const c = 1 / 3;
  const ax = Math.abs(x);
  if (ax < 1)
    return ((12 - 9 * b - 6 * c) * ax ** 3 + (-18 + 12 * b + 6 * c) * ax ** 2 + (6 - 2 * b)) / 6;
  if (ax < 2)
    return (
      ((-b - 6 * c) * ax ** 3 +
        (6 * b + 30 * c) * ax ** 2 +
        (-12 * b - 48 * c) * ax +
        (8 * b + 24 * c)) /
      6
    );
  return 0;
}

/**
 * Unreal TSR's history resolve (UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/
 * TSRResolveHistory.usf:312-357): a display pixel takes the 4×4 history pixels around its centre,
 * Mitchell-weighted by their distance in history pixels and by Unreal's HDR weight 1 / (R + 2G + B + 4)
 * (TSRColorSpace.ush:167-195), then clamped to those samples' range. At a 2x history the centre sits
 * between pixels, so the taps lie at ±0.5 and ±1.5 history pixels.
 */
function createHistoryResolve(resolve: TextureNode): NodeMaterial {
  const weights = [1.5, 0.5, 0.5, 1.5].map(mitchell);
  const material = new NodeMaterial();
  material.name = "Temporal AA history resolve";
  material.fragmentNode = Fn(() => {
    const size = vec2(resolve.size(int(0)) as Node<"uvec2">);
    const base = ivec2(uv().mul(size).sub(1.5).floor());
    const sum = vec4(0).toVar();
    const weightSum = float(0).toVar();
    const samples: Node<"vec4">[] = [];
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const at = ivec2(vec2(base.add(ivec2(x, y))).clamp(vec2(0), size.sub(1)));
        const colour = (resolve.load(at).max(0) as Node<"vec4">).toVar();
        const hdr = float(1).div(colour.r.add(colour.g.mul(2)).add(colour.b).add(4));
        const weight = hdr.mul((weights[x] ?? 0) * (weights[y] ?? 0));
        sum.addAssign(colour.mul(weight));
        weightSum.addAssign(weight);
        samples.push(colour);
      }
    // The range starts from a real sample: WGSL has no infinity literal.
    const low = samples.reduce((a, b) => min(a, b));
    const high = samples.reduce((a, b) => max(a, b));
    return sum.div(weightSum).clamp(low, high);
  })();
  return material;
}

/** The display-sized target the chain reads in place of a 2x history, and its resolve draw. */
function createHistoryPresent(internals: ITemporalAANode, quadMesh: QuadMesh) {
  const target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
  const material = createHistoryResolve(texture(internals._resolveRenderTarget.texture));
  return {
    draw(renderer: Renderer, display: Vector2): void {
      if (target.width !== display.x || target.height !== display.y) {
        target.setSize(display.x, display.y);
        renderer.initRenderTarget(target);
      }
      internals._textureNode.value = target.texture;
      renderer.setRenderTarget(target);
      quadMesh.material = material;
      quadMesh.render(renderer);
    },
    dispose(): void {
      target.dispose();
      material.dispose();
    },
  };
}

/** Owns everything that survives between frames: the quad, the rasters, the depth history and the
 * saved renderer state. */
export function createTemporalAAFrame(
  internals: ITemporalAANode,
  camera: PerspectiveCamera | OrthographicCamera,
  depth: TextureNode,
  historyValid: { value: number },
  rejection: () => TemporalDepthRejection | undefined,
  publishCurrentDepth?: (renderer: Renderer) => void,
  historyScale = 1,
) {
  // Three 0.187's QuadMesh takes a material in the constructor; the draw replaces it before rendering.
  const quadMesh = new QuadMesh(internals._resolveMaterial);
  quadMesh.name = "Temporal AA";
  const display = new Vector2();
  const history = new Vector2();
  // Above a 1x history the chain reads a display-sized resolve of it, never the history raster.
  const present = historyScale === 1 ? undefined : createHistoryPresent(internals, quadMesh);
  let previousDepth: DepthTexture | null = null;
  let depthReady = false;
  let disposed = false;
  let frame = 0;
  let counter: ITemporalRejectionCounter | undefined;
  let counterEquations: TemporalDepthRejection | undefined;
  let rendererState: Parameters<typeof RendererUtils.resetRendererState>[1] | undefined;

  const { input, measureInput, jitterInput } = createTemporalAAInput(internals, () => disposed);

  /** Publish and update history. Reset weights current only: reseeding cannot prevent motion
   * from sampling the seed at shifted history UVs. */
  function draw(renderer: Renderer, reset: boolean, currentFrame: number): void {
    frame = currentFrame;
    if (measure(renderer) === undefined)
      throw new Error("Temporal AA requires a materialized colour input.");
    guardTemporalAASeams(internals);
    if (display.x < input.x || display.y < input.y)
      throw new Error("Temporal AA cannot resolve to a display raster below its input raster.");
    // Snapshot the input's actual camera before late first-compile synchronization installs jitter
    // for a subsequent draw. The saved depth and its inverse projection must describe one raster.
    if (internals._currentJitterUV !== undefined && internals._previousJitterUV !== undefined) {
      internals._previousJitterUV.value.copy(internals._currentJitterUV.value);
      const view = camera.view;
      internals._currentJitterUV.value.set(
        view?.enabled === true ? view.offsetX / input.x : 0,
        view?.enabled === true ? view.offsetY / input.y : 0,
      );
    }
    const reconstructionView = camera.view;
    internals._reconstructionJitterOffset?.value.set(
      reconstructionView?.enabled === true ? reconstructionView.offsetX : 0,
      reconstructionView?.enabled === true ? reconstructionView.offsetY : 0,
    );
    // Store previous frame matrices before updating current ones.
    internals._previousCameraWorldMatrix.value.copy(internals._cameraWorldMatrix.value);
    internals._previousCameraProjectionMatrixInverse.value.copy(
      internals._cameraProjectionMatrixInverse.value,
    );
    internals._cameraNearFar.value.set(camera.near, camera.far);
    internals._cameraWorldMatrix.value.copy(camera.matrixWorld);
    internals._cameraWorldMatrixInverse.value.copy(camera.matrixWorldInverse);
    internals._cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    historyValid.value = reset ? 0 : 1;
    // Depth history stays input sized, independently of display history. Seed on either-axis resize.
    if (previousDepth?.image.width !== input.x || previousDepth?.image.height !== input.y) {
      previousDepth?.dispose();
      previousDepth = new DepthTexture(input.x, input.y, depth.value.type);
      depthReady = false;
    }
    const seeded = depthReady === false;
    const depthHistory = previousDepth;
    let state: typeof rendererState;
    try {
      rendererState ??= RendererUtils.saveRendererState(renderer);
      state = RendererUtils.resetRendererState(renderer, rendererState);
      internals._previousDepthNode.value = depthHistory;
      if (seeded) {
        renderer.copyTextureToTexture(depth.value, depthHistory);
        depthReady = true;
      }
      // Resolve and history hold the display raster times historyScale, whatever the input raster is.
      history.copy(display).multiplyScalar(historyScale);
      const restarted =
        internals._historyRenderTarget.width !== history.x ||
        internals._historyRenderTarget.height !== history.y;
      internals.setSize(history.x, history.y);
      if (restarted) {
        // A resize disposes the targets, so they need fresh GPU storage before the draw.
        renderer.initRenderTarget(internals._historyRenderTarget);
        renderer.initRenderTarget(internals._resolveRenderTarget);
      }
      if (
        internals._historyRenderTarget.width !== history.x ||
        internals._historyRenderTarget.height !== history.y
      )
        throw new Error("Temporal AA history and resolve must share the history raster.");
      renderer.setRenderTarget(internals._resolveRenderTarget);
      quadMesh.material = internals._resolveMaterial;
      quadMesh.render(renderer);
      // Between the resolve and the depth copy, so it reads the depth and matrices just drawn with.
      const equations = rejection();
      if (equations !== undefined) {
        if (counterEquations !== equations) {
          counter?.dispose();
          counter = undefined;
          counterEquations = equations;
        }
        counter ??= createTemporalRejectionCounter(equations);
        counter.sample(renderer, frame, display.x, display.y);
      }
      publishCurrentDepth?.(renderer);
      // History is the resolve this frame produced, at the same size, so the copy never crosses rasters.
      if (seeded === false) renderer.copyTextureToTexture(depth.value, depthHistory);
      renderer.copyTextureToTexture(
        internals._resolveRenderTarget.texture,
        internals._historyRenderTarget.texture,
      );
      present?.draw(renderer, display);
    } finally {
      if (state !== undefined) RendererUtils.restoreRendererState(renderer, state);
    }
  }

  /** Both rasters, from the real targets: the scene pass one, then the drawing buffer. */
  function measure(renderer: Renderer): RenderTarget | undefined {
    const target = measureInput();
    if (target === undefined) return undefined;
    renderer.getDrawingBufferSize(display);
    return target;
  }

  return {
    input,
    display,
    measure,
    jitterInput,
    draw,
    // Forward the counter's measured report, drain and settle contracts.
    rejection: (): ITemporalRejectionMeasurement | undefined => counter?.report(frame),
    drainRejection: (): { frame: number; rejectionFraction: number } | undefined => {
      const drained = counter?.drain();
      return drained && { frame: drained.frame, rejectionFraction: drained.fraction };
    },
    settledRejection: (): Promise<void> => counter?.settled() ?? Promise.resolve(),
    dispose: (): void => {
      disposed = true;
      counter?.dispose();
      counter = undefined;
      previousDepth?.dispose();
      previousDepth = null;
      depthReady = false;
      present?.dispose();
    },
  };
}
