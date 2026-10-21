import { Box3, type Camera, type Mesh, type Object3D, Quaternion, Vector3 } from "three";
import {
  cameraFar,
  cameraNear,
  clamp,
  float,
  linearDepth,
  reflector,
  screenUV,
  select,
  vec2,
  viewportDepthTexture,
  viewportLinearDepth,
  viewportSharedTexture,
} from "three/tsl";
import type { Node } from "three/webgpu";

/** What the mirrored pass costs: how big it is, how many of them, and how much of the world. */
export interface IWaterReflectionOptions {
  /**
   * The mirrored pass's render target, as a fraction of the drawing buffer.
   *
   * How many *pixels* the second pass costs. Half is the usual answer. This is not on its own the
   * number that decides whether a surface is affordable, and a game that reads it that way will
   * measure no improvement and conclude its water is free: a scene with many objects is bound by
   * the draw calls the mirrored pass submits, not by its pixels, and those do not shrink with the
   * target. Measured on `sandbox/midway-open-pacific` at 1920x1080 on an nvidia/turing adapter with
   * 1,965 draws in the frame, halving this again — 0.5 to 0.25 — moved GPU p95 from 17.80 ms to
   * 17.58 ms. Removing the pass entirely moved it to 7.67 ms. `layers` is the number that mattered.
   */
  readonly resolutionScale: number;
  /** Whether this surface may appear in other reflectors' passes. Off is one pass; on is n². */
  readonly bounces?: boolean;
  /**
   * Explicit Three Layers mask. Wins over automatic selection, including `1` (all layer-0 props).
   * Omit to reflect terrain-sized surfaces and large non-instanced shadow casters. Instanced and
   * skinned props are excluded automatically; sky/background and lighting remain available.
   */
  readonly layers?: number;
  /** Minimum world-space extent for automatic terrain/casters, in metres. Default 10. */
  readonly minSize?: number;
  /**
   * How often the mirrored pass redraws, in presented frames.
   *
   * The reflection is a second render of the world and on a crowded sea it is the largest single
   * item in the frame. It is also low-frequency: a swell, a hull and a wake read the same whether
   * the mirror was taken this frame or two frames ago, and at speed the eye cannot hold a reflected
   * silhouette still enough to notice it lag. `2` redraws every second frame and samples the
   * previous frame's target in between, halving the pass's cost; a higher number halves it again.
   *
   * Omit it — or pass `1` — and the pass redraws every frame, which is the shipping behaviour and
   * the default. The trade is temporal: while the camera moves, the reflection is up to
   * `refreshInterval - 1` frames behind the scene it mirrors. Fast camera motion can make a
   * reflected edge shimmer, and a moving object's reflection trails it. A still camera sees none of
   * that, so name it only where the measured pass dominates the frame.
   */
  readonly refreshInterval?: number;
}

export interface IWaterSurfaceOptions {
  /** World-space height of the surface, in metres. The mirror plane, and where thickness is 0. */
  readonly level: number;
  /**
   * Thickness readings saturate here, in metres.
   *
   * A required number because it is the range of the instrument, not a taste: sky behind the
   * surface has no depth at all, and something has to be reported for it.
   */
  readonly maxThickness: number;
  /** Omit for a surface that reflects nothing; `reflectionAt` then throws rather than lying. */
  readonly reflection?: IWaterReflectionOptions;
}

/**
 * The pass three hangs off the node `reflector()` returns. Its virtual cameras are the only place a
 * layer mask can be applied, and `updateBefore` is the whole second render, so those are the two
 * seams this file needs named rather than cast at each use.
 */
interface IReflectorPass {
  getVirtualCamera(camera: Camera): Camera;
  updateBefore(frame: IReflectionFrame): void;
  /** three's NodeUpdateType; `"none"` when the back end draws the pass itself (the native engine). */
  readonly updateBeforeType?: string;
}
interface IReflectionFrame {
  readonly scene: Object3D;
  readonly renderer: unknown;
}
interface IReflectorWithPass {
  _reflectorBaseNode: IReflectorPass;
}

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
/** The one rotation that turns the reflector target's local +Z into world up. */
const FACING_UP = new Quaternion().setFromUnitVectors(FORWARD, UP);

function finite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`WaterSurface3D.${name} must be finite.`);
  return value;
}

