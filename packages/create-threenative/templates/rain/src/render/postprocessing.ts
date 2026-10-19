// Generated for you: ordinary Three.js; ThreeNative does not read this file.
//
// This is the storm's filmic half — the demo's own `BLOOM` and `POST` passes, ported rather than
// approximated. `bloom-shader.ts` and `post-shader.ts` hold the maths, transpiled from
// `tools/tempest-bloom.frag` and `tools/tempest-post.frag`; this file owns only where those two
// runs and what feeds them.
//
// Every engine stage that would double a job the demo's own pass already does exactly is off:
// `quality.ts` decides those, and the built-in bloom is a mip pyramid rather than the demo's 5x5
// quarter-resolution threshold kernel. The engine's tone curve and sRGB encode are applied by the
// render pipeline *after* the graph, so the demo's ACES fit, its grade and its `pow(1/2.2)` would
// otherwise be applied twice — hence `NoToneMapping` and the working colour space below, which is
// what the source's own Three.js driver sets for the same reason.
//
// To change how the storm looks, edit the two `.frag` sources and run the generator. To change how
// much of it there is, edit `quality.ts`.
import {
  type Camera,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
} from "three";
import { convertToTexture, positionGeometry, uv, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial, PassNode } from "three/webgpu";
import { setScene as setBloomScene, tempestBloom, uRes as uBloomRes } from "./bloom-shader.js";
import {
  setBloom,
  setScene,
  tempestPost,
  uExposure,
  uLens,
  uRain,
  uRes,
  uTime,
} from "./post-shader.js";
import { type QualityTier, qualityPreset, resolveQualityTier } from "./quality.js";
import type { ChainStage, OutputRenderer } from "./worldEnvironment.js";
import { WorldEnvironment } from "./worldEnvironment.js";

/**
 * The bloom target's resolution, as a fraction of the frame: the demo's own
 * `round(width / 4)`, and the reason that pass is five taps rather than a mip pyramid.
 */
const BLOOM_SCALE = 0.25;

/** What one frame's post pass needs from the game. Every value is the demo's, unconverted. */
export interface IStormPostFrame {
  /** Seconds since the storm began: the bead drift and the dither's frame index. */
  readonly elapsed: number;
  /** Weather exposure, 0…n. The demo applies it after the bloom add, and so does this. */
  readonly exposure: number;
  /** Weather rain, 0…1. Bead refraction and highlight scale with it. */
  readonly rain: number;
  /** The demo's `lens` toggle: the refractive beads on or off. */
  readonly droplets: boolean;
}

/**
 * The two numbers `uRes` needs, as the renderer reports them. Read through the renderer's own
 * `surface()` rather than the canvas, so a resolution scale or a device pixel ratio is already
 * accounted for. Required rather than probed: `ctx.renderer` declares it, so a renderer without it
 * is a type error here instead of a frame that is wrong.
 */
interface IRendererSurface {
  surface(): { readonly drawingBufferWidth: number; readonly drawingBufferHeight: number };
}

/** What a scene keeps. `update` is per frame; `dispose` releases everything built here. */
export interface IStormPost {
  /** The engine chain's own report: every stage as applied or refused, with a reason. */
  readonly applied: {
    readonly dropped: readonly { name: string; reason: string }[];
    readonly stages: readonly string[];
    dispose?: () => void;
  };
  update(frame: IStormPostFrame): void;
  dispose(): void;
}

/**
 * Installs the storm's post chain and returns its handle.
 *
 * `renderer`, `scene` and `camera` are the three the scene passes to everything else in
 * `src/render/`. Nothing here reads the DOM, runs a second render loop, or owns a render target:
 * the engine's render chain owns the pipeline and the scene pass, and the bloom threshold pass is
 * a `PassNode` over a private one-quad scene, so its quarter-resolution target is sized and
 * updated by the renderer that draws the frame.
 */
