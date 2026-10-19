// Generated user source: the per-frame GPU work behind `createTemporalAA` — display-sized history and
// resolve targets, an input-sized depth history, the jitter lattice, and the measured rejection count.
// Upstream's `_quadMesh` is module private, so the quad is ours too.
import { type OrthographicCamera, type PerspectiveCamera, Vector2 } from "three";
import {
  DepthTexture,
  QuadMesh,
  type RenderTarget,
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

/** Owns everything that survives between frames: the quad, the rasters, the depth history and the
 * saved renderer state. */
export function createTemporalAAFrame(
  internals: ITemporalAANode,
  camera: PerspectiveCamera | OrthographicCamera,
  depth: TextureNode,
  historyValid: { value: number },
  rejection: () => TemporalDepthRejection | undefined,
  publishCurrentDepth?: (renderer: Renderer) => void,
) {
  const quadMesh = new QuadMesh();
  quadMesh.name = "Temporal AA";
  const display = new Vector2();
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
    if (internals._needsPostProcessingSync === true) {
      internals.setViewOffset(input.x, input.y);
      internals._needsPostProcessingSync = false;
    }
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
      // Resolve and history hold the display raster whatever the input raster is.
      const restarted =
        internals._historyRenderTarget.width !== display.x ||
        internals._historyRenderTarget.height !== display.y;
      internals.setSize(display.x, display.y);
      if (restarted) {
        // A resize disposes the targets, so they need fresh GPU storage before the draw.
        renderer.initRenderTarget(internals._historyRenderTarget);
        renderer.initRenderTarget(internals._resolveRenderTarget);
      }
      if (
        internals._historyRenderTarget.width !== display.x ||
        internals._historyRenderTarget.height !== display.y
      )
        throw new Error("Temporal AA history and resolve must share the display raster.");
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
    },
  };
}
