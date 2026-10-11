// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or
// rewrite it freely — every default in here is a starting point, not a framework look.
//
// `WorldEnvironment` is Godot's name for the node that says which lighting effects a scene
// runs and how strong they are, and the property names below are Godot's `Environment`
// properties where Godot has one (`ssr_enabled`, `glow_enabled`, `tonemap_mode`) and
// Three.js's node names where it does not (`ssgi`, `gtao`). Nothing here is a new word.
//
// What it owns: building the stage factories and handing them to
// `renderer.createRenderChain()`, which decides the order stages run in, whether each can
// run on this target, and prints `TN_RENDER_CHAIN` naming every stage as applied or
// refused **with a reason** — so a stage that silently no-op'd is never mistaken for one
// you turned off. What it does not own: any colour, and any strength that is not a quality
// tier. Those are arguments, supplied by `postprocessing.ts`, yours to change.

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  type Camera,
  type DirectionalLight,
  MaterialBlending,
  NeutralToneMapping,
  type PerspectiveCamera,
  type Scene,
} from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { godrays } from "three/addons/tsl/display/GodraysNode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { sharpen } from "three/addons/tsl/display/SharpenNode.js";
import {
  color,
  convertToTexture,
  float,
  max,
  metalness,
  mrt,
  normalView,
  output,
  pass,
  roughness,
  screenUV,
  smoothstep,
  vec2,
  vec4,
} from "three/tsl";
import { BlendMode, type Node } from "three/webgpu";
import { AutoExposureNode, applyExposure } from "./autoExposure.js";
import { type IExposureSettings, exposureSettings } from "./exposure.js";

/** Godot's `Viewport.screen_space_aa`: which post-process antialiasing smooths the frame's edges. */
export type ScreenSpaceAA = "smaa" | "fxaa" | "disabled";

/** Godot's `Environment.tonemap_mode`, with the modes Three.js actually ships. */
export type TonemapMode = "aces" | "agx" | "neutral";

/**
 * SSGI sample budget. The three tiers are the presets SSGINode's own documentation
 * recommends for the temporally-filtered case, not numbers invented here. An unknown
 * tier throws rather than quietly becoming the default.
 */
export type SsgiQuality = "low" | "medium" | "high";

const SSGI_QUALITY: Record<SsgiQuality, { sliceCount: number; stepCount: number }> = {
  low: { sliceCount: 1, stepCount: 12 },
  medium: { sliceCount: 2, stepCount: 8 },
  high: { sliceCount: 3, stepCount: 16 },
};

const TONEMAP: Record<TonemapMode, number> = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
};