/**
 * What a horizontal water surface can see: the world mirrored in it, the world beneath it, and
 * how much water stands between the two.
 *
 * This is the render plumbing a water material needs and cannot write portably — a mirrored
 * camera and its render target, the frame's own colour read back as the light coming up through
 * the surface, and the scene's depth turned into **metres of water under this pixel**. It decides
 * nothing about how any of that looks: no colour, no absorption tint, no fresnel weighting, no
 * glint. Those are the game's, composed from the nodes below in its own `src/render/` material.
 *
 * The depth reading is the part worth having. `linearDepth` answers in a normalised 0..1 that
 * changes meaning with every camera near/far pair, so a material that subtracts two of them gets
 * a number in no unit at all, and its shoreline moves when the camera's far plane does.
 * `thicknessAt` returns metres, and metres survive the camera changing.
 *
 * ```js
 * const surface = new WaterSurface3D({ level: 0, maxThickness: 4, reflection: { resolutionScale: 0.5 } });
 * const offset = normal.xz.mul(0.02);
 * material.colorNode = mix(
 *   surface.refractionAt(offset).mul(siltTint),      // the game's colours,
 *   surface.reflectionAt(offset),                    // composed by the game,
 *   fresnel,                                         // with the game's own fresnel.
 * );
 * material.opacityNode = surface.thicknessAt().div(surface.maxThickness);
 * ```
 */
export class WaterSurface3D {
  readonly maxThickness: number;
  /**
   * The object whose plane is mirrored, kept outside the scene graph on purpose.
   *
   * A water level is a fact about the world, not about the mesh that happens to draw it: parent
   * the mirror to the surface mesh, as three's own examples do, and a non-uniform scale anywhere
   * up that mesh's ancestry skews the plane the reflection is taken about. This one is placed
   * from `level` and nothing else, so it stays level.
   */
  readonly target: Object3D | undefined;
  #level: number;
  #reflector: ReturnType<typeof reflector> | undefined;
  #released = false;

