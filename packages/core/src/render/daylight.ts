import {
  AgXToneMapping,
  type Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  type Object3D,
  type Scene,
  type ToneMapping,
  type Vector3,
} from "three";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import type { IComputeDriven } from "../compute-driven.js";
import type { IRendererLike } from "../renderer.js";
import { VirtualShadowNode } from "./virtual-shadow.js";

/** Every value is the game's: this rig wires them and chooses none. */
export interface IDaylightOptions {
  /** The eye the sky, the sun's shadow windows and the haze centre on; usually the camera. */
  readonly follow: Object3D;
  /** Unit vector from the ground towards the sun. */
  readonly sunDirection: Vector3;
  readonly sunColor: Color;
  /** Irradiance in three's physical units; the same number a Blender sun strength carries. */
  readonly sunIntensity: number;
  /** Half-widths of the shadow windows in world units, finest first, strictly increasing. */
  readonly shadowExtents: readonly number[];
  /** Texels per shadow level edge; a level's texel is `2 * extent / shadowMapSize`. Default: the sun's `shadow.mapSize.width` (512). */
  readonly shadowMapSize?: number;
  /**
   * How far a window may trail the camera before it re-renders, as a fraction of its own extent:
   * one value for every level, or one per level finest first, the last entry standing in for the
   * rest. One for all of them spends the hysteresis the fine level can least afford on the coarse
   * one, which is the level a walking camera re-renders least. Default 0.125.
   */
  readonly refreshStep?: number | readonly number[];
  /** Preetham sky parameters, as three's `SkyMesh` takes them. */
  readonly sky: {
    readonly turbidity: number;
    readonly rayleigh: number;
    readonly mieCoefficient: number;
    readonly mieDirectionalG: number;
  };
  /** Sky fill from above and bounce from below, as a hemisphere light. */
  readonly fill: { readonly sky: Color; readonly ground: Color; readonly intensity: number };
  /** Exponential-squared haze in the sky's horizon colour, so distance fades into the sky. */
  readonly haze: { readonly color: Color; readonly density: number };
  /** Linear exposure multiplier for the tone curve (2^EV). */
  readonly exposure: number;
  /** The tone curve, a look the game picks; AgX when it names none. */
  readonly toneMapping?: ToneMapping;
  /**
   * Edge of the sky box in world units. It must sit inside the camera's far plane with its corners
   * included (a box, so half-diagonal ≈ 0.87 × this).
   */
  readonly skySize: number;
}

/**
 * An outdoor daylight rig: a physical sky that stays on the eye, one sun whose open-world shadow
 * windows follow the eye (`VirtualShadowNode`), a hemisphere fill, sky-coloured distance haze and
 * the AgX tone curve at the game's exposure. It is plumbing, not a look: every colour, angle,
 * intensity and density is a required option, and the rig adds nothing a game did not ask for.
 *
 * Add it with `ctx.add(daylight)`: `attachRenderer` sets tone mapping, exposure and the shadow map
 * once, and `process` (render cadence) keeps the sky box, the sun and its target on the eye every
 * frame, so a 2 km map never walks out of its own sky or shadow.
 *
 * @situation daytime sky, sun and shadows for a large outdoor map
 * @situation distant terrain should fade into the sky instead of a coloured wall
 * @situation match a Blender look-dev scene's sun, sky and exposure in the game
 * @constraint every value is required; there is no default sun, sky, haze or exposure
 * @constraint `skySize` must keep the sky box's corners inside the camera's far plane
 * @constraint shadowExtents follow `VirtualShadowNode`: half-widths, finest first, strictly increasing
 * @override sky uniforms stay live on `daylight.sky`; the light and fill are `daylight.sun` and `daylight.fill`
 * @example
 * const daylight = new Daylight({ follow: ctx.camera, sunDirection, sunColor, sunIntensity: 4, shadowExtents: [24, 96, 320], sky: { turbidity: 3, rayleigh: 1.4, mieCoefficient: 0.004, mieDirectionalG: 0.8 }, fill: { sky, ground, intensity: 1.1 }, haze: { color: horizon, density: 0.0011 }, exposure: 2 ** -0.6, skySize: 1600 });
 * ctx.add(daylight);
 */
