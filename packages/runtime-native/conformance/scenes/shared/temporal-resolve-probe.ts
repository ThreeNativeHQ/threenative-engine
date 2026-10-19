import { DataUtils, HalfFloatType, Vector2 } from "three";
import type { OrthographicCamera, Scene } from "three";
import { texture, uv } from "three/tsl";
import {
  NodeMaterial,
  type PassNode,
  QuadMesh,
  RenderTarget,
  type Renderer,
  RendererUtils,
  type Texture,
  type TextureNode,
} from "three/webgpu";

interface IPinnedTargets {
  _resolveRenderTarget: RenderTarget;
  _historyRenderTarget: RenderTarget;
  _previousDepthNode: { value: Texture };
  beautyNode: TextureNode & {
    isRTTNode?: boolean;
    renderTarget?: RenderTarget;
    passNode?: { renderTarget: RenderTarget };
  };
}

/** Channels of the red row kept in a cold frame's record as its finiteness witness. */
const WITNESS = 8;

/**
 * Half-float carries ten mantissa bits, so one value written twice differs from itself by a couple of
 * ulp. Both readbacks are half-float, so this is the format's precision and nothing else: the oracle
 * is the resolve's own current-colour sample of the same immutable input.
 */
const FORMAT = { relative: 2 ** -9, absolute: 2 ** -13 };

/** Decodes one readback channel, including the half-float encoding both targets use. */
function decoder(texture: Texture): (data: ArrayLike<number>, index: number) => number {
  return (data, index) => {
    const value = data[index];
    if (value === undefined) throw new Error("Incomplete resolve readback.");
    const decoded = texture.type === HalfFloatType ? DataUtils.fromHalfFloat(value) : value;
    if (!Number.isFinite(decoded)) throw new Error("Nonfinite resolve readback.");
    return decoded;
  };
}

/** Absolute distance two half-float roundings of the same value may legitimately differ by. */
function precision(value: number): number {
  return Math.abs(value) * FORMAT.relative + FORMAT.absolute;
}

/**
 * Items between two readback rows. A GPU readback pads each row to a 256-byte boundary, so the row
 * stride of the returned typed array is not its pixel width whenever that padding applies.
 */
function rowStride(data: ArrayLike<number>, width: number, height: number): number {
  const pixels = width * 4;
  if (height < 2) return pixels;
  const stride = (data.length - pixels) / (height - 1);
  if (!Number.isInteger(stride) || stride < pixels)
    throw new Error(
      `Readback of ${String(data.length)} items cannot address ${String(width)}x${String(height)} rows.`,
    );
  return stride;
}

/**
 * Fixture-only readback of the resolve's real GPU target. Never a product measurement.
 *
 * A reset frame must publish the current input upscaled, and the oracle target answers with exactly
 * that: the spatial upscale of the same immutable current input the resolve published from, sampled
 * the same way at display size. Both sides are GPU readbacks of display-sized targets, so the
 * comparison needs no CPU coordinate mapping between two rasters.
 *
 * The oracle samples the resolve's own texture object rather than its node. Building a graph that
 * reaches the scene pass re-runs that pass's `updateBefore`, which re-renders the scene with the
 * jitter already cleared and leaves the target holding something the resolve never published. The
 * pass renders before the resolve in the frame and nothing renders again before this read, so the
 * input here is the immutable current one the resolve published from.
 */