  constructor(options: IWaterSurfaceOptions) {
    if (options === undefined || typeof options !== "object")
      throw new Error("WaterSurface3D requires options.");
    this.#level = finite("level", options.level);
    this.maxThickness = finite("maxThickness", options.maxThickness);
    if (this.maxThickness <= 0) throw new Error("WaterSurface3D.maxThickness must be positive.");
    const reflection = options.reflection;
    if (reflection === undefined) {
      this.reflectionRefreshInterval = 1;
      this.target = undefined;
      return;
    }
    if (reflection === null || typeof reflection !== "object")
      throw new Error("WaterSurface3D.reflection must be an object.");
    const resolutionScale = finite("reflection.resolutionScale", reflection.resolutionScale);
    if (resolutionScale <= 0 || resolutionScale > 1)
      throw new Error("WaterSurface3D.reflection.resolutionScale must be within (0, 1].");
    const refreshInterval = reflection.refreshInterval ?? 1;
    if (!Number.isInteger(refreshInterval) || refreshInterval < 1)
      throw new Error("WaterSurface3D.reflection.refreshInterval must be a positive integer.");
    const node = reflector({
      bounces: reflection.bounces === true,
      generateMipmaps: false,
      resolutionScale,
    });
    this.reflectionLayers = reflection.layers;
    this.reflectionRefreshInterval = refreshInterval;
    // `reflector()` returns the texture node; the pass itself — and the virtual cameras and render
    // it owns — live on the reflector base node hanging off it.
    const pass = (node as unknown as IReflectorWithPass)._reflectorBaseNode; // quality-allow: three 0.185 does not type `_reflectorBaseNode` on the reflector node it returns
    // Three runs this from the draw of the first object that samples the reflection, and without
    // `bounces` the node updates per frame, so an opaque water mesh in a world chunk is bundle-safe
    // and that draw can be part of a `BundleGroup` the main pass is recording. Three keeps that
    // bundle in `_currentRenderBundle` and does not save it across the nested `render()` the mirror
    // is: the mirror's draws would be filed under the main bundle, and the mirror's own bundles
    // leave the field `null`, so the main bundle's remaining draws are recorded but never listed —
    // a replay refreshes only listed draws, so those keep the camera they were recorded with. The
    // mirror renders outside the record, and the record gets its bundle back. A pass three never
    // updates (the native engine draws it and records no JS bundle) has no render to guard.
    if (pass.updateBeforeType !== "none") {
      const mirror = pass.updateBefore.bind(pass);
      pass.updateBefore = (frame: IReflectionFrame): void => {
        const host = frame.renderer as { _currentRenderBundle?: unknown };
        const recording = host._currentRenderBundle;
        if (recording !== undefined) host._currentRenderBundle = null;
        try {
          mirror(frame);
        } finally {
          if (recording !== undefined) host._currentRenderBundle = recording;
        }
      };
    }
    if (reflection.layers !== undefined) {
      const mask = reflection.layers;
      if (!Number.isInteger(mask) || mask < 0)
        throw new Error("WaterSurface3D.reflection.layers must be a non-negative integer mask.");
      // The pass mints one virtual camera per scene camera, lazily, inside three. There is no
      // constructor seam for it and no list to walk afterwards, so the mask is applied where every
      // such camera is born. A camera three has already handed out is caught too, because the same
      // call returns it.
      const mint = pass.getVirtualCamera.bind(pass);
      pass.getVirtualCamera = (camera: Camera): Camera => {
        const virtual = mint(camera);
        virtual.layers.mask = mask;
        return virtual;
      };
    }
    if (reflection.layers === undefined) {
      const minSize = finite("reflection.minSize", reflection.minSize ?? 10);
      if (minSize <= 0) throw new Error("WaterSurface3D.reflection.minSize must be positive.");
      const render = pass.updateBefore.bind(pass);
      const bounds = new Box3();
      const size = new Vector3();
      let reported = false;
      pass.updateBefore = (frame: IReflectionFrame): void => {
        const hidden: { object: Object3D; mask: number }[] = [];
        let included = 0;
        // Layer filtering is pass-local: the main scene and every explicit-layer mirror keep their set.
        // Reject only the mesh, retaining children such as the terrain's distant horizon.
        frame.scene.traverse((object) => {
          const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
          if (mesh.isMesh !== true || !mesh.visible) return;
          let keep = false;
          if (mesh.isInstancedMesh !== true && mesh.isSkinnedMesh !== true) {
            if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
            if (mesh.geometry.boundingBox !== null) {
              bounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld).getSize(size);
              const horizontal = Math.max(size.x, size.z);
              const terrain = horizontal >= minSize && size.y <= Math.min(size.x, size.z) * 0.5;
              keep = terrain || (mesh.castShadow && Math.max(size.x, size.y, size.z) >= minSize);
            }
          }
          if (keep) included += 1;
          else {
            hidden.push({ object: mesh, mask: mesh.layers.mask });
            mesh.layers.mask = 0;
          }
        });
        if (!reported) {
          console.info(
            `TN_WATER_REFLECTION_DEFAULT: ${JSON.stringify({ included, excluded: hidden.length, minSize })}`,
          );
          reported = true;
        }
        try {
          render(frame);
        } finally {
          for (const { object, mask } of hidden) object.layers.mask = mask;
        }
      };
    }
    if (refreshInterval > 1) {
      // Every frame the pass redraws the world into its target and binds the result. The render is
      // the expensive part; the binding is not. Skipping the whole `updateBefore` on the frames
      // between leaves the previous frame's texture bound and the render target intact, so the
      // material samples the last mirror rather than an empty one. `refreshInterval` counts calls,
      // which is the presented-frame count for a surface built without `bounces` — that is the
      // default, and the node only updates once per frame for it.
      const render = pass.updateBefore.bind(pass);
      let calls = 0;
      pass.updateBefore = (frame: IReflectionFrame): void => {
        if (calls % refreshInterval === 0) render(frame);
        calls += 1;
      };
    }
    this.#reflector = node;
    this.target = node.target;
    node.target.matrixAutoUpdate = false;
    node.target.matrixWorldAutoUpdate = false;
    this.#placeTarget();
  }

  /**
   * The camera the mirrored pass draws this surface with, for one scene camera.
   *
   * The pass mints one of these per scene camera, lazily, and reflects the camera through the
   * mirror plane each frame. It is exposed because `layers` is not the only thing a game may need
   * to say about the second draw — a near/far pair is the other — and because a reflection you
   * cannot inspect is a reflection you cannot cost. Undefined when this surface has no reflection.
   */
  reflectionCameraFor(camera: Camera): Camera | undefined {
    if (this.#reflector === undefined) return undefined;
    // quality-allow: three 0.185 does not type `_reflectorBaseNode` on the reflector node it returns
    return (this.#reflector as unknown as IReflectorWithPass)._reflectorBaseNode.getVirtualCamera(
      camera,
    );
  }

  /** Explicit mask supplied by the game. Undefined means automatic terrain/large-caster selection. */
  readonly reflectionLayers: number | undefined;

  /** How often the mirrored pass redraws, in presented frames. `1` is every frame, the default. */
  readonly reflectionRefreshInterval: number;

  /** The world-space height of the surface, in metres. */
  get level(): number {
    return this.#level;
  }

  /** Move the surface — a tide, a sluice, a flooding room. The mirror plane follows. */
  setLevel(value: number): void {
    if (this.#released) throw new Error("WaterSurface3D is released.");
    this.#level = finite("level", value);
    this.#placeTarget();
  }

  get released(): boolean {
    return this.#released;
  }

  #placeTarget(): void {
    const target = this.target;
    if (target === undefined) return;
    target.position.set(0, this.#level, 0);
    target.quaternion.copy(FACING_UP);
    target.scale.set(1, 1, 1);
    target.updateMatrix();
    // Nothing else will: the target is deliberately not in the scene graph.
    target.matrixWorld.copy(target.matrix);
  }

  /**
   * The world mirrored in the surface, at an optional screen-space offset.
   *
   * The offset is where a game spends its surface normal: a still mirror takes none, and ripples
   * are the normal's horizontal part scaled by however far the game wants the reflection to slide.
   */
  reflectionAt(offset?: Node<"vec2">): Node<"vec3"> {
    const node = this.#reflector;
    if (node === undefined)
      throw new Error("WaterSurface3D was built without reflection; there is nothing to sample.");
    if (offset === undefined) return node.rgb as unknown as Node<"vec3">; // quality-allow: TSL result shape is set by construction; three 0.185 types swizzles and Fn loosely
    // The mirrored pass is flipped in x; the offset rides on top of that, not instead of it.
    return node.sample(clamp(screenUV.flipX().add(offset), vec2(0, 0), vec2(1, 1)))
      .rgb as unknown as Node<"vec3">; // quality-allow: TSL result shape is set by construction; three 0.185 types swizzles and Fn loosely
  }

  /**
   * The frame beneath the surface — everything already drawn this frame, read at an offset.
   *
   * An offset that lands on something **in front of** the water is refused and the fragment falls
   * back to a straight read. Without that, a rock standing in the shallows smears across the
   * water in front of it: the classic refraction bleed, and the reason a hand-rolled offset looks
   * wrong the first time every game writes one.
   */
  refractionAt(offset?: Node<"vec2">): Node<"vec3"> {
    if (offset === undefined) return viewportSharedTexture().rgb as unknown as Node<"vec3">; // quality-allow: TSL result shape is set by construction; three 0.185 types swizzles and Fn loosely
    const safe = select(this.thicknessAt(offset).greaterThan(float(0)), offset, vec2(0, 0));
    return viewportSharedTexture(clamp(screenUV.add(safe), vec2(0, 0), vec2(1, 1)))
      .rgb as unknown as Node<"vec3">; // quality-allow: TSL result shape is set by construction; three 0.185 types swizzles and Fn loosely
  }

  /**
   * Metres of water between this fragment and whatever is drawn behind it, clamped to
   * `maxThickness`. Zero exactly where the bed meets the surface, which is the shoreline.
   *
   * Sky behind the surface has no depth and reads as `maxThickness`, not as zero: an unbounded
   * horizon is deep water, not dry land.
   */
  thicknessAt(offset?: Node<"vec2">): Node<"float"> {
    const behind =
      offset === undefined
        ? viewportLinearDepth
        : linearDepth(viewportDepthTexture(clamp(screenUV.add(offset), vec2(0, 0), vec2(1, 1))));
    // `linearDepth` answers in a 0..1 normalised by the camera's near and far. Undo that here,
    // once, so every reading downstream is in metres and stays in metres when the camera changes.
    const span = cameraFar.sub(cameraNear);
    const metres = behind.sub(linearDepth()).mul(span);
    return clamp(metres, float(0), float(this.maxThickness)) as unknown as Node<"float">; // quality-allow: TSL result shape is set by construction; three 0.185 types swizzles and Fn loosely
  }

  /** Drop the mirrored pass and its render target. */
  dispose(): void {
    if (this.#released) return;
    this.#released = true;
    this.target?.removeFromParent();
    this.#reflector?.dispose();
    this.#reflector = undefined;
  }
}
