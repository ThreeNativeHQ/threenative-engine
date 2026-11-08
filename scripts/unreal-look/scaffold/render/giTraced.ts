import { GPUSceneBVH, type ICtx, RadianceCache } from "@threenative/core";
import { Box3, Color, type Mesh, type Object3D } from "three";
import { normalize } from "three/tsl";
import { type IGiOptions, skyRadiance } from "./giCache.js";

/**
 * PRD-831: the GI field as a `RadianceCache` that traces the packed scene on the GPU, in place of `giCache.ts`'s CPU bake.
 * `installGi` reads it through `options.field`: a material's irradiance is the volume's E at the pixel, divided by pi (the
 * cache's own unit is E / pi). The volume refreshes over the first frames, so a capture waits for `field.ready()`.
 */
export interface IGiTracedField {
  /** The irradiance node `installGi` reads: E / pi at a world position and normal. */
  readonly irradiance: NonNullable<IGiOptions["field"]>["irradiance"];
  /** The radiance arriving along a direction (E / pi units), for the screen gather's per-ray fallback. */
  readonly radiance: NonNullable<NonNullable<IGiOptions["field"]>["radiance"]>;
  /** True once every probe has been traced. */
  ready(): boolean;
}

/**
 * The baked sky's mean radiance over the upper hemisphere, solid-angle weighted, times `gain`: the flat sky an escaping
 * trace ray reads (the trace kernel takes one sky colour). Black when no sky was baked.
 */
export function upperSkyMean(gain = 1): Color {
  const sky = skyRadiance.current;
  if (sky === undefined) return new Color(0, 0, 0);
  const sum = [0, 0, 0];
  let weight = 0;
  for (let y = 0; y < sky.height / 2; y += 1) {
    const w = Math.sin(((y + 0.5) / sky.height) * Math.PI);
    for (let x = 0; x < sky.width; x += 1)
      for (let c = 0; c < 3; c += 1)
        sum[c] = (sum[c] ?? 0) + (sky.data[(y * sky.width + x) * 3 + c] ?? 0) * w;
    weight += w * sky.width;
  }
  const at = (c: number) => ((sum[c] ?? 0) / Math.max(weight, 1e-9)) * (sky.scale[c] ?? 1) * gain;
  return new Color(at(0), at(1), at(2));
}

type TracedCtx = Pick<ICtx, "add" | "beforeRender" | "camera" | "scene">;

export function tracedGiField(
  ctx: TracedCtx,
  root: Object3D,
  options: Pick<IGiOptions, "lights" | "sun">,
  skyColor: Color,
  /** Probes per metre. */
  density = 1,
  /** Rays per probe along one side: `probeResolution` squared rays (the cache's default is 8, 64 rays). */
  probeResolution?: number,
  /** Read the field this share of a probe spacing off the surface, along its normal (the near field this gather cannot trace). */
  normalBias = 0,
  /** Cells per side of each probe's octahedral radiance map, which the gather's per-ray read uses; 0 reads the SH. */
  radianceProbeResolution = 0,
  /** Depth-test the eight probes a read blends (needs the map): a probe behind a wall drops out. */
  probeVisibility = false,
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
      ...(probeResolution === undefined ? {} : { probeResolution }),
      radianceProbeResolution,
      probeVisibility,
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
  const spacing = Math.min(
    ...(["x", "y", "z"] as const).map(
      (a) => (bounds.max[a] - bounds.min[a]) / Math.max(1, volume.resolution[a] - 1),
    ),
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
      `TN_GI_CACHE_FIELD ${JSON.stringify({ event, probes: volume.probeCount, status: o.status, traced: o.probesTraced, rejected: o.probesRejected, cost: o.bakeCostMs, atlasMax: atlasMax() })}`,
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
    irradiance: (position, normal) =>
      volume
        .sampleNode(
          normalBias > 0 ? position.add(normalize(normal).mul(normalBias * spacing)) : position,
          normal,
        )
        .div(Math.PI),
    radiance: (position, direction) => volume.sampleRadianceNode(position, direction),
    ready: () => volume.observation.status === "ready",
  };
}
