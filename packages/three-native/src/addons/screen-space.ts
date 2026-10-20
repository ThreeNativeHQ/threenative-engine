/**
 * Screen-space reflections for the owned engine, with the call shape of three's `ssr(color, depth,
 * normal, options)` (SSRNode): the engine had no live SSR node, so `three/addons/tsl/display/SSRNode.js`
 * refused by name. This one is authored in TSL over the engine's own functions, so the V8 player and the
 * Wasm web module share it (both hand `defineScreenSpaceReflections` their TSL table).
 *
 * What it computes: per pixel, a view-space ray along the mirror direction, marched in `steps` slices
 * that grow with distance (a quadratic spacing, so near hits are dense), tested against the depth
 * buffer, refined by bisection. A hit samples the lit colour at the hit pixel. The returned colour is
 * a **delta to add to the lit frame**: for a metal it replaces the frame's own environment reflection
 * with the traced one (`hit - base`), for a dielectric it adds the Fresnel-weighted reflection. A ray
 * that finds nothing on screen adds nothing, so the environment reflection stays: the same tiering
 * Unreal's Lumen reflections use, screen traces first and the captured sky for what they miss
 * (Engine/Source/Runtime/Renderer/Private/Lumen/LumenReflections.cpp). Roughness never gates here;
 * the game scales the result by its own roughness cut-off, since where a reflection fades is a look.
 */

/** A TSL node: every method three's node classes carry, built by the engine's table. */
// quality-allow: three's TSL node surface is open-ended chained calls; the engine table returns them untyped.
// biome-ignore lint/suspicious/noExplicitAny: three's TSL node surface is open-ended chained calls.
export type TslNode = any;

/** The engine TSL functions and inputs the effect composes. */
export interface IScreenSpaceTsl {
  // biome-ignore lint/style/useNamingConvention: three's TSL function name.
  readonly Break: () => void;
  // biome-ignore lint/style/useNamingConvention: three's TSL function name.
  readonly Fn: (body: () => TslNode) => () => TslNode;
  // biome-ignore lint/style/useNamingConvention: three's TSL function name.
  readonly If: (condition: TslNode, body: () => void) => { Else(body: () => void): void };
  // biome-ignore lint/style/useNamingConvention: three's TSL function name.
  readonly Loop: (
    options: { start: TslNode; end: TslNode; type: string; condition: string },
    body: (indices: { i: TslNode }) => void,
  ) => void;
  readonly clamp: (value: TslNode, low: TslNode, high: TslNode) => TslNode;
  readonly dot: (a: TslNode, b: TslNode) => TslNode;
  readonly float: (value: TslNode) => TslNode;
  readonly int: (value: number) => TslNode;
  readonly max: (a: TslNode, b: TslNode) => TslNode;
  readonly min: (a: TslNode, b: TslNode) => TslNode;
  readonly mix: (a: TslNode, b: TslNode, t: TslNode) => TslNode;
  readonly normalize: (value: TslNode) => TslNode;
  readonly reflect: (incident: TslNode, normal: TslNode) => TslNode;
  readonly rtt: (
    source: TslNode,
    width: number | null,
    height: number | null,
    options: { type: number },
  ) => TslNode;
  readonly smoothstep: (low: TslNode, high: TslNode, value: TslNode) => TslNode;
  readonly uniform: (value: number) => TslNode;
  readonly uv: () => TslNode;
  readonly vec2: (...values: TslNode[]) => TslNode;
  readonly vec3: (...values: TslNode[]) => TslNode;
  readonly vec4: (...values: TslNode[]) => TslNode;
}

/** The perspective camera the frame draws with: the effect reads its projection each render. */
export interface IScreenSpaceCamera {
  readonly near: number;
  readonly projectionMatrix: { readonly elements: readonly number[] };
}

