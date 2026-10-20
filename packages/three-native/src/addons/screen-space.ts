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

    // The projection terms a view <-> screen mapping of a perspective camera needs, read from the scene
    // camera before every render: column k of P (P * e_k) is e[4k..4k+3] of its column-major elements.
    // Depth is (A z + B) / -z, so z = -B / (depth + A).
    const camera = options.camera;
    if (camera?.projectionMatrix === undefined)
      throw new TypeError(
        "TN_NATIVE_SSR_CAMERA: ssr needs options.camera, the camera the scene pass draws with",
      );
    const live = (read: () => number): TslNode => uniform(read()).onRenderUpdate(read);
    const term = (index: number): TslNode =>
      live(() => camera.projectionMatrix.elements[index] ?? 0);
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