export interface IWorldEnvironmentOptions {
  /** Screen-space indirect diffuse light. Godot calls this `ssil_enabled`. */
  readonly ssgiEnabled?: boolean;
  readonly ssgiQuality?: SsgiQuality;
  /** How much of the gathered indirect light reaches the frame. Godot's `ssil_intensity`. */
  readonly ssgiIntensity?: number;
  /** How far, in world units, indirect light is gathered from. Room scale, not contact scale. */
  readonly ssgiRadius?: number;
  /** Screen-space reflections. Godot's `ssr_enabled`. */
  readonly ssrEnabled?: boolean;
  /**
   * How far, in world units, a reflection ray is traced.
   *
   * `SSRNode` defaults this to **1**, which is one metre. On any scene larger than a
   * tabletop that reads as "screen-space reflections are on and do nothing" — the ray
   * terminates before it reaches the thing that should be standing in the floor.
   */
  readonly ssrMaxDistance?: number;
  /**
   * Fraction of the display resolution the reflection is traced at.
   *
   * A reflection in a rough surface carries almost no high-frequency detail, so tracing it
   * at half resolution costs a quarter of the rays and is very hard to see in the result.
   */
  readonly ssrResolutionScale?: number;
  /** Spatial denoise over the SSGI result. Off is noisier and cheaper. */
  readonly denoiseEnabled?: boolean;
  /** Raymarched shafts. Needs `godraysLight`, and that light must cast shadows. */
  readonly godraysEnabled?: boolean;
  /** How dense the participating medium is. Higher is foggier — and the whole frame brighter. */
  readonly godraysDensity?: number;
  /**
   * Haze below this value is discarded instead of added to the frame.
   *
   * Without it the pass is a uniform brightener rather than a shaft renderer: it returns a
   * non-zero value for nearly every pixel, and that "something" is tiny in linear space and
   * enormous after the tone curve, which lifts shadows hardest. Subtracting a floor keeps
   * the air inside a real beam and discards the ambient lift.
   */
  readonly godraysFloor?: number;
  /** Multiplier applied after the floor, so beams can be bright without the haze returning. */
  readonly godraysIntensity?: number;
  /**
   * Raymarch steps per pixel. `GodraysNode` defaults to 60.
   *
   * Every step is a shadow-map sample, so this multiplies directly into the cost of the
   * whole pass. The pass jitters its sample positions, so a lower count trades a hard shaft
   * edge for a slightly noisier one rather than for banding — which the denoiser then
   * largely absorbs.
   */
  readonly godraysSteps?: number;
  /**
   * Ceiling on shaft brightness.
   *
   * This is also the single strongest control over how bright the *whole* scene looks: the
   * pass adds its accumulated illumination to every pixel, not only to the pixels inside a
   * visible beam, so raising it raises the shadow floor of the entire frame.
   */
  readonly godraysMaxDensity?: number;
  /**
   * Ground-truth ambient occlusion, at contact scale. Godot's `ssao_enabled`.
   *
   * Deliberately a *second* occlusion term next to the one SSGI already produces. SSGI's AO
   * is gathered over `ssgiRadius` — metres — the right scale for "this hall is enclosed"
   * and the wrong one for "this foot is standing on this floor". This pass runs at a radius
   * of centimetres and multiplies on top.
   */
  readonly gtaoEnabled?: boolean;
  /** Occlusion gather radius in world units. Contact scale, not room scale. */
  readonly gtaoRadius?: number;
  /** Exponent on the occlusion term: higher is a darker, tighter contact. */
  readonly gtaoScale?: number;
  /** Directions sampled per pixel. Cost is linear in this. */
  readonly gtaoSamples?: number;
  /** Fraction of display resolution the occlusion is traced at. */
  readonly gtaoResolutionScale?: number;
  /**
   * The fraction of the frame SSGI actually gathers at. Half by default.
   *
   * `GTAONode` and `SSRNode` both carry a `resolutionScale` of their own; **`SSGINode` does not**,
   * and its `setSize` passes width and height straight into its render target with no factor. So
   * screen-space GI — a low-frequency effect every production renderer gathers at half or quarter
   * res — was the only stage in this chain running at full resolution, and it cost accordingly.
   *
   * Measured on a 46,190-instance forest at 1600x900 on an RTX 2080, with the resolution scaler
   * left on auto so the engine's own verdict is part of the result:
   *
   *                    fps still/walk   scale it settled on   interior median   dead shadow
   *   full res             38.0 / 47.2      0.44  704x396          0.0299          19.19%
   *   off                  60.0 / 60.0      0.61  976x549          0.0987           4.54%
   *   half res             59.8 / 60.0      0.72 1152x648          0.0301          18.58%
   *
   * Half res is better than both: it holds the budget like switching SSGI off, keeps the look
   * within noise of full res, and produces the *sharpest* frame of the three — because the budget
   * it hands back is spent by the scaler on pixels rather than on a gather nobody can see at full
   * rate. Full-res SSGI was not buying quality, it was trading it.
   *
   * Fixed without touching three: `setSize` is public and the pass drives the node through it with
   * the full frame size, so the instance is wrapped to hand it a smaller one. The node's own maths
   * reads the `_resolution` uniform that `setSize` writes, so it stays self-consistent, and the
   * result is sampled by UV rather than by texel — which is what makes the upsample free and is
   * exactly the mechanism `GTAONode` uses internally.
   */
  readonly ssgiResolutionScale?: number;
  /**
   * Contrast-adaptive sharpening (RCAS) over the finished frame.
   *
   * Everything upstream of it blurs: the GI gather is denoised, the reflection is traced at
   * reduced resolution and roughness-blurred. Each is worth its softness on its own and the
   * sum is a frame with no micro-detail left. RCAS is contrast-adaptive, so it puts the
   * edges back without ringing the soft areas.
   */
  readonly sharpenEnabled?: boolean;
  /** RCAS sharpness. **0 is maximum sharpening and 2 is none** — it is a radius, not a gain. */
  readonly sharpenStrength?: number;
  /** Corner darkening, as a fraction removed at the extreme corner. Zero disables it. */
  readonly vignetteAmount?: number;
  /**
   * Post-process antialiasing, run last. Godot's `Viewport.screen_space_aa`. Default `"smaa"`.
   *
   * Not optional in practice: the chain renders `pass(scene, camera)` single-sampled, so the moment
   * any stage runs, the renderer's own multisampling no longer reaches the frame and every edge
   * stairsteps — the single loudest "this is a prototype" signal in a frame. It is requested only
   * when some other stage (or a `baseColour`) installs a chain; with nothing installed the renderer
   * draws straight to the canvas with its own MSAA and this would be paying twice.
   */
  readonly screenSpaceAA?: ScreenSpaceAA;
  /** Godot's `glow_enabled`. */
  readonly bloomEnabled?: boolean;
  readonly bloomStrength?: number;
  /** How far a bright pixel bleeds, as a fraction of the screen. */
  readonly bloomRadius?: number;
  /** Luminance a pixel must exceed before it blooms at all. */
  readonly bloomThreshold?: number;
  /**
   * Which of this kit's authored stages to run.
   *
   * Separate from the graph below, and not for tidiness: the chain has to know whether anything
   * was requested at all before the scene pass exists — with nothing requested it sets an
   * exposure and returns, and no pass is ever built. So the request is a static decision the kit
   * makes from its own config, and only the graph needs the pass.
   */
  readonly authoredStageNames?: readonly string[];
  /**
   * This kit's own stages, composed after the built-ins.
   *
   * A factory because an authored stage needs the two things only this file can produce: the
   * scene pass's depth texture node, which does not exist until the pass is built, and the
   * resolved tier. It returns the complete graph — including stages left dormant this frame — so
   * that an anchor like `watercolor after kuwahara` keeps naming a stage that exists.
   *
   * Naming specific stages here instead — an `outlineEnabled`, a `kuwaharaRadius` — is what put
   * one kit's look inside the plumbing every kit copies verbatim, which
   * `shared-render-sources.spec.ts` exists to refuse.
   */
  readonly authoredStages?: (context: IWorldEnvironmentStageContext) => readonly ChainStage[];
  /** Quality tier passed to the measured chain; the quality module owns this value. */
  readonly renderChainTier?: ChainTier;
  readonly tonemapMode?: TonemapMode;
  /**
   * Scene-referred exposure: multiplied into the scene pass **before** the tone curve, so
   * the GI gather, reflections and bloom threshold all see the exposed image and the bloom
   * threshold means the same thing at any exposure.
   *
   * `renderer.toneMappingExposure` is live too (measured on three@0.185.1 — see
   * `docs/verification/exposure-ab-2026-08-30.md`), and applies at the same point in the
   * graph, but only when no output node is installed. When every stage here is off, this
   * class falls back to that scalar; when any stage runs, this multiply is the shutter.
   */
  readonly exposure?: number;
  /** Cost opt-in. False retains the direct constant-exposure path. */
  readonly autoExposureEnabled?: boolean;
  /** Editable game policy; disabled application still measures when cost is opted in. */
  readonly exposurePolicy?: Readonly<IExposureSettings>;
}