export interface IScreenSpaceReflectionOptions {
  /**
   * The camera the scene pass draws with. A post effect is drawn through its own full-screen quad, so
   * the engine's `cameraProjectionMatrix` there is the quad's orthographic camera, not the scene's:
   * every view/screen mapping built on it is wrong and no ray ever hits (three's SSRNode reads the
   * scene camera through a reference uniform for the same reason).
   */
  readonly camera: IScreenSpaceCamera;
  /** Per-pixel metalness. Missing means every surface is a dielectric. */
  readonly metalnessNode?: TslNode;
  /** Per-pixel roughness. Missing means every surface is a mirror. It blurs the sampled hit. */
  readonly roughnessNode?: TslNode;
  /** `false` skips dielectrics, as three's SSR does by default. */
  readonly reflectNonMetals?: boolean;
}

const HALF_FLOAT_TYPE = 1016;
/** Ray slices per pixel. A game scales how far they reach (`maxDistance`), not how many there are. */
const STEPS = 48;
/** Bisection steps that sharpen a detected crossing. */
const REFINEMENTS = 5;
/** Largest radiance a hit may carry, so one sun-lit highlight cannot paint a whole reflection. */
const MAX_LUMINANCE = 10;

/**
 * The view <-> screen mapping of the scene camera, as TSL over uniforms refreshed every render. A post
 * effect is drawn through its own quad, so the engine's own camera nodes there are the quad's.
 */
function defineCameraMapping(
  tsl: IScreenSpaceTsl,
  camera: IScreenSpaceCamera | undefined,
  owner: string,
) {
  const { float, uniform, vec2, vec3 } = tsl;
  // The projection terms a view <-> screen mapping of a perspective camera needs, read from the scene
  // camera before every render: column k of P (P * e_k) is e[4k..4k+3] of its column-major elements.
  // Depth is (A z + B) / -z, so z = -B / (depth + A).
  if (camera?.projectionMatrix === undefined)
    throw new TypeError(
      `TN_NATIVE_${owner.toUpperCase()}_CAMERA: ${owner} needs options.camera, the camera the scene pass draws with`,
    );
  const live = (read: () => number): TslNode => uniform(read()).onRenderUpdate(read);
  const term = (index: number): TslNode => live(() => camera.projectionMatrix.elements[index] ?? 0);
  const cameraNear = live(() => camera.near);
  const column0 = { x: term(0) };
  const column1 = { y: term(5) };
  const column2 = { x: term(8), y: term(9), z: term(10) };
  const column3 = { z: term(14) };
  const viewZ = (depth: TslNode): TslNode => column3.z.negate().div(depth.add(column2.z));
  const viewPosition = (coordinate: TslNode, depth: TslNode): TslNode => {
    const z = viewZ(depth);
    const ndcX = coordinate.x.mul(2).sub(1);
    const ndcY = float(1).sub(coordinate.y).mul(2).sub(1);
    return vec3(
      z.negate().mul(ndcX.add(column2.x)).div(column0.x),
      z.negate().mul(ndcY.add(column2.y)).div(column1.y),
      z,
    );
  };
  const project = (position: TslNode): TslNode => {
    const w = position.z.negate();
    const ndcX = position.x.mul(column0.x).add(position.z.mul(column2.x)).div(w);
    const ndcY = position.y.mul(column1.y).add(position.z.mul(column2.y)).div(w);
    return vec2(ndcX.mul(0.5).add(0.5), float(0.5).sub(ndcY.mul(0.5)));
  };
  return { cameraNear, viewZ, viewPosition, project };
}