export class Daylight extends Group implements IComputeDriven {
  readonly warmupNodes: readonly unknown[] = [];
  readonly processCadence = "render" as const;
  readonly sky: SkyMesh;
  readonly sun: DirectionalLight;
  readonly fill: HemisphereLight;
  readonly #follow: Object3D;
  readonly #sunDirection: Vector3;
  readonly #haze: FogExp2;
  readonly #exposure: number;
  readonly #toneMapping: ToneMapping;
  #released = false;

  constructor(options: IDaylightOptions) {
    super();
    this.name = "daylight";
    if (!(options.exposure > 0)) throw new Error("Daylight exposure must be positive.");
    if (!(options.skySize > 0)) throw new Error("Daylight skySize must be positive.");
    this.#follow = options.follow;
    this.#sunDirection = options.sunDirection.clone().normalize();
    this.#exposure = options.exposure;
    this.#toneMapping = options.toneMapping ?? AgXToneMapping;

    this.sky = new SkyMesh();
    this.sky.name = "daylight-sky";
    this.sky.scale.setScalar(options.skySize);
    this.sky.frustumCulled = false;
    this.sky.turbidity.value = options.sky.turbidity;
    this.sky.rayleigh.value = options.sky.rayleigh;
    this.sky.mieCoefficient.value = options.sky.mieCoefficient;
    this.sky.mieDirectionalG.value = options.sky.mieDirectionalG;
    // The haze is for the world in front of the sky, not for the sky: the dome is half a sky size
    // from the eye, fully fogged at any useful density, and a fogged dome is a flat grey sky.
    this.sky.material.fog = false;
    this.sky.sunPosition.value.copy(this.#sunDirection);
    // Where the frame budget counts this mesh's main-pass draw (`RenderPassBudget`). One draw, on
    // the main camera's own layer, and no world system owns it — so without the origin it is a line
    // in the `other` bucket that reads as a prop rather than as the sky.
    this.sky.userData.tnDrawSource = "sky";
    this.add(this.sky);

    this.fill = new HemisphereLight(options.fill.sky, options.fill.ground, options.fill.intensity);
    this.add(this.fill);

    this.sun = new DirectionalLight(options.sunColor, options.sunIntensity);
    this.sun.name = "daylight-sun";
    this.sun.castShadow = true;
    this.sun.shadow.shadowNode = new VirtualShadowNode(this.sun, {
      clipExtents: [...options.shadowExtents],
      // A game that wants the fine level on a different cadence than the coarse two says so here,
      // per level, instead of taking one step for all of them.
      ...(options.refreshStep === undefined ? {} : { refreshStep: options.refreshStep }),
      ...(options.shadowMapSize === undefined ? {} : { mapSize: options.shadowMapSize }),
    });
    this.add(this.sun);
    this.add(this.sun.target);

    this.#haze = new FogExp2(options.haze.color, options.haze.density);
    this.#place();
  }

  get released(): boolean {
    return this.#released;
  }

  /** The haze this rig owns; `attachRenderer` puts it on the scene the rig was added to. */
  get haze(): FogExp2 {
    return this.#haze;
  }

  attachRenderer(renderer: IRendererLike): void {
    const raw = renderer.raw as {
      toneMapping?: number;
      toneMappingExposure?: number;
      shadowMap?: { enabled: boolean };
    };
    raw.toneMapping = this.#toneMapping;
    raw.toneMappingExposure = this.#exposure;
    if (raw.shadowMap !== undefined) raw.shadowMap.enabled = true;
    const scene = this.#scene();
    if (scene !== undefined) {
      scene.fog = this.#haze;
      scene.background = null;
    }
  }

  process(): void {
    this.#place();
  }

  detach(): void {
    const scene = this.#scene();
    if (scene !== undefined && scene.fog === this.#haze) scene.fog = null;
    this.#released = true;
  }

  /** Sky box, sun and target on the eye; the sun sits along its direction, outside the windows. */
  #place(): void {
    const eye = this.#follow.getWorldPosition(this.sky.position);
    this.sun.target.position.copy(eye);
    this.sun.position.copy(eye).addScaledVector(this.#sunDirection, 400);
  }

  #scene(): Scene | undefined {
    let node: Object3D | null = this.parent;
    while (node !== null && !(node as Scene).isScene) node = node.parent;
    return (node as Scene | null) ?? undefined;
  }
}