export function createTemporalResolveProbe(
  renderer: Renderer,
  scene: Scene,
  camera: OrthographicCamera,
  scenePass: PassNode,
  node: IPinnedTargets,
  // The frame report, not the kernel's own validity uniform: a control that removes the reset gate
  // leaves that uniform at 1 while the frame is still a reset frame.
  coldFrame: () => boolean,
) {
  const size = new Vector2();
  // The camera basis in force when the scene pass actually drew, which is the lattice the jitter
  // must live on. Read at the draw rather than after the resolve, where it has already been cleared.
  const view = { enabled: false, width: 0, height: 0, offsetX: 0, offsetY: 0 };
  const oracleTarget = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
  const oracleMaterial = new NodeMaterial();
  oracleMaterial.name = "resolve-oracle";
  // The spatial upscale of the immutable current input, at display size: the resolve's own colour
  // sample and nothing else — no history, no clip, no weight, no CPU-side neighbourhood.
  oracleMaterial.colorNode = texture(node.beautyNode.value as Texture, uv());
  const oracleQuad = new QuadMesh(oracleMaterial);
  oracleQuad.name = "resolve-oracle";
  let oracleState: Parameters<typeof RendererUtils.resetRendererState>[1] | undefined;
  let last: unknown = null;
  let reads = 0;
  const coldFrames: unknown[] = [];

  /** Renders the oracle through the same state discipline the resolve draw uses. */
  const renderOracle = (): void => {
    oracleState ??= RendererUtils.saveRendererState(renderer);
    const state = RendererUtils.resetRendererState(renderer, oracleState);
    try {
      renderer.setRenderTarget(oracleTarget);
      oracleQuad.render(renderer);
    } finally {
      RendererUtils.restoreRendererState(renderer, state);
    }
  };

  /**
   * One cold frame's whole published display against the oracle's, channel for channel at the same
   * coordinates. The whole raster is compared because a control that removes the reset gate can
   * agree with the oracle on any one flat block and still disagree everywhere else, so a sampled
   * window measures the window rather than the frame.
   */
  const compareColdFrame = async (
    resolve: RenderTarget,
    decodePublished: (data: ArrayLike<number>, index: number) => number,
    published: ArrayLike<number>,
    width: number,
    height: number,
  ) => {
    oracleTarget.setSize(width, height);
    renderOracle();
    const oracle = await renderer.readRenderTargetPixelsAsync(oracleTarget, 0, 0, width, height);
    const readOracle = decoder(oracleTarget.texture as Texture);
    const publishedStride = rowStride(published, width, height);
    const oracleStride = rowStride(oracle, width, height);
    let outside = 0;
    let worst = 0;
    let publishedMean = 0;
    let oracleMean = 0;
    let publishedMax = 0;
    let oracleMax = 0;
    for (let row = 0; row < height; row += 1) {
      const publishedRow = row * publishedStride;
      const oracleRow = row * oracleStride;
      for (let column = 0; column < width; column += 1) {
        const texel = column * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const index = texel + channel;
          const value = decodePublished(published, publishedRow + index);
          const expected = readOracle(oracle, oracleRow + index);
          publishedMean += value;
          oracleMean += expected;
          publishedMax = Math.max(publishedMax, value);
          oracleMax = Math.max(oracleMax, expected);
          const tolerance = precision(expected);
          const excess = Math.max(Math.abs(value - expected) - tolerance, 0) / tolerance;
          if (excess > 0) outside += 1;
          worst = Math.max(worst, excess);
        }
      }
    }
    const samples = width * height * 3;
    const round = (value: number): number => Math.round(value * 10000) / 10000;
    const row0 = (
      data: ArrayLike<number>,
      decode: (d: ArrayLike<number>, i: number) => number,
    ): number[] => Array.from({ length: WITNESS }, (_, index) => round(decode(data, index * 4)));
    return {
      width,
      height,
      pixels: samples,
      outside,
      worstRatio: Math.round(worst * 1000) / 1000,
      publishedMean: round(publishedMean / samples),
      oracleMean: round(oracleMean / samples),
      publishedMax: round(publishedMax),
      oracleMax: round(oracleMax),
      publishedRow0: row0(published, decodePublished),
      oracleRow0: row0(oracle, readOracle),
    };
  };

  const beforeRender = scene.onBeforeRender;
  scene.onBeforeRender = (...args) => {
    // Recorded every draw, including a disabled view, so a frame that never applied a lattice
    // cannot inherit the previous frame's numbers.
    const basis = camera.view;
    view.enabled = basis?.enabled === true;
    if (view.enabled && basis !== undefined && basis !== null) {
      view.width = basis.fullWidth;
      view.height = basis.fullHeight;
      view.offsetX = basis.offsetX;
      view.offsetY = basis.offsetY;
    }
    beforeRender.apply(scene, args);
  };

  /** Rejects any raster arrangement this diagnostic could not honestly compare. */
  const guardRasters = (
    resolve: RenderTarget,
    history: RenderTarget,
    input: RenderTarget,
    display: Vector2,
  ): void => {
    if (resolve.width !== display.x || resolve.height !== display.y)
      throw new Error(
        `Resolve must hold the display raster; it is ${String(resolve.width)}x${String(resolve.height)} against ${String(display.x)}x${String(display.y)}.`,
      );
    if (history.width !== resolve.width || history.height !== resolve.height)
      throw new Error("History and resolve must share the display raster.");
    if (input.width >= resolve.width || input.height >= resolve.height)
      throw new Error("Scaled diagnostic requires an input raster below the display raster.");
  };

  /**
   * One reset frame's evidence: the lattice the scene drew on, the raster it drew into, and the
   * published display against the oracle's. A missing observation is never a passing measurement,
   * so every read here either returns numbers or throws.
   */
  const recordColdFrame = async (
    resolve: RenderTarget,
    input: RenderTarget,
    decode: (data: ArrayLike<number>, index: number) => number,
    frame: number,
  ): Promise<void> => {
    const published = await renderer.readRenderTargetPixelsAsync(
      resolve,
      0,
      0,
      resolve.width,
      resolve.height,
    );
    // The oracle samples the very node the resolve samples, which is the input raster when the
    // chain already hands the node a texture and its own copy when it does not.
    const colour = node.beautyNode.isRTTNode
      ? node.beautyNode.renderTarget
      : (node.beautyNode.passNode?.renderTarget ?? input);
    coldFrames.push({
      frame,
      historyValid: false,
      colourIsSceneTarget: colour === input,
      // The lattice the scene actually drew on, beside the raster it drew into.
      inputWidth: input.width,
      inputHeight: input.height,
      viewEnabled: view.enabled,
      viewWidth: view.width,
      viewHeight: view.height,
      viewOffsetX: view.offsetX,
      viewOffsetY: view.offsetY,
      jitterMatchesInput:
        view.enabled && view.width === input.width && view.height === input.height,
      ...(await compareColdFrame(resolve, decode, published, resolve.width, resolve.height)),
    });
  };

  return {
    observation: () => last,
    read: async () => {
      renderer.getDrawingBufferSize(size);
      const resolve = node._resolveRenderTarget;
      const history = node._historyRenderTarget;
      const input = scenePass.renderTarget;
      if (input === undefined) throw new Error("Resolve diagnostic requires a scene pass target.");
      guardRasters(resolve, history, input, size);
      // The far border of the display raster, which lies past the input raster's own extent. A
      // resolve that stayed input sized could not answer this read at all, so the read is the proof
      // rather than a value read from the wrong target.
      const x = resolve.width - 4;
      const y = Math.floor(resolve.height / 2) - 2;
      const data = await renderer.readRenderTargetPixelsAsync(resolve, x, y, 4, 4);
      const decode = decoder(resolve.texture as Texture);
      const channel = [0, 1, 2].map((index) => decode(data, index));
      if (Math.max(...channel) <= 0.01)
        throw new Error(`Far border of the display raster is black: ${JSON.stringify(channel)}.`);
      const frame = reads;
      reads += 1;
      if (coldFrame()) await recordColdFrame(resolve, input, decode, frame);
      const depthHistory = node._previousDepthNode.value.image as { width: number; height: number };
      last = {
        displayWidth: size.x,
        displayHeight: size.y,
        inputWidth: input.width,
        inputHeight: input.height,
        depthHistoryWidth: depthHistory.width,
        depthHistoryHeight: depthHistory.height,
        resolveWidth: resolve.width,
        resolveHeight: resolve.height,
        historyWidth: history.width,
        historyHeight: history.height,
        farBorderBeyondInput: x >= input.width,
        farBorder: channel,
        farBorderMax: Math.max(...channel),
        inputViewEnabled: view.enabled,
        inputViewWidth: view.width,
        inputViewHeight: view.height,
        inputViewOffsetX: view.offsetX,
        inputViewOffsetY: view.offsetY,
        coldFrames,
      };
    },
    dispose: (): void => {
      scene.onBeforeRender = beforeRender;
      oracleTarget.dispose();
      oracleMaterial.dispose();
    },
  };
}