export function defineScreenSpaceReflections(tsl: IScreenSpaceTsl) {
  return function ssr(
    colorNode: TslNode,
    depthNode: TslNode,
    normalNode: TslNode,
    options: IScreenSpaceReflectionOptions,
  ): TslNode {
    // Read here, not at definition: the camera inputs are lazy engine nodes.
    const { Break, Fn, If, Loop, clamp, dot, float, int } = tsl;
    const { max, min, mix, normalize, reflect, rtt, smoothstep, uniform, uv, vec2, vec3, vec4 } =
      tsl;
    const maxDistance = uniform(1);
    const thickness = uniform(0.1);
    const intensity = uniform(1);
    const screenEdgeFade = uniform(0.2);
    const roughness = options.roughnessNode ?? float(0);
    const metalness = options.metalnessNode ?? float(0);

    const { cameraNear, viewZ, viewPosition, project } = defineCameraMapping(
      tsl,
      options.camera,
      "ssr",
    );

    const graph = Fn(() => {
      const coordinate = uv();
      const result = vec4(0, 0, 0, 0).toVar();
      const centreDepth = depthNode.sample(coordinate).r;
      If(centreDepth.lessThan(1), () => {
        const position = viewPosition(coordinate, centreDepth);
        const normal = normalize(normalNode.sample(coordinate).xyz);
        const incident = normalize(position);
        const direction = normalize(reflect(incident, normal));
        // Start off the surface, by more the farther it is: depth precision falls with distance.
        const origin = position.add(normal.mul(max(0.01, position.z.negate().mul(0.004))));

        const hitCoordinate = vec2(0, 0).toVar();
        const hitDistance = float(-1).toVar();
        const previous = float(0).toVar();
        // The sample before: a hit is a crossing from in front of the depth buffer to behind it, and the
        // buffer's own depth change between the two samples is slack (a floor seen at a grazing angle drops
        // away faster along the ray than any fixed thickness covers; a depth jump is an edge, not slack).
        const previousBehind = float(-1).toVar();
        const previousSceneZ = position.z.toVar();
        Loop({ start: int(0), end: int(STEPS), type: "int", condition: "<" }, ({ i }) => {
          const fraction = float(i).add(1).div(STEPS);
          const travelled = maxDistance.mul(fraction.mul(fraction));
          const point = origin.add(direction.mul(travelled));
          If(point.z.greaterThan(cameraNear.negate()), () => {
            Break();
          });
          const screen = project(point);
          If(
            screen.x
              .lessThan(0)
              .or(screen.x.greaterThan(1))
              .or(screen.y.lessThan(0))
              .or(screen.y.greaterThan(1)),
            () => {
              Break();
            },
          );
          const sceneDepth = depthNode.sample(screen).r;
          // Positive: the ray is behind the surface the depth buffer holds at that pixel.
          const sceneZ = viewZ(sceneDepth);
          const behind = sceneZ.sub(point.z);
          const slice = travelled.sub(previous);
          const drop = sceneZ.sub(previousSceneZ).abs();
          const slack = drop.lessThan(sceneZ.abs().mul(0.15)).select(drop, float(0));
          If(
            sceneDepth
              .lessThan(1)
              .and(behind.greaterThan(0))
              .and(previousBehind.lessThanEqual(0))
              .and(behind.lessThan(thickness.add(slice.mul(direction.z.abs())).add(slack))),
            () => {
              // Bisect the slice [previous, travelled] to put the hit on the surface.
              const low = previous.toVar();
              const high = travelled.toVar();
              Loop({ start: int(0), end: int(REFINEMENTS), type: "int", condition: "<" }, () => {
                const middle = low.add(high).mul(0.5);
                const middleScreen = project(origin.add(direction.mul(middle)));
                const middleDepth = viewZ(depthNode.sample(middleScreen).r).sub(
                  origin.add(direction.mul(middle)).z,
                );
                If(middleDepth.greaterThan(0), () => {
                  high.assign(middle);
                }).Else(() => {
                  low.assign(middle);
                });
              });
              hitDistance.assign(high);
              hitCoordinate.assign(project(origin.add(direction.mul(high))));
              Break();
            },
          );
          previous.assign(travelled);
          previousBehind.assign(behind);
          previousSceneZ.assign(sceneZ);
        });

        If(hitDistance.greaterThanEqual(0), () => {
          // A rougher surface smears the hit: a cross of taps whose reach grows with roughness.
          const reach = roughness.mul(0.03);
          const tap = (offset: TslNode): TslNode => colorNode.sample(hitCoordinate.add(offset)).rgb;
          const hit = tap(vec2(0, 0))
            .add(tap(vec2(reach, 0)))
            .add(tap(vec2(reach.negate(), 0)))
            .add(tap(vec2(0, reach)))
            .add(tap(vec2(0, reach.negate())))
            .mul(0.2)
            .min(vec3(MAX_LUMINANCE, MAX_LUMINANCE, MAX_LUMINANCE));
          // A surface that faces away from the ray was reached through its back: no reflection.
          const hitNormal = normalize(normalNode.sample(hitCoordinate).xyz);
          const facing = smoothstep(0.25, -0.05, dot(hitNormal, direction));
          const edge = min(
            min(
              smoothstep(0, screenEdgeFade, hitCoordinate.x),
              smoothstep(0, screenEdgeFade, float(1).sub(hitCoordinate.x)),
            ),
            min(
              smoothstep(0, screenEdgeFade, hitCoordinate.y),
              smoothstep(0, screenEdgeFade, float(1).sub(hitCoordinate.y)),
            ),
          );
          const reach01 = hitDistance.div(maxDistance);
          const distance = float(1).sub(smoothstep(0.5, 1, reach01));
          const weight = facing.mul(edge).mul(distance).mul(intensity);
          const facingView = clamp(dot(normal, incident.negate()), 0, 1);
          const fresnel = float(0.04).add(float(0.96).mul(float(1).sub(facingView).pow(5)));
          const base = colorNode.sample(coordinate).rgb;
          const dielectric = hit.mul(fresnel).mul(options.reflectNonMetals === true ? 1 : 0);
          const delta = mix(dielectric, hit.sub(base), clamp(metalness, 0, 1));
          result.assign(vec4(delta.mul(weight), 0));
        });
      });
      return result;
    })();

    const node = rtt(graph, null, null, { type: HALF_FLOAT_TYPE });
    return Object.defineProperties(node, {
      maxDistance: { value: maxDistance },
      thickness: { value: thickness },
      intensity: { value: intensity },
      screenEdgeFade: { value: screenEdgeFade },
      resolutionScale: {
        get: () => node.getResolutionScale(),
        set: (value: number) => node.setResolutionScale(value),
      },
    });
  };
}