export interface IWorldEnvironmentTarget {
  /** The directional light godrays are raymarched against. Required only by `godraysEnabled`. */
  readonly godraysLight?: DirectionalLight;
  /**
   * Composes the colour the chain starts from, given the scene pass it renders.
   *
   * The chain builds `pass(scene, camera)` itself, so a game that composes something onto the
   * beauty pass before any stage runs — aerial perspective, read against that pass's own view-Z,
   * is the one in these templates — has nowhere else to put it. The node returned here is the
   * game's; the chain only decides where it is spliced in, which is first, ahead of exposure and
   * every stage.
   */
  readonly baseColour?: (scenePass: ReturnType<typeof pass>) => Node<"vec4">;
}

/**
 * What travels down the chain: the composed colour, as TSL's proxied vec4 node — the thing
 * that carries `.mul`, `.add`, `.rgb` and `.r`. Every stage takes one and returns one, so the
 * compiler checks the composition instead of taking a cast's word for it.
 */
type ChainNode = Node<"vec4">;
/**
 * The scene pass's depth texture, as the pass itself types it.
 *
 * Named through `pass()` rather than written out because the addon's return type is the only
 * honest spelling of it, and a hand-written alias here would drift the first time three changes it.
 */
export type DepthTextureNode = ReturnType<ReturnType<typeof pass>["getTextureNode"]>;
type ChainTier = "high" | "medium" | "low" | "off";
type ChainContext = {
  readonly tier: ChainTier;
  /**
   * The sampled velocity texture, present only when this chain request provisioned one.
   *
   * Distinct from the accessor TRAANode wants: the chain passes the texture here and installs the
   * accessor on the graph separately, so a stage that handed this node over as the accessor would
   * sample a texture that no fragment stage writes.
   */
  readonly velocityNode?: Node;
};
/**
 * What a kit's `authoredStages` factory is handed. The depth node is the scene pass's, so a
 * stage that reads depth gets the same texture the built-in stages read rather than its own.
 */
export interface IWorldEnvironmentStageContext {
  readonly depthNode: DepthTextureNode;
  readonly tier: ChainTier;
  /** The camera the scene pass renders with, which is the one a temporal stage must jitter. */
  readonly camera: Camera;
}

export type ChainStage = {
  readonly name: string;
  readonly before?: string;
  readonly after?: string;
  /**
   * This stage reads display-referred colour — tone-mapped and sRGB-encoded — so the chain
   * installs the graph with the renderer's automatic output transform switched off and the stage
   * applies that transform itself (`renderOutput` from `three/tsl`).
   *
   * For effects authored against the picture rather than against light: a `.cube` table, an
   * sRGB-space edge filter. Such a stage runs last and may not declare an anchor, and the chain
   * only hands the renderer its transform back when the stage was actually refused.
   */
  readonly afterOutputTransform?: boolean;
  readonly available?: (context: ChainContext) => boolean | string;
  readonly dispose?: () => void;
  readonly minimumTier?: ChainTier;
  /**
   * A temporal stage's completed rejection measurement. Its shape is the engine's velocity
   * contract, restated here so this file keeps importing nothing, and it is asked once per frame
   * after rendering. A stage that has not built, or has nothing landed yet, answers `undefined` —
   * which the chain reports as absent rather than as zero.
   */
  readonly rejectionMeasurement?: () => { frame: number; rejectionFraction: number } | undefined;
  /** The chain plumbing is stage-agnostic, so it names the node it carries `unknown`. */
  readonly build: (input: unknown, context: ChainContext) => unknown;
};

/**
 * The one seam between the chain's `unknown` and this file's node algebra.
 *
 * What the chain hands a stage is the colour composed so far — the previous stage's return, or
 * the exposed scene pass for the first one — and that is always a `ChainNode`. Saying so once,
 * here, is what lets every stage below be written and *checked* as vec4-in, vec4-out instead of
 * asserting its way through each expression. The wrapper adds no node to the graph.
 */
function stage(definition: {
  readonly name: ChainStage["name"];
  readonly dispose?: () => void;
  readonly available?: (context: ChainContext) => boolean | string;
  readonly build: (input: ChainNode, context: ChainContext) => ChainNode;
}): ChainStage {
  return {
    ...definition,
    build: (input, context) => definition.build(input as ChainNode, context),
  };
}

