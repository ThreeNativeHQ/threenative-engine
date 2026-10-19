// Isolated opt-in raw4 producer. No quality tier or fixed raster selects it. The existing pass
// scale determines actual sizes; unsupported, native-size and custom inputs use the ordinary lane.
import { type Material, Scene, Vector2 } from "three";
import { context, velocity } from "three/tsl";
import { type Node, type PassNode, type Renderer, RendererUtils } from "three/webgpu";
import type { ITemporalCurrentInputs } from "./temporalCurrentFootprint.js";
import { createTemporalCurrentReplay } from "./temporalCurrentReplay.js";
import { type IRawPass, currentPassEligible } from "./temporalCurrentSelection.js";
const selectivePolicy = Object.freeze({
  invariantPosition: true,
  sampleInterpolation: (material: Material) => material.alphaTest > 0,
});

export function createTemporalCurrentProducer(
  beauty: PassNode,
  sharedMotion: Node<"vec2"> = velocity as unknown as Node<"vec2">,
) {
  if (!(beauty.scene instanceof Scene)) throw new Error("Current footprint requires a scene pass.");
  const sourceScene = beauty.scene;
  const sourceCamera = beauty.camera;
  const sourceTarget = beauty.renderTarget;
  const samples = beauty.renderTarget.samples;
  const originalContext = beauty.contextNode;
  const options = (beauty as IRawPass).options;
  const originalSamplesOption = options.samples;
  if (samples > 1 || beauty.overrideMaterial !== null)
    throw new Error("Current footprint requires an ordinary owned scene pass.");
  const replay = createTemporalCurrentReplay(beauty);
  const originalDraw = beauty.updateBefore;
  beauty.renderTarget.samples = 4;
  const rawColour = (beauty as IRawPass).getRawTextureNode();
  beauty.renderTarget.samples = samples;
  const buffer = new Vector2();
  let active = false;
  let disposed = false;
  let changed: ((renderer: Renderer, active: boolean) => void) | undefined;
  let failed: (() => void) | undefined;
  let ownedContext: typeof beauty.contextNode = null;

  function restorePolicy() {
    if (sourceTarget.samples === 4) {
      sourceTarget.dispose();
      sourceTarget.samples = samples;
    }
    if (options.samples === 4) {
      if (originalSamplesOption === undefined) Reflect.deleteProperty(options, "samples");
      else options.samples = originalSamplesOption;
    }
    if (beauty.contextNode === ownedContext) beauty.contextNode = originalContext;
    beauty.needsUpdate = true;
  }

  function switchMode(renderer: Renderer, next: boolean) {
    if (next === active) return;
    if (next) {
      beauty.renderTarget.dispose();
      beauty.renderTarget.samples = 4;
      options.samples = 4;
      ownedContext = context(selectivePolicy);
      beauty.contextNode = ownedContext;
      beauty.needsUpdate = true;
    } else restorePolicy();
    active = next;
    replay.setActive(next);
    if (!next) replay.release();
    changed?.(renderer, next);
  }

  const ownedDraw: typeof beauty.updateBefore = (frame) => {
    if (disposed || frame.renderer === null)
      throw new Error("Current footprint producer is disposed or has no renderer.");
    const renderer = frame.renderer;
    const scene = sourceScene;
    renderer.getDrawingBufferSize(buffer);
    const scale = beauty.getResolutionScale();
    const width = Math.floor(buffer.x * scale);
    const height = Math.floor(buffer.y * scale);
    const sourceMotion = beauty.getMRT()?.get("velocity");
    const policyOwned =
      beauty.renderTarget === sourceTarget &&
      (beauty as IRawPass).options === options &&
      originalContext === null &&
      beauty.contextNode === (active ? ownedContext : originalContext) &&
      beauty.renderTarget.samples === (active ? 4 : samples) &&
      options.samples === (active ? 4 : originalSamplesOption);
    const eligible =
      beauty.scene === sourceScene &&
      beauty.camera === sourceCamera &&
      beauty.overrideMaterial === null &&
      policyOwned &&
      currentPassEligible(beauty, renderer, buffer, width, height, sharedMotion);
    switchMode(renderer, eligible);
    if (!active) {
      // Preserve every ordinary callback/scene mutation; the wrapper has changed no draw state.
      try {
        return originalDraw.call(beauty, frame);
      } catch (error) {
        failed?.();
        throw error;
      }
    }
    const saved = RendererUtils.saveRendererState(renderer);
    const savedContext = renderer.contextNode;
    const savedName = scene.name;
    const savedOverride = scene.overrideMaterial;
    const savedBackground = scene.background;
    const savedLayers = beauty.camera.layers.mask;
    const savedOpaque = renderer.opaque;
    const savedTransparent = renderer.transparent;
    try {
      originalDraw.call(beauty, frame);
      replay.draw(frame, width, height, scale, sourceMotion as Node<"vec2">);
    } catch (error) {
      // A scene/replay failure can precede the temporal node's own updateBefore. Its next successful
      // frame must not reuse colour/depth from before the camera's motion bookkeeping advanced.
      failed?.();
      throw error;
    } finally {
      scene.background = savedBackground;
      scene.name = savedName;
      scene.overrideMaterial = savedOverride;
      beauty.camera.layers.mask = savedLayers;
      renderer.opaque = savedOpaque;
      renderer.transparent = savedTransparent;
      renderer.contextNode = savedContext;
      RendererUtils.restoreRendererState(renderer, saved);
    }
  };
  beauty.updateBefore = ownedDraw;

  return {
    depth: replay.depth,
    motion: replay.motion,
    inputs: { colour: rawColour, ...replay.inputs } satisfies ITemporalCurrentInputs,
    active: () => active,
    onModeChange: (callback: typeof changed) => {
      changed = callback;
    },
    onFailure: (callback: typeof failed) => {
      failed = callback;
    },
    /** Queue after BOTH resolve and counter readers; never copy a multisampled depth to a scalar. */
    publishDepth: (renderer: Renderer) => {
      if (!active) return;
      replay.publishDepth(renderer);
    },
    /** Conservative candidate input/history168L plus proven-needed centre replay16L; display
     * resolve/history16N are separate. Format/native allocator overhead is not included. */
    storageBytes: () => (active ? beauty.renderTarget.width * beauty.renderTarget.height * 184 : 0),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (beauty.updateBefore === ownedDraw) beauty.updateBefore = originalDraw;
      if (active) restorePolicy();
      replay.dispose();
      changed = undefined;
      failed = undefined;
    },
  };
}
export type TemporalCurrentProducer = ReturnType<typeof createTemporalCurrentProducer>;