export interface IScreenSpaceGiOptions {
  /** The camera the scene pass draws with (see IScreenSpaceReflectionOptions.camera). */
  readonly camera: IScreenSpaceCamera;
  /**
   * The light a ray that finds nothing on screen would have returned: the tier below the screen traces. It is
   * called once per pixel with the pixel's view-space position and unit normal and answers the average incident
   * radiance (E / pi) that tier already supplies there. The gather then returns `hit - fallback` for the rays that
   * hit, so the two tiers never add the same light twice. Missing means 0, as three's SSGINode (hits add light).
   */
  readonly fallback?: (position: TslNode, normal: TslNode) => TslNode;
}

/** Rays per slice: sliceCount x this many cosine-weighted rays leave each pixel. */
const RAYS_PER_SLICE = 4;
/** The most slices a trace may take (`stepCount` picks how many, spaced quadratically over `radius`). */
const GI_MAX_STEPS = 24;
/** Largest radiance a hit may carry (the radiosity cache of Lumen caps a ray at 40: LumenRadiosity.cpp). */
const GI_MAX_LUMINANCE = 40;

/**
 * Screen-space diffuse GI for the owned engine, with the call shape of three's `ssgi(beauty, depth, normal,
 * camera)` (SSGINode): per pixel, `sliceCount x 4` cosine-weighted rays over the normal's hemisphere, each
 * marched through the depth buffer in `stepCount` slices (a quadratic spacing out to `radius`, hits by depth crossing with Lumen's
 * relative thickness, 0.02 of the depth: LumenScreenProbeTracing.cpp). A hit returns the lit colour at the hit
 * pixel, as Lumen's screen traces return the previous frame's lit scene; a miss returns the `fallback` tier.
 * The result is the incident radiance the traces add to what the fallback supplies, E / pi units: the caller
 * multiplies it by the receiver's albedo (`mrt({ diffuseColor })`) and adds it to the lit frame.
 *   rgb  mean over the rays of hit x (hit radiance - fallback)
 *   a    the share of rays that hit
 * `getAONode()` answers 1: occlusion is the GTAO stage's, and hits already darken through `hit - fallback`.
 */
