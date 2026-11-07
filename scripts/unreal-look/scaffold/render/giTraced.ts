import { GPUSceneBVH, type ICtx, RadianceCache } from "@threenative/core";
import { Box3, Color, type Mesh, type Object3D } from "three";
import type { IGiOptions } from "./giCache.js";

/**
 * PRD-831: the GI field as a `RadianceCache` that traces the packed scene on the GPU, in place of `giCache.ts`'s CPU bake.
 * `installGi` reads it through `options.field`: a material's irradiance is the volume's E at the pixel, divided by pi (the
 * cache's own unit is E / pi). The volume refreshes over the first frames, so a capture waits for `field.ready()`.
 */
export interface IGiTracedField {
  /** The irradiance node `installGi` reads: E / pi at a world position and normal. */
  readonly irradiance: NonNullable<IGiOptions["field"]>["irradiance"];
  /** True once every probe has been traced. */
  ready(): boolean;
}

type TracedCtx = Pick<ICtx, "add" | "camera" | "scene">;

export function tracedGiField(
  ctx: TracedCtx,
  root: Object3D,
  options: Pick<IGiOptions, "lights" | "sun">,
  skyColor: Color,
  /** Probes per metre. */
  density = 1,
): IGiTracedField {
  // A glass pane is not a surface the probes see (the cache's own rule): only opaque meshes are packed.
  const bvh = ctx.add(
    new GPUSceneBVH(ctx.scene, {
      include: (mesh: Mesh) => [mesh.material].flat().every((m) => !m.transparent),
    }),
  );
  const bounds = new Box3().setFromObject(root);
  const volume = ctx.add(
    new RadianceCache({
      bounds,
      density,
      trace: {
        bvh,
        camera: ctx.camera,
        points: (options.lights ?? []).map((l) => ({
          color: l.color,
          distance: l.distance,
          intensity: l.intensity,
          position: l.position,
        })),
        sky: skyColor,
        sun: options.sun ?? {
          color: new Color(0, 0, 0),
          direction: ctx.camera.position.clone().normalize(),
          intensity: 0,
        },
      },
    }),
  );
  void volume.requestBake(ctx.scene);
  return {
    irradiance: (position, normal) => volume.sampleNode(position, normal).div(Math.PI),
    ready: () => volume.observation.status === "ready",
  };
}