/**
 * `three/addons` declares each TSL stage as its raw node class, and `DenoiseNode` is the only
 * one in this chain whose declaration omits the element API (`.mul`, `.rgb`, `.r`) that the
 * proxied node object it actually hands back at runtime carries — every other stage here is a
 * `ChainNode` on its own, checked by the compiler. This is an assertion and nothing else: no
 * conversion runs, no node is added to the graph, so it cannot move a pixel.
 */
function denoised(node: ReturnType<typeof denoise>): ChainNode {
  return node as unknown as ChainNode;
}
type OutputInstallation = { isCurrent(): boolean; dispose(): void };
type OutputSetter =
  | ((node: unknown, worldPass?: unknown) => void)
  | ((node: unknown, worldPass?: unknown) => OutputInstallation);

export type OutputRenderer = {
  kind: string;
  raw: unknown;
  /**
   * Installs a node graph directly. Only reached when a `baseColour` is composed and every
   * stage is off: the chain installs nothing for an empty stage list, and dropping the game's
   * own composition on the floor would be the silent no-op this class exists to prevent.
   */
  setOutputNode?: OutputSetter;
  /** Legacy node-only clear. The returned receipt distinguishes same-node reinstalls. */
  clearOutputNode?: (expectedNode?: unknown) => void;
  createRenderChain?: (options: {
    input?: unknown;
    worldPass?: unknown;
    request?: {
      stages?: readonly string[];
      tier?: ChainContext["tier"];
      /**
       * The scene pass that owns the shared velocity output, for a temporal stage to read. Its
       * shape is the engine's velocity contract, restated here so this file keeps importing
       * nothing: `pass(scene, camera)` returns exactly this.
       */
      velocity?: {
        pass?: ReturnType<typeof pass>;
        rejectionMeasurement?: () => { frame: number; rejectionFraction: number } | undefined;
      };
    };
    stages?: readonly ChainStage[];
  }) => {
    applied: { dropped: readonly { name: string; reason: string }[]; stages: readonly string[] };
    dispose(): void;
  };
};

/**
 * Builds a Godot-named lighting chain and installs it through the renderer's render chain.
 *
 * Every stage a game turns on reports itself: the chain prints `TN_RENDER_CHAIN` naming
 * each requested stage as applied or refused with a reason that is never blank. A game with
 * GI switched off on a WebGL fallback looks exactly like a game that chose not to use it —
 * unless it reads that line.
 */
export class WorldEnvironment {
  readonly #options: Required<IWorldEnvironmentOptions>;