export function defineScreenSpaceGi(tsl: IScreenSpaceTsl) {
  return function ssgi(
    colorNode: TslNode,
    depthNode: TslNode,
    normalNode: TslNode,
    cameraOrOptions: IScreenSpaceCamera | IScreenSpaceGiOptions,
  ): TslNode {
    const { Break, Fn, If, Loop, float, int, max, min, normalize, rtt, smoothstep, uniform, uv } =
      tsl;
    const { vec2, vec3, vec4 } = tsl;
    const options: IScreenSpaceGiOptions =
      "camera" in cameraOrOptions ? cameraOrOptions : { camera: cameraOrOptions };
    const { cameraNear, viewZ, viewPosition, project } = defineCameraMapping(
      tsl,
      options.camera,
      "ssgi",
    );
    const radius = uniform(12);
    const thickness = uniform(0.02);
    const sliceCount = uniform(2);
    const stepCount = uniform(12);
    const intensity = uniform(1);
    const screenEdgeFade = uniform(0.1);

    const graph = Fn(() => {
      const coordinate = uv();
      const result = vec4(0, 0, 0, 0).toVar();
      const centreDepth = depthNode.sample(coordinate).r;
      const centreNormal = normalNode.sample(coordinate).xyz;
      // A draw the normal pass skips (an unlit material) leaves a zero normal: it takes no gathered light.
      If(centreDepth.lessThan(1).and(centreNormal.dot(centreNormal).greaterThan(0.25)), () => {
        const position = viewPosition(coordinate, centreDepth);
        const normal = normalize(centreNormal);
        const fallback = options.fallback?.(position, normal) ?? vec3(0, 0, 0);
        // A frame around the normal, and a per-pixel rotation of the ray set (interleaved gradient noise on a
        // fixed lattice of the uv: the noise is the denoiser's to remove, not a pattern to see).
        const helper = normal.y
          .abs()
          .lessThan(0.99)
          .select(vec3(0, 1, 0), vec3(1, 0, 0));
        const tangent = normalize(helper.cross(normal));
        const bitangent = normal.cross(tangent);
        const cell = coordinate.mul(2048).floor();
        const noiseA = cell.x
          .mul(0.06711056)
          .add(cell.y.mul(0.00583715))
          .fract()
          .mul(52.9829189)
          .fract();
        const noiseB = noiseA.mul(7.31).add(cell.x.mul(0.0123)).fract();
        const origin = position.add(normal.mul(max(0.01, position.z.negate().mul(0.004))));
        const rays = sliceCount.mul(RAYS_PER_SLICE);

        const gathered = vec3(0, 0, 0).toVar();
        const hits = float(0).toVar();
        Loop(
          { start: int(0), end: int(RAYS_PER_SLICE * 8), type: "int", condition: "<" },
          ({ i }) => {
            If(float(i).greaterThanEqual(rays), () => {
              Break();
            });
            // Stratified cosine-weighted direction: u1 stratified over the set, u2 a golden-ratio sequence.
            const u1 = float(i).add(noiseA).div(rays);
            const u2 = noiseB.add(float(i).mul(0.61803398875)).fract();
            const spread = u1.sqrt();
            const angle = u2.mul(6.28318530718);
            const direction = normalize(
              tangent
                .mul(spread.mul(angle.cos()))
                .add(bitangent.mul(spread.mul(angle.sin())))
                .add(normal.mul(float(1).sub(u1).sqrt())),
            );

            const hitCoordinate = vec2(0, 0).toVar();
            const hitDistance = float(-1).toVar();
            const previous = float(0).toVar();
            const previousBehind = float(-1).toVar();
            const previousSceneZ = position.z.toVar();
            Loop(
              { start: int(0), end: int(GI_MAX_STEPS), type: "int", condition: "<" },
              ({ i: step }) => {
                If(float(step).greaterThanEqual(stepCount), () => {
                  Break();
                });
                const fraction = float(step).add(1).div(stepCount);
                const travelled = radius.mul(fraction.mul(fraction));
                const point = origin.add(direction.mul(travelled));
                If(point.z.greaterThan(cameraNear.negate()), () => {
                  Break();
                });
                const screen = project(point);
                If(
                  screen.x
                    .lessThan(0)
                    .or(screen.x.greaterThan(1))
                    .or(screen.y.lessThan(0))
                    .or(screen.y.greaterThan(1)),
                  () => {
                    Break();
                  },
                );
                const sceneDepth = depthNode.sample(screen).r;
                const sceneZ = viewZ(sceneDepth);
                const behind = sceneZ.sub(point.z);
                const slice = travelled.sub(previous);
                const drop = sceneZ.sub(previousSceneZ).abs();
                const slack = drop.lessThan(sceneZ.abs().mul(0.15)).select(drop, float(0));
                // Lumen's relative thickness, plus what the slice itself can have crossed.
                const reach = sceneZ
                  .abs()
                  .mul(thickness)
                  .add(slice.mul(direction.z.abs()))
                  .add(slack);
                If(
                  sceneDepth
                    .lessThan(1)
                    .and(behind.greaterThan(0))
                    .and(previousBehind.lessThanEqual(0))
                    .and(behind.lessThan(reach)),
                  () => {
                    hitCoordinate.assign(screen);
                    hitDistance.assign(travelled);
                    Break();
                  },
                );
                previous.assign(travelled);
                previousBehind.assign(behind);
                previousSceneZ.assign(sceneZ);
              },
            );

            If(hitDistance.greaterThanEqual(0), () => {
              // A surface that faces away from the ray was reached through its back: a miss.
              // (An unlit surface has no normal, so it counts as facing: a light source is usually one.)
              const hitNormal = normalNode.sample(hitCoordinate).xyz;
              const hitLength = hitNormal.dot(hitNormal).sqrt();
              const facing = hitLength
                .greaterThan(0.5)
                .select(
                  smoothstep(
                    0.25,
                    -0.05,
                    hitNormal.dot(direction).div(max(hitLength, float(1e-4))),
                  ),
                  float(1),
                );
              const edge = min(
                min(
                  smoothstep(0, screenEdgeFade, hitCoordinate.x),
                  smoothstep(0, screenEdgeFade, float(1).sub(hitCoordinate.x)),
                ),
                min(
                  smoothstep(0, screenEdgeFade, hitCoordinate.y),
                  smoothstep(0, screenEdgeFade, float(1).sub(hitCoordinate.y)),
                ),
              );
              // The trace fades into the fallback over its last half, as SSR's does.
              const reachFade = float(1).sub(smoothstep(0.5, 1, hitDistance.div(radius)));
              const weight = facing.mul(edge).mul(reachFade);
              const radiance = colorNode
                .sample(hitCoordinate)
                .rgb.min(vec3(GI_MAX_LUMINANCE, GI_MAX_LUMINANCE, GI_MAX_LUMINANCE));
              gathered.assign(gathered.add(radiance.sub(fallback).mul(weight)));
              hits.assign(hits.add(weight));
            });
          },
        );
        result.assign(vec4(gathered.div(rays).mul(intensity), hits.div(rays)));
      });
      return result;
    })();

    const node = rtt(graph, null, null, { type: HALF_FLOAT_TYPE });
    const uniformObjects = { radius, thickness, sliceCount, stepCount, intensity, screenEdgeFade };
    return Object.defineProperties(node, {
      ...Object.fromEntries(
        Object.entries(uniformObjects).map(([name, value]) => [name, { value }]),
      ),
      getGINode: { value: () => node },
      getAONode: { value: () => vec4(1, 1, 1, 1) },
      resolutionScale: {
        get: () => node.getResolutionScale(),
        set: (value: number) => node.setResolutionScale(value),
      },
    });
  };
}
