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

type TracedCtx = Pick<ICtx, "add" | "beforeRender" | "camera" | "scene">;

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
      // A calibration capture is a few hundred stepped frames: the whole field traces at once (a game keeps the 2 ms budget).
      bakeBudgetMs: 200,
      numProbesToTraceBudget: 4096,
      probesPerFrame: 4096,
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
  /** The largest value in the atlas: 0 while no probe has landed, or when the lamps reach nothing. */
  const atlasMax = (): number => {
    let max = 0;
    for (const v of volume.atlasData) max = Math.max(max, Math.abs(v));
    return Math.round(max * 1e4) / 1e4;
  };
  const log = (event: string): void => {
    const o = volume.observation;
    console.info(
      `TN_GI_CACHE_FIELD ${JSON.stringify({ event, probes: volume.probeCount, status: o.status, traced: o.probesTraced, cost: o.bakeCostMs, atlasMax: atlasMax() })}`,
    );
  };
  log("created");
  volume.requestBake(ctx.scene).then(
    () => log("baked"),
    (error: unknown) => console.info(`TN_GI_CACHE_FIELD failed ${String(error)}`),
  );
  // The field's progress at frames 1, 8, 32, 128 and 512 (a stepped capture owns the page clock, so a timer never fires): a
  // capture that reads black shows here whether the volume traced.
  let frame = 0;
  ctx.beforeRender?.(() => {
    frame += 1;
    if (![1, 8, 32, 128, 512].includes(frame)) return;
    log(`frame ${frame}`);
  });
  return {
    irradiance: (position, normal) => volume.sampleNode(position, normal).div(Math.PI),
    ready: () => volume.observation.status === "ready",
  };
}
