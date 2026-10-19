// Generated for you: ordinary Three.js GPU metering; exposure.ts owns the game's look.
import { type RenderTarget, Texture, Vector2 } from "three";
import { float, ivec2, nodeObject, texture, textureLoad, uniform, vec4 } from "three/tsl";
import {
  type Node,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  type Renderer,
  RendererUtils,
  TempNode,
} from "three/webgpu";
import {
  type IExposureSettings,
  exposureLuminance,
  exposureMeter,
  exposureReductionSizes,
  validateExposureSettings,
} from "./exposure.js";

import {
  type ColourTexture,
  type Decode,
  type Meter,
  adaptExposure,
  exposureBins,
  exposureTarget,
  exposureTiles,
  histogramExposure,
  histogramTiles,
  reduceExposure,
} from "./exposureGraph.js";
import { ExposureReadback } from "./exposureReadback.js";

/** Scene-referred exposure changes light, never coverage/compositing alpha. */
export function applyExposure(colour: Node<"vec4">, exposure: Node<"float">): Node<"vec4"> {
  return vec4(colour.rgb.mul(exposure), colour.a);
}

/** Owns scratch targets only. Never draws the world or installs another output transform. */
export class AutoExposureNode extends TempNode<"float"> {
  static get type(): string {
    return "AutoExposureNode";
  }
  readonly input: ColourTexture;
  readonly settings: Readonly<IExposureSettings>;
  readonly #constant: number;
  readonly #size = new Vector2();
  readonly #sourceSize = uniform(new Vector2(1, 1));
  readonly #reduceSize = uniform(new Vector2(1, 1));
  readonly #blockSize = uniform(new Vector2(1, 1));
  readonly #delta = uniform(0);
  readonly #resetMode = uniform(1); // 0 = history, 1 = seed, 2 = next measured target
  readonly #seed = uniform(0);
  readonly #enabled = uniform(false);
  readonly #quad = new QuadMesh();
  readonly #meterMaterial = new NodeMaterial();
  readonly #reduceMaterial = new NodeMaterial();
  readonly #tilesMaterial = new NodeMaterial();
  readonly #histogramMaterial = new NodeMaterial();
  readonly #adaptMaterial = new NodeMaterial();
  readonly #tilesTarget = exposureTarget();
  readonly #histogramTarget = exposureTarget();
  #readTarget = exposureTarget();
  #writeTarget = exposureTarget();
  #levels: RenderTarget[] = [];
  readonly #reduced = texture(new Texture());
  readonly #blocks = texture(new Texture());
  readonly #previous = texture(this.#readTarget.texture);
  readonly #result = texture(this.#writeTarget.texture);
  #disposed = false;
  readonly #observation: ExposureReadback;
  // Three's runtime accepts undefined on first use, but its declaration requires a state.
  #rendererState: Parameters<typeof RendererUtils.resetRendererState>[1] | undefined;

  constructor(
    input: ColourTexture,
    settings: IExposureSettings,
    constantExposure: number,
    meter: Meter = (colour, uv) => exposureMeter(colour, uv),
    decode: Decode = (mean) => exposureLuminance(mean),
  ) {
    super("float");
    validateExposureSettings(settings);
    if (!Number.isFinite(Math.fround(constantExposure)) || Math.fround(constantExposure) <= 0)
      throw new Error("Exposure constant must be finite and positive.");
    this.input = input;
    this.settings = Object.freeze({ ...settings });
    const policy = this.settings;
    this.#constant = constantExposure;
    this.#seed.value = Math.log2(settings.initialExposure);
    this.#enabled.value = settings.enabled;
    this.#observation = new ExposureReadback(constantExposure, () => this.#enabled.value);
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.#meterMaterial.fragmentNode = reduceExposure(input, this.#sourceSize, meter);
    this.#reduceMaterial.fragmentNode = reduceExposure(this.#reduced, this.#reduceSize);
    this.#tilesTarget.setSize(exposureBins, exposureTiles);
    this.#histogramTarget.setSize(exposureBins, 1);
    this.#tilesMaterial.fragmentNode = histogramTiles(this.#blocks, this.#blockSize, policy);
    this.#histogramMaterial.fragmentNode = histogramExposure(texture(this.#tilesTarget.texture));
    this.#adaptMaterial.fragmentNode = adaptExposure(
      texture(this.#histogramTarget.texture),
      this.#previous,
      this.#resetMode,
      this.#seed,
      this.#delta,
      policy,
      decode,
    );
  }

