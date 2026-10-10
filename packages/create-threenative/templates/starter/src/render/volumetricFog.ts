// Generated for you: opt-in Three.js, with no default tier or picture change.
// Compose this medium before exposure/bloom/output. It takes the scene's own fog over while it
// lives and restores it on disposal; aerial haze and god rays must stay off, and a separate
// clear-air sky remains valid. Density/phase/colour belong to this game — see `STARTER_MIST`
// below for the starter's own, which is the object to edit when the mist should be on.
// Pinned Three 0.185.1 VolumeNodeMaterial skips directional lights and couples extinction to
// illumination. This bounded integrator reuses GodraysNode's depth/shadow coordinates instead.
// `volumetricFogOptions.ts` is the contract it accepts, `volumetricFogVolume.ts` the graph it
// builds and owns, and `volumetricFogTransport.ts` the per-step integration inside it.
import { Box3, Color, type PerspectiveCamera, type Scene, Vector3 } from "three";
import type { Node, NodeMaterial, RenderTarget } from "three/webgpu";
import type { IFogVolume, IVolumetricFogOptions } from "./volumetricFogOptions.js";
import { validateFogOptions } from "./volumetricFogOptions.js";
import type { ScenePass } from "./volumetricFogTransport.js";
import { type IFogVolumeGraph, composeFogVolume } from "./volumetricFogVolume.js";

export type { IFogVolume, IVolumetricFogOptions };

/** The owned medium a composed graph exposes: one controller, one graph, one owned target. */
export type FogMedium = Exclude<ReturnType<typeof createVolumetricFog>, undefined>;

/**
 * This game's mist — the one flag, density, colour, bounds and step count, all in this folder
 * because they are look decisions. `Play.ts` passes this object and the live renderer's `kind` to
 * `createVolumetricFog`; the backend is deliberately not in here, so no scene can claim a backend
 * the renderer does not have.
 *
 * `enabled: false` costs nothing: the medium returns before this module allocates a target, a
 * material or a graph, so the shipped picture and the off baseline are exactly what they were
 * without it. Set it true and the mist is bounded by `volumes`, thins with height and is lit by
 * `ambient` alone.
 *
 * There is no automatic sun. Pass `sun: key` from `lighting.ts` once `key.shadow.map` exists — the
 * graph is built before the first render, so the first medium has no shadow map to sample and none
 * is invented; a tier change rebuilds it and picks one up. Up to four unshadowed finite-range
 * `PointLight`s need no preparation at all.
 */
export const STARTER_MIST: Omit<IVolumetricFogOptions, "renderer"> = {
  enabled: false,
  steps: 32,
  resolutionScale: 0.5,
  // A slab over the arena floor: thickest at the boards, thinning with height.
  volumes: [
    {
      bounds: new Box3(new Vector3(-9, 0, -6), new Vector3(9, 3, 6)),
      density: 0.06,
      baseHeight: 0,
      heightFalloff: 0.5,
    },
  ],
  albedo: new Color("#cfd8e3"),
  ambient: new Color("#0b1016"),
  anisotropy: 0.3,
  environment: { aerialPerspective: false, godRays: false },
};

/**
 * Off, unsupported and zero-density return before allocating any graph/target/material.
 *
 * While a medium lives it owns the scene's fog: `sky.ts` renders the same air through
 * `scene.fog` and `scene.fogNode`, so two of them would double it. Disposal puts the authored fog back, unless
 * the game authored a new one while the medium lived — that later fog is then the live one.
 */
export function createVolumetricFog(
  scene: Scene,
  camera: PerspectiveCamera,
  supplied: IVolumetricFogOptions,
) {
  if (!supplied.enabled || supplied.renderer !== "webgpu") return undefined;
  const options = { ...supplied };
  validateFogOptions(camera, options);
  const volumes = options.volumes.filter((volume) => volume.density > 0);
  if (volumes.length === 0) return undefined;
  const authoredFog = scene.fog;
  const authoredFogNode = scene.fogNode;
  scene.fog = null;
  scene.fogNode = null;
  let graph: IFogVolumeGraph | undefined;
  let disposed = false;
  return {
    get target(): RenderTarget | undefined {
      return graph?.target;
    },
    get material(): NodeMaterial | undefined {
      return graph?.material;
    },
    get transport(): Node<"vec4"> | undefined {
      return graph?.transport;
    },
    diagnostics: () => ({
      steps: options.steps,
      resolutionScale: options.resolutionScale,
      volumes: volumes.length,
      localLights: (options.points ?? []).length,
      history: false,
      renderTargets: graph === undefined ? 0 : 1,
      pixels: graph === undefined ? 0 : graph.target.width * graph.target.height,
    }),
    compose(scenePass: ScenePass): Node<"vec4"> {
      if (disposed) throw new Error("volumetricFog: disposed controller.");
      if (graph !== undefined) throw new Error("volumetricFog: compose once per owned graph.");
      if (scenePass.camera !== camera)
        throw new Error("volumetricFog: scene depth must come from this camera.");
      if (
        Reflect.get(scenePass.scene, "fog") != null ||
        Reflect.get(scenePass.scene, "fogNode") != null
      )
        throw new Error("volumetricFog: scene fog duplicates the same medium.");
      graph = composeFogVolume(camera, options, volumes, scenePass);
      return graph.compose;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      graph?.target.dispose();
      graph?.material.dispose();
      graph = undefined;
      if (scene.fog == null && scene.fogNode == null) {
        scene.fog = authoredFog;
        scene.fogNode = authoredFogNode;
      }
    },
  };
}
