import { type ICtx, WaterSurface3D } from "@threenative/core";
import type { Object3D } from "three";
import type { WebGPURenderer } from "three/webgpu";
import { DisposalScope } from "./realisticOceanLifetime.js";
import {
  type IRealisticWaterSurface,
  SEA_STATE,
  createRealisticMaps,
  createRealisticSea,
  createRealisticWaterMesh,
} from "./render/realisticSea.js";
import type { ISeaState } from "./render/realisticSpectrum.js";

type OceanContext = Pick<ICtx, "renderer" | "scene" | "camera" | "add" | "every">;

export interface IRealisticOceanOptions {
  /** The sea state. Defaults to `SEA_STATE` in `./render/realisticSea.ts`. */
  readonly state?: ISeaState;
  /** Direction toward the sun and the radiance of the crest glow. The scene's own light is separate. */
  readonly sun?: readonly [number, number, number];
  /** `false` omits the planar mirror of hulls and marks; the image-based sky reflection stays. */
  readonly reflection?: boolean;
  /** Drawn objects must be on this layer to appear in the mirror; see `reflect`. */
  readonly reflectionLayer?: number;
}

export type RealisticOcean = ReturnType<typeof createRealisticOcean>;

function isWebGPURenderer(value: unknown): value is WebGPURenderer {
  return (
    typeof value === "object" &&
    value !== null &&
    "isWebGPURenderer" in value &&
    value.isWebGPURenderer === true
  );
}

/**
 * One call, no render loop to install: the scene owns the clock, the compute dispatch and the
 * removal lifecycle. The mesh is horizontal, in world coordinates, and must stay an untransformed
 * scene-root child. Appearance lives in ./render/realistic*.ts, which the game may rewrite.
 *
 * Do not also `ctx.add` the returned `ocean` or `maps`: this call already registered each once, and
 * a second registration would dispatch the simulation twice.
 */
export function createRealisticOcean(ctx: OceanContext, input: IRealisticOceanOptions = {}) {
  const renderer = ctx.renderer.raw;
  if (ctx.renderer.kind !== "webgpu" || !isWebGPURenderer(renderer)) {
    throw new Error(
      "The realistic ocean requires ThreeNative's WebGPU renderer (FFT storage/compute); WebGL2 is not a supported fallback.",
    );
  }
  const state = input.state ?? SEA_STATE;
  const layer = input.reflectionLayer ?? 1;
  const scope = new DisposalScope();
  try {
    const ocean = ctx.add(createRealisticSea(state));
    scope.defer(() => ocean.removeFromParent());
    const maps = ctx.add(createRealisticMaps(ocean));
    scope.defer(() => maps.removeFromParent());
    const mirror =
      input.reflection === false
        ? undefined
        : new WaterSurface3D({
            level: 0,
            // Never read: the sea is deep everywhere and has no bed to see.
            maxThickness: 24,
            reflection: { resolutionScale: 0.5, layers: 1 << layer },
          });
    let surface: ReturnType<typeof createRealisticWaterMesh>;
    try {
      surface = createRealisticWaterMesh(ocean, maps, mirror, {
        software: ctx.renderer.softwareAdapter !== undefined,
        state,
      });
    } catch (error) {
      // No surface took the mirror, so nothing else will release its render target.
      mirror?.dispose();
      throw error;
    }
    // The surface disposes the mirror it was given, so that is not deferred separately.
    scope.defer(() => surface.dispose());
    scope.defer(() => surface.mesh.removeFromParent());
    if (input.sun !== undefined) surface.setSun(input.sun);
    const onRemoved = () => scope.dispose();
    surface.mesh.addEventListener("removed", onRemoved);
    scope.defer(() => surface.mesh.removeEventListener("removed", onRemoved));
    let seconds = 0;
    const tick = ctx.every((dt) => {
      if (scope.disposed) return;
      seconds += dt;
      ocean.advance(seconds);
      surface.advance(seconds);
    });
    scope.defer(() => tick.cancel());
    ctx.add(surface.mesh);

    const assertLive = () => {
      if (scope.disposed) throw new Error("The realistic ocean has been disposed.");
    };
    return {
      mesh: surface.mesh,
      ocean,
      maps,
      get disposed(): boolean {
        return scope.disposed;
      },
      /** Keep the drawn disc under a position; the waves stay anchored to the world. */
      follow(x: number, z: number): void {
        assertLive();
        surface.follow(x, z);
      },
      /** A hull's position, heading and way on (0..1), for its wake and waterline wash. */
      wake: (...args: Parameters<IRealisticWaterSurface["wake"]>) => {
        assertLive();
        surface.wake(...args);
      },
      setSun(...args: Parameters<IRealisticWaterSurface["setSun"]>): void {
        assertLive();
        surface.setSun(...args);
      },
      /** Put an object, and every child, in the planar mirror. Layers are not inherited. */
      reflect(object: Object3D): void {
        object.traverse((part) => part.layers.enable(layer));
      },
      /** Forget every whitecap, for a teleport or a restart. */
      reset(): void {
        assertLive();
        surface.reset();
      },
      /**
       * The surface height at a world position, and how many frames behind the GPU copy is.
       * `undefined` until a copy lands, never zero.
       */
      sampleHeight(x: number, z: number) {
        assertLive();
        return ocean.sampleHeight(x, z);
      },
      dispose(): void {
        scope.dispose();
      },
    };
  } catch (error) {
    try {
      scope.dispose();
    } catch {
      /* Preserve the initialization failure, after releasing everything possible. */
    }
    throw error;
  }
}