export function setupPost(
  renderer: OutputRenderer & IRendererSurface,
  scene: Scene,
  camera: Camera,
  environment: {
    /** The renderer named a software adapter; this game's answer is its `low` tier. */
    software?: boolean;
    /** The renderer's GPU family (`ctx.renderer.gpuClass?.class`); `quality.ts` maps it to a start tier. */
    gpuClass?: string;
    /** Forces a tier, ignoring `mobile`. An unknown name throws rather than falling back. */
    tier?: QualityTier;
    mobile?: boolean;
  } = {},
): IStormPost {
  const tier = resolveQualityTier({
    mobile: environment.mobile,
    gpuClass: environment.gpuClass,
    software: environment.software,
    tier: environment.tier,
  });
  const source = environment.tier === undefined ? "platform" : "override";
  console.info(
    `TN_QUALITY_TIER ${tier} mobile=${environment.mobile === true} software=${
      environment.software === true
    } source=${source}`,
  );

  // The private bloom scene: one screen quad and a camera whose projection nothing reads, which is
  // what the demo's full-screen triangle was. The frame's own scene is never added here — the
  // final image is an output node, not a quad in the root scene, so nothing captures itself.
  const bloomScene = new Scene();
  const bloomCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bloomGeometry = new PlaneGeometry(2, 2);
  const bloomMaterial = new MeshBasicNodeMaterial();
  bloomMaterial.side = DoubleSide;
  bloomMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
  const bloomQuad = new Mesh(bloomGeometry, bloomMaterial);
  bloomQuad.frustumCulled = false;
  bloomScene.add(bloomQuad);
  const bloomPass = new PassNode(PassNode.COLOR, bloomScene, bloomCamera);
  bloomPass.setResolutionScale(BLOOM_SCALE);

  let applied: IStormPost["applied"] = { dropped: [], stages: [] };
  let disposed = false;
  const world = new WorldEnvironment({
    ...qualityPreset(tier),
    authoredStageNames: ["stormPost"],
    authoredStages: () => [stormStage()],
  });
  applied = world.apply(renderer, scene, camera);
  if (!applied.stages.includes("stormPost")) {
    throw new Error(
      `setupPost: the engine chain did not run stormPost (${applied.dropped
        .map((entry) => `${entry.name}: ${entry.reason}`)
        .join("; ")}). The storm's look would silently be the engine's default.`,
    );
  }

  // The demo grades and gamma-encodes inside `POST`. The pipeline would tone map and encode again,
  // so both are switched off here — the source's own driver does the same two lines.
  const raw = renderer.raw as { toneMapping: number; outputColorSpace: string } | undefined;
  if (raw === undefined)
    throw new Error("setupPost: the renderer has no raw renderer to un-tone-map.");
  raw.toneMapping = NoToneMapping;
  raw.outputColorSpace = LinearSRGBColorSpace;

  return {
    get applied(): IStormPost["applied"] {
      return applied;
    },
    update({ elapsed, exposure, rain, droplets }): void {
      if (disposed) throw new Error("setupPost: update() called after dispose().");
      // The scene pass's own texture size, read from the renderer: the kernel's offsets and the
      // lens aspect are texel quantities, so a number that is not the input target's is a wrong
      // picture rather than a slower one. The requested CSS size is not that number.
      const { drawingBufferWidth: width, drawingBufferHeight: height } = renderer.surface();
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        (width as number) < 1 ||
        (height as number) < 1
      ) {
        throw new Error(
          `setupPost: the frame is ${String(width)}x${String(height)}; the post pass needs the input target's real size.`,
        );
      }
      if (![elapsed, exposure, rain].every((value) => Number.isFinite(value))) {
        throw new Error("setupPost: elapsed, exposure and rain must all be finite numbers.");
      }
      uRes.value.set(width, height);
      // The bright pass reads the full-resolution scene at two of its texels per tap, as the study
      // did, so it needs the same size; left at zero its kernel divides by zero.
      uBloomRes.value.set(width, height);
      uTime.value = elapsed;
      uExposure.value = exposure;
      uRain.value = rain;
      uLens.value = droplets ? 1 : 0;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      applied.dispose?.();
      bloomPass.dispose();
      bloomGeometry.dispose();
      bloomMaterial.dispose();
    },
  };

  /**
   * The one authored stage: the demo's bloom and `POST`, in that order, as the last thing in the
   * chain. It reads the chain's input — the scene pass's colour, coast, cloud, rain and lightning
   * already composited — and returns the finished frame.
   */
  function stormStage(): ChainStage {
    return {
      name: "stormPost",
      // Anchored after the last built-in stage: this is the frame the player sees, so nothing may
      // run after it. `before`/`after` is how the chain orders an authored stage at all.
      after: "gradualBackground",
      build: (input: unknown) => {
        // The chain carries its own colour as `unknown`; this is the one place that becomes a node.
        const colour = input as Parameters<typeof convertToTexture>[0];
        // Materialised as a node in this graph, never copied out: a copied texture has no updater
        // behind it and freezes on its first frame. The same node feeds the threshold pass and the
        // final pass, so the bloom is computed from exactly the image the output grades.
        const sceneTexture = convertToTexture(colour);
        // Read inside each generated `Fn` body, so both samplers are bound before the fragment
        // nodes are called — that call is the moment the graph is built.
        setBloomScene(sceneTexture);
        setScene(sceneTexture);
        setBloom(bloomPass.getTextureNode());
        bloomMaterial.fragmentNode = tempestBloom(uv());
        return tempestPost(uv());
      },
    };
  }
}