  constructor(options: IWorldEnvironmentOptions = {}) {
    const quality = options.ssgiQuality ?? "medium";
    if (SSGI_QUALITY[quality] === undefined) {
      // Fail closed. A typo'd tier that silently became "medium" is a quality setting
      // nobody can trust afterwards.
      throw new Error(
        `Unknown ssgiQuality '${String(quality)}'. Use one of: ${Object.keys(SSGI_QUALITY).join(", ")}.`,
      );
    }
    const tonemapMode = options.tonemapMode ?? "aces";
    if (TONEMAP[tonemapMode] === undefined) {
      throw new Error(
        `Unknown tonemapMode '${String(tonemapMode)}'. Use one of: ${Object.keys(TONEMAP).join(", ")}.`,
      );
    }
    const renderChainTier = options.renderChainTier ?? "high";
    if (!isChainTier(renderChainTier)) {
      throw new Error(
        `Unknown render chain tier '${String(renderChainTier)}'. Use high, medium, low, or off.`,
      );
    }
    this.#options = {
      // A kit with no stages of its own is the common case, so both default to empty rather
      // than to a branch every call site has to remember.
      authoredStageNames: options.authoredStageNames ?? [],
      authoredStages: options.authoredStages ?? (() => []),
      ssgiEnabled: options.ssgiEnabled ?? false,
      ssgiQuality: quality,
      ssgiIntensity: options.ssgiIntensity ?? 1,
      ssgiRadius: options.ssgiRadius ?? 12,
      ssrEnabled: options.ssrEnabled ?? false,
      ssrMaxDistance: options.ssrMaxDistance ?? 30,
      ssrResolutionScale: options.ssrResolutionScale ?? 0.5,
      denoiseEnabled: options.denoiseEnabled ?? true,
      godraysEnabled: options.godraysEnabled ?? false,
      godraysDensity: options.godraysDensity ?? 0.7,
      godraysFloor: options.godraysFloor ?? 0,
      godraysIntensity: options.godraysIntensity ?? 1,
      godraysSteps: options.godraysSteps ?? 60,
      godraysMaxDensity: options.godraysMaxDensity ?? 0.5,
      gtaoEnabled: options.gtaoEnabled ?? false,
      gtaoRadius: options.gtaoRadius ?? 0.25,
      gtaoScale: options.gtaoScale ?? 1,
      gtaoSamples: options.gtaoSamples ?? 16,
      gtaoResolutionScale: options.gtaoResolutionScale ?? 1,
      ssgiResolutionScale: options.ssgiResolutionScale ?? 0.5,
      sharpenEnabled: options.sharpenEnabled ?? false,
      sharpenStrength: options.sharpenStrength ?? 0.2,
      vignetteAmount: options.vignetteAmount ?? 0,
      screenSpaceAA: options.screenSpaceAA ?? "smaa",
      bloomEnabled: options.bloomEnabled ?? true,
      bloomStrength: options.bloomStrength ?? 0.7,
      bloomRadius: options.bloomRadius ?? 0.5,
      bloomThreshold: options.bloomThreshold ?? 0.2,
      renderChainTier,
      tonemapMode,
      exposure: options.exposure ?? 1,
      autoExposureEnabled: options.autoExposureEnabled ?? false,
      exposurePolicy: options.exposurePolicy ?? exposureSettings,
    };
  }

  /**
   * Installs the chain. Returns what actually ran — the same applied report the chain
   * printed — so a scene can assert on it instead of scraping the console.
   */
  apply(
    renderer: OutputRenderer,
    scene: Scene,
    camera: Camera,
    target: IWorldEnvironmentTarget = {},
  ): {
    dropped: readonly { name: string; reason: string }[];
    stages: readonly string[];
    dispose?: () => void;
    exposure?: AutoExposureNode;
  } {
    const options = this.#options;
    const raw = renderer.raw as { toneMapping?: number; toneMappingExposure?: number };
    raw.toneMapping = TONEMAP[options.tonemapMode];

    const requested: string[] = (
      ["ssgi", "ambientOcclusion", "godRays", "ssr", "sharpen", "bloom", "vignette"] as const
    ).filter(
      (name) =>
        (name === "ssgi" && options.ssgiEnabled) ||
        (name === "ambientOcclusion" && options.gtaoEnabled) ||
        (name === "godRays" && options.godraysEnabled) ||
        (name === "ssr" && options.ssrEnabled) ||
        (name === "sharpen" && options.sharpenEnabled) ||
        (name === "bloom" && options.bloomEnabled) ||
        (name === "vignette" && options.vignetteAmount > 0),
    );
    requested.push(...options.authoredStageNames);
    if (
      options.screenSpaceAA !== "disabled" &&
      (requested.length > 0 || target.baseColour !== undefined)
    )
      requested.push("antialias");

    // With no stage running there is no node graph to install — the renderer's own
    // tone-mapping path renders the frame, and the exposure scalar is live there (measured:
    // `docs/verification/exposure-ab-2026-08-30.md`). With any stage running, exposure is
    // applied as a multiply on the scene pass instead: scene-referred, so every downstream
    // stage sees the exposed image and the bloom threshold means the same thing at any
    // exposure. Both land at the same point in the graph — before the tone curve.
    if (requested.length === 0 && target.baseColour === undefined && !options.autoExposureEnabled) {
      raw.toneMappingExposure = options.exposure;
      this.#reportApplied([], []);
      return { dropped: [], stages: [] };
    }
    if (options.autoExposureEnabled && renderer.kind !== "webgpu")
      throw new Error(`Automatic exposure requires WebGPU; renderer:${renderer.kind}`);
    if (requested.length === 0 && renderer.kind !== "webgpu") {
      const dropped = [{ name: "baseColour", reason: `renderer:${renderer.kind}` }];
      this.#reportApplied([], dropped);
      return { dropped, stages: [] };
    }
    raw.toneMappingExposure = 1;

    const scenePass = pass(scene, camera);
    // Normals come from the multi-render-target alongside the colour. SSGI can derive them
    // from depth alone, but the derived normal is flat across a triangle, which shows up as
    // faceted bounce on exactly the smooth surfaces GI is bought for. Metalness and
    // roughness ride along so SSR knows which pixels are supposed to reflect.
    if (options.ssgiEnabled || options.ssrEnabled || options.gtaoEnabled) {
      // The normal target uses the material blend mode. Its alpha is zero, so a transparent card
      // keeps the opaque normal beneath it. GTAO then does not darken a square behind the card.
      const sceneMrt = mrt({ output, normal: vec4(normalView, 0), metalness, roughness });
      sceneMrt.setBlendMode("normal", new BlendMode(MaterialBlending));
      scenePass.setMRT(sceneMrt);
    }
    // Requested lazily, and this is not a micro-optimisation. **Asking a pass for `normal`,
    // `metalness` or `roughness` is what creates the extra render target.** A tier that runs none
    // of the stages needing them — the mobile look is bloom and the tone curve — must not ask, or
    // the pass carries a colour target no fragment shader writes and WebGPU refuses the pipeline:
    // *"Color target has no corresponding fragment stage output but writeMask … is not zero.
    // While validating targets[1]"*. The frame then comes out **black** while the chain still
    // reports every stage as applied, which is the worst shape a failure can take here.
    const nodes = new Map<string, ReturnType<typeof scenePass.getTextureNode>>();
    const textureNode = (name: string): ReturnType<typeof scenePass.getTextureNode> => {
      const cached = nodes.get(name);
      if (cached !== undefined) return cached;
      const node = scenePass.getTextureNode(name);
      nodes.set(name, node);
      return node;
    };
    const depth = (): ReturnType<typeof scenePass.getTextureNode> => textureNode("depth");
    const normal = (): ReturnType<typeof scenePass.getTextureNode> => textureNode("normal");
    const metal = (): ReturnType<typeof scenePass.getTextureNode> => textureNode("metalness");
    const rough = (): ReturnType<typeof scenePass.getTextureNode> => textureNode("roughness");
    // Every stage here is perspective-camera maths — view-space reconstruction from depth,
    // and a projection matrix inverse. The scene's camera is the one the pass rendered with.
    const view = camera as PerspectiveCamera;

    const base = target.baseColour?.(scenePass) ?? scenePass.getTextureNode("output");
    const colour = convertToTexture(base);
    const exposure = options.autoExposureEnabled
      ? new AutoExposureNode(colour, options.exposurePolicy, options.exposure)
      : undefined;
    const exposed =
      exposure === undefined
        ? colour.mul(options.exposure)
        : applyExposure(colour, exposure.exposureNode);
    let released = false;
    const releaseGraph = (): void => {
      if (released) return;
      released = true;
      exposure?.dispose();
      // Only a newly created RTT is ours. A PassNode converts to a borrowed PassTextureNode;
      // supplied TextureNodes/RTTs belong to the caller even when their resources are shared.
      if (colour !== base && Reflect.get(colour, "isRTTNode") === true) {
        const owned = colour as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        };
        owned.renderTarget.dispose();
        owned._quadMesh.material.dispose();
      }
      scenePass.dispose();
    };
    const giDenoise = (node: ChainNode): ChainNode =>
      options.denoiseEnabled ? denoised(denoise(node, depth(), normal(), view)) : node;

    let releaseBloom = (): void => {};
    const stages: ChainStage[] = [
      stage({
        name: "ssgi",
        build: (input) => {
          const gi = ssgi(input, depth(), normal(), view);
          const tier = SSGI_QUALITY[options.ssgiQuality];
          gi.sliceCount.value = tier.sliceCount;
          gi.stepCount.value = tier.stepCount;
          gi.radius.value = options.ssgiRadius;
          // Gather at a fraction of the frame. See `ssgiResolutionScale` above for why this is a
          // wrapper rather than a property: the node has no scale of its own, and `setSize` is the
          // public seam the pass drives it through. `setSize` is present on the node and absent
          // from its type declarations, so the seam is named here rather than cast away at the call
          // site — if a future three release declares it, or gives the node a `resolutionScale`,
          // this narrows to nothing and the wrapper can go. Guarded at one texel so a zero or a
          // negative cannot ask for an empty target: a 0x0 gather returns black and reads as SSGI
          // simply not working.
          const ssgiScale = options.ssgiResolutionScale;
          const sizedGi = gi as unknown as {
            setSize?: (width: number, height: number) => void;
          };
          const fullGiSize = sizedGi.setSize?.bind(gi);
          if (ssgiScale > 0 && ssgiScale < 1 && fullGiSize !== undefined) {
            sizedGi.setSize = (width: number, height: number): void => {
              fullGiSize(
                Math.max(1, Math.round(width * ssgiScale)),
                Math.max(1, Math.round(height * ssgiScale)),
              );
            };
          }

          // SSGI writes two targets: AO in a single-channel `RedFormat` texture, and the GI
          // term in an RGB one. Multiplying the beauty pass by the whole AO vec4 therefore
          // zeroes green and blue and the entire scene renders monochrome red — take `.r`
          // for the scalar and `.rgb` for the colour.
          //
          // No albedo buffer here, so the beauty pass stands in for it: occlusion darkens
          // what is already lit, and the gathered indirect light is tinted by the surface it
          // lands on. That is the standard approximation, and it is why a red wall tints a
          // white floor at all. `ssgiIntensity` is the game's dial on that second term —
          // gathered light is unbounded, and a small white room at 1.0 blows out.
          const occlusion = giDenoise(gi.getAONode());
          const indirect = giDenoise(gi.getGINode());
          return input.mul(occlusion.r).add(input.mul(indirect.rgb).mul(options.ssgiIntensity));
        },
      }),
      stage({
        name: "ambientOcclusion",
        build: (input) => {
          const contact = ao(depth(), normal(), view);
          contact.radius.value = options.gtaoRadius;
          contact.scale.value = options.gtaoScale;
          contact.samples.value = options.gtaoSamples;
          contact.resolutionScale = options.gtaoResolutionScale;
          // `RedFormat`, like SSGI's AO target: `.r` is the whole occlusion term, and
          // multiplying by the vec4 would zero green and blue and render the scene red.
          // Applied before SSGI by the chain's canonical order; composing it after the GI
          // combine instead darkens crevices the gather re-lit — that is a look choice, and
          // this file is where you make it.
          //
          // Denoised with the same depth-aware filter as the GI gather: GTAO's interleaved
          // sampling otherwise reads as a speckled halo around every contact — around feet on a
          // plain floor most of all — which is exactly the "not smooth" a player notices first.
          const occlusion = options.denoiseEnabled
            ? denoised(denoise(contact.getTextureNode(), depth(), normal(), view))
            : contact;
          return input.mul(occlusion.r);
        },
      }),
      stage({
        name: "godRays",
        available: () => {
          // Godrays are raymarched against the light's shadow map: the shaft is the volume
          // the shadow map reports as lit. A light that casts no shadow yields a black pass,
          // which would read as "godrays are on and do nothing" — so refuse it by name.
          const light = target.godraysLight;
          if (light === undefined) return "godraysEnabled is true but no godraysLight was passed";
          if (light.castShadow !== true)
            return `light '${light.name || "sun"}' does not cast shadows`;
          // `castShadow` is a request, not a result: three allocates the shadow map on the first
          // render that needs it, and `GodraysNode` reads `shadow.map.depthTexture` while the
          // graph is built. Without this check that read throws inside TSL, the chain build
          // fails, and *every* stage is lost — the frame comes back ungraded with no SSGI, no
          // SSR and no tonemap, which looks like a scene problem rather than a missing map.
          // Refusing by name keeps the rest of the chain, which is this stage list's contract.
          if (light.shadow?.map == null)
            return `light '${light.name || "sun"}' has no shadow map yet: set renderer.shadowMap.enabled on the raw renderer (ctx.renderer.raw), and build the chain after the first frame has rendered`;
          return true;
        },
        build: (input) => {
          const light = target.godraysLight as DirectionalLight;
          const shafts = godrays(depth(), view, light);
          shafts.density.value = options.godraysDensity;
          shafts.maxDensity.value = options.godraysMaxDensity;
          shafts.raymarchSteps.value = options.godraysSteps;
          // The pass jitters its samples with interleaved noise; at low step counts the
          // noise renders as a regular lattice over every hazy pixel. The bilateral
          // denoiser built for the GI gather smooths exactly that — high-frequency,
          // depth-coherent — and the shaft edges survive because they sit on geometry
          // silhouettes the depth term owns. Denoise before the floor: the floor's
          // subtraction amplifies relative noise on near-floor values.
          let shaft: ChainNode = convertToTexture(shafts);
          if (options.denoiseEnabled) shaft = denoised(denoise(shaft, depth(), normal(), view));
          // Floor, then scale, then tint. The floor is what turns this from a whole-frame
          // brightener into a shaft renderer; the tint by the light's own colour is what
          // stops a warm sun throwing a white beam.
          const cleaned = shaft.rgb.sub(options.godraysFloor).max(0).mul(options.godraysIntensity);
          return input.add(cleaned.mul(color(light.color)));
        },
      }),
      stage({
        name: "ssr",
        build: (input) => {
          // Three defaults that together make SSR silently do nothing on a real scene, all
          // fixed here and each worth stating:
          //   maxDistance    defaults to 1 world unit — a ray that dies after a metre
          //   reflectNonMetals  defaults to false, so a polished *stone* floor never reflects
          //   roughnessNode  null means every surface is treated as a perfect mirror
          // `normal`, not `normal.xyz`. SSR calls `.sample()` on this node, so it needs the
          // whole TextureNode; a swizzle produces a plain vec3 and the pass dies at shader
          // build. `@types/three` declares the parameter as `Node<"vec3">`, which is what
          // makes the swizzle look correct — the types are wrong here and the runtime is
          // right. Both `colorNode` and `normalNode` are `.sample()`d inside the pass, so
          // the composed input must be materialised ONCE and that texture reused on both
          // sides of the add: passing the unmaterialised node to the pass while adding the
          // reflections onto a second copy builds two parallel graphs, and the frame comes
          // out as the bare background colour.
          const base = convertToTexture(input);
          const reflections = ssr(base, depth(), normal() as unknown as Parameters<typeof ssr>[2], {
            camera: view,
            metalnessNode: metal().r,
            roughnessNode: rough().g,
            reflectNonMetals: true,
          });
          reflections.maxDistance.value = options.ssrMaxDistance;
          reflections.resolutionScale = options.ssrResolutionScale;
          return base.add(reflections);
        },
      }),
      stage({
        name: "sharpen",
        build: (input) => {
          // Last of the image stages but one, because RCAS is defined on the finished
          // picture: it looks at the contrast around a pixel and sharpens in proportion to
          // it, so running it before bloom would sharpen edges that bloom then spreads
          // back out. The third argument keeps the node from materialising its own render
          // target; the chain's graph is fused instead.
          return sharpen(convertToTexture(input), options.sharpenStrength, false);
        },
      }),
      stage({
        name: "bloom",
        dispose: () => {
          releaseBloom();
          releaseBloom = () => {};
        },
        build: (input) => {
          const texture = convertToTexture(input);
          const effect = bloom(
            texture,
            options.bloomStrength,
            options.bloomRadius,
            options.bloomThreshold,
          );
          releaseBloom = () => {
            effect.dispose();
            // convertToTexture may return its input. Only the newly allocated RTT is ours.
            const scratch = texture as unknown as {
              isRTTNode?: boolean;
              renderTarget: { dispose(): void };
              _quadMesh: { material: { dispose(): void } };
            };
            if (texture !== input && scratch.isRTTNode === true) {
              scratch.renderTarget.dispose();
              scratch._quadMesh.material.dispose();
            }
          };
          return input.add(effect);
        },
      }),
      stage({
        name: "vignette",
        build: (input) => {
          // Radius measured from the centre in screen-diagonal units, so the corner is 1
          // and the falloff does not change shape when the window does. It starts at 0.55 —
          // well outside the subject in a 16:9 frame — so the vignette is a corner, not a
          // spotlight.
          const radius = screenUV.sub(vec2(0.5, 0.5)).mul(vec2(1.78, 1)).length().mul(1.04);
          const fall = smoothstep(float(0.55), float(1.02), radius).mul(options.vignetteAmount);
          return input.mul(fall.oneMinus());
        },
      }),
      {
        // Last, after every built-in: antialiasing is defined on the finished picture, and any
        // stage after it would put the stairsteps back.
        name: "antialias",
        after: "gradualBackground",
        build: (input) => {
          const colour = input as ChainNode;
          // SMAA and FXAA find edges by local contrast and expect display-range colour, but this is
          // the linear HDR frame before the tone curve — a sun-lit edge at 20 against sky at 3
          // would blend into a bright halo. The reversible Karis weighting squeezes it into [0, 1)
          // for the filter and expands it back afterwards, so edges resolve without the halo.
          const peak = max(colour.r, max(colour.g, colour.b));
          const squeezed = colour.div(peak.add(1));
          const filtered = (options.screenSpaceAA === "fxaa"
            ? fxaa(squeezed)
            : smaa(squeezed)) as unknown as ChainNode;
          const back = max(filtered.r, max(filtered.g, filtered.b));
          return filtered.div(float(1).sub(back).max(1e-4));
        },
      },
    ];

    // The kit's own stages, composed after the built-ins. The factory is called with the two
    // things only this file can produce — the scene pass's depth texture and the resolved tier —
    // and returns the complete authored graph plus the subset to run.
    stages.push(
      ...options.authoredStages({
        depthNode: depth(),
        tier: options.renderChainTier,
        camera,
      }),
    );

    // A composed base colour with every stage off still has to reach the frame. The chain
    // installs nothing for an empty stage list, so this is the one path that goes direct.
    if (requested.length === 0) {
      if (renderer.setOutputNode === undefined || renderer.clearOutputNode === undefined) {
        releaseGraph();
        throw new Error("Output node installation and ownership-aware disposal are required.");
      }
      let installation: OutputInstallation | undefined;
      try {
        const returned = renderer.setOutputNode(exposed, scenePass);
        installation =
          returned &&
          typeof returned.isCurrent === "function" &&
          typeof returned.dispose === "function"
            ? returned
            : undefined;
      } catch (error) {
        releaseGraph();
        throw error;
      }
      this.#reportApplied([], []);
      return {
        exposure,
        dropped: [],
        stages: [],
        dispose: () => {
          if (released) return;
          if (installation) installation.dispose();
          // Legacy adapters returning void retain node-only, not installation-level safety.
          else renderer.clearOutputNode?.(exposed);
          releaseGraph();
        },
      };
    }

    if (renderer.createRenderChain === undefined) throw new Error("RenderChain is unavailable.");
    // One stage owns the measurement, so the chain is asked for the one that published a callback
    // rather than every stage in turn. A stage that dropped keeps answering `undefined`.
    const rejectionMeasurement = stages.find(
      (entry) => entry.rejectionMeasurement !== undefined,
    )?.rejectionMeasurement;
    const chain = renderer.createRenderChain({
      input: exposed,
      request: {
        stages: requested,
        tier: options.renderChainTier,
        // Asked for on every chain and paid for only when a temporal stage is named: the chain
        // provisions nothing while no requested stage needs velocity.
        velocity: {
          pass: scenePass,
          ...(rejectionMeasurement === undefined ? {} : { rejectionMeasurement }),
        },
      },
      stages,
      worldPass: scenePass,
    });
    this.#reportApplied(chain.applied.stages, chain.applied.dropped);
    return {
      exposure,
      dropped: chain.applied.dropped,
      stages: chain.applied.stages,
      dispose: () => {
        if (released) return;
        chain.dispose();
        releaseGraph();
      },
    };
  }

  /**
   * Prints `TN_WORLD_ENVIRONMENT`: every stage this class can run, named as applied or refused
   * **with a reason that is never blank**, plus the tone curve and exposure that framed them.
   *
   * The chain prints its own line for the stages it installed, and it prints nothing at all when
   * nothing was requested — which is exactly the case where a reader most needs to know that GI
   * is off because this file says so rather than because a node silently no-op'd. This line is
   * emitted every run, including the run where every stage is off.
   */
  #reportApplied(
    applied: readonly string[],
    dropped: readonly { name: string; reason: string }[],
  ): void {
    const options = this.#options;
    const off: Record<string, string> = {
      ambientOcclusion: "gtaoEnabled is false",
      antialias: 'screenSpaceAA is "disabled", or no other stage installed a chain',
      bloom: "bloomEnabled is false",
      godRays: "godraysEnabled is false",
      sharpen: "sharpenEnabled is false",
      ssgi: "ssgiEnabled is false",
      ssr: "ssrEnabled is false",
      vignette: "vignetteAmount is 0",
      kuwahara: "kuwaharaEnabled is false",
      outline: "outlineEnabled is false",
      watercolor: "watercolorEnabled is false",
    };
    const stages = Object.keys(off)
      .sort()
      .map((name) => {
        if (applied.includes(name)) return { applied: true, name };
        const refused = dropped.find((entry) => entry.name === name);
        return { applied: false, name, reason: refused?.reason ?? off[name] };
      });
    console.info(
      `TN_WORLD_ENVIRONMENT:${JSON.stringify({
        denoise: options.denoiseEnabled,
        exposure: options.exposure,
        marker: "TN_WORLD_ENVIRONMENT",
        screenSpaceAA: options.screenSpaceAA,
        ssgiQuality: options.ssgiQuality,
        stages,
        tonemapMode: options.tonemapMode,
      })}`,
    );
  }
}

function isChainTier(value: unknown): value is ChainTier {
  return value === "high" || value === "medium" || value === "low" || value === "off";
}