  override setup(builder: NodeBuilder): Node<"float"> {
    // Force the existing pass dependency even in disabled mode; off never means unmeasured.
    super.setup(builder);
    return this.#enabled.select(
      textureLoad(this.#result, ivec2(0)).r.exp2(),
      float(this.#constant),
    );
  }

  get exposureNode(): Node<"float"> {
    return nodeObject(this);
  }

  reset(exposure?: number): void {
    if (this.#disposed) throw new Error("Exposure node is disposed.");
    if (
      exposure !== undefined &&
      (!Number.isFinite(Math.fround(exposure)) || Math.fround(exposure) <= 0)
    )
      throw new Error("Exposure reset must be finite and positive.");
    this.#resetMode.value = exposure === undefined ? 2 : 1;
    if (exposure !== undefined) this.#seed.value = Math.log2(exposure);
    this.#observation.invalidate();
  }

  setEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("Exposure enabled must be boolean.");
    if (this.#disposed) throw new Error("Exposure node is disposed.");
    this.#enabled.value = enabled;
    this.#observation.invalidate();
  }

  getObservation(): Record<string, unknown> {
    return this.#observation.get();
  }

  override updateBefore(frame: NodeFrame): undefined {
    if (this.#disposed) throw new Error("Exposure node is disposed.");
    const renderer = frame.renderer;
    if (renderer === null) throw new Error("Exposure requires a renderer.");
    if (!Number.isFinite(frame.deltaTime) || frame.deltaTime < 0 || !Number.isFinite(frame.time))
      throw new Error("Exposure frame time must be finite and nonnegative.");
    renderer.getDrawingBufferSize(this.#size);
    // Level 0 meters 4x4 pixels, level 1 averages 16x16. The histogram gathers level 1.
    const sizes = exposureReductionSizes(this.#size.x, this.#size.y).slice(0, 2);
    this.#sourceSize.value.copy(this.#size);
    this.#delta.value = Math.min(frame.deltaTime, this.settings.maxDelta);
    while (this.#levels.length > sizes.length) this.#levels.pop()?.dispose();
    for (const [i, [width, height]] of sizes.entries()) {
      const level = this.#levels[i] ?? exposureTarget();
      this.#levels[i] = level;
      level.setSize(width, height);
    }
    this.#rendererState ??= RendererUtils.saveRendererState(renderer);
    this.#rendererState = RendererUtils.resetRendererState(renderer, this.#rendererState);
    try {
      for (const [i, level] of this.#levels.entries()) {
        const previous = this.#levels[i - 1];
        if (previous !== undefined) {
          this.#reduced.value = previous.texture;
          this.#reduceSize.value.set(previous.width, previous.height);
        }
        this.#quad.material = i === 0 ? this.#meterMaterial : this.#reduceMaterial;
        renderer.setRenderTarget(level);
        this.#quad.render(renderer);
      }
      const final = this.#levels.at(-1);
      if (final === undefined) throw new Error("Exposure reduction is empty.");
      this.#blocks.value = final.texture;
      this.#blockSize.value.set(final.width, final.height);
      this.#quad.material = this.#tilesMaterial;
      renderer.setRenderTarget(this.#tilesTarget);
      this.#quad.render(renderer);
      this.#quad.material = this.#histogramMaterial;
      renderer.setRenderTarget(this.#histogramTarget);
      this.#quad.render(renderer);
      const write = this.#writeTarget;
      this.#previous.value = this.#readTarget.texture;
      this.#quad.material = this.#adaptMaterial;
      renderer.setRenderTarget(write);
      this.#quad.render(renderer);
      this.#result.value = write.texture;
      this.#writeTarget = this.#readTarget;
      this.#readTarget = write;
      this.#resetMode.value = 0;
      this.#observation.report(renderer, write, frame.time, this.settings.reportInterval);
    } finally {
      RendererUtils.restoreRendererState(renderer, this.#rendererState);
    }
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observation.dispose();
    for (const level of [
      ...this.#levels,
      this.#tilesTarget,
      this.#histogramTarget,
      this.#readTarget,
      this.#writeTarget,
    ])
      level.dispose();
    this.#levels = [];
    this.#meterMaterial.dispose();
    this.#reduceMaterial.dispose();
    this.#tilesMaterial.dispose();
    this.#histogramMaterial.dispose();
    this.#adaptMaterial.dispose();
    super.dispose();
  }
}
