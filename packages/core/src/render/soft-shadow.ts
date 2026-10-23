import {
  type CubeTexture,
  type DepthTexture,
  GreaterEqualCompare,
  LessEqualCompare,
  type LightShadow,
  type OrthographicCamera,
  type PerspectiveCamera,
} from "three";
import {
  Fn,
  If,
  cameraPosition,
  cross,
  cubeTexture,
  dFdx,
  dFdy,
  float,
  ivec2,
  max,
  min,
  positionWorld,
  reference,
  sqrt,
  step,
  type texture,
  textureLoad,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";

/** tan(5 degrees): Unreal's `r.Shadow.Virtual.SubsurfaceShadowMinSourceAngle`, the sun's least source on a leaf. */
export const LEAF_MIN_SOURCE_TANGENT = Math.tan((5 * Math.PI) / 180);

declare module "three" {
  // biome-ignore lint/style/useNamingConvention: a module augmentation keeps three's own class name.
  interface Material {
    /**
     * Unreal's Two Sided Foliage shading model (PRD-651). The receiver looks its shadow up where it
     * stands, without the normal bias, and sees a sun of at least 5 degrees. The default is off: a
     * card with two sides and a cut is a default lit material in Unreal, and keeps the normal bias.
     */
    twoSidedFoliage?: boolean;
  }
}

/**
 * A receiver marked `twoSidedFoliage` (PRD-651). Unreal gives its Two Sided Foliage and subsurface
 * pixels no normal bias and a sun source of at least 5 degrees, because a thin leaf biased along its
 * normal either shades itself or lets light through. The sides and the cut do not choose this: Unreal
 * reads the shading model, so the rule reads the marker and never infers it.
 */
export function isLeafReceiver(
  material: { readonly twoSidedFoliage?: boolean } | null | undefined,
): boolean {
  return material?.twoSidedFoliage === true;
}

/** The tangent of the source angle a receiver sees: a leaf receiver sees at least 5 degrees. */
export function receiverSourceTangent(
  material: Parameters<typeof isLeafReceiver>[0],
  tangent: number,
): number {
  return isLeafReceiver(material) ? Math.max(tangent, LEAF_MIN_SOURCE_TANGENT) : tangent;
}

/** World-space gap to UV radius; sourceAngleRad is in radians, in [0, PI/2). */
export function penumbraUv(
  gapMetres: number,
  sourceAngleRad: number,
  frustumWidthMetres: number,
  mapSize: number,
): number {
  for (const [name, value] of Object.entries({
    gapMetres,
    sourceAngleRad,
    frustumWidthMetres,
    mapSize,
  })) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${name} must be finite and non-negative`);
  }
  if (sourceAngleRad >= Math.PI / 2 || frustumWidthMetres === 0 || mapSize === 0) {
    throw new RangeError("angle must be < PI/2; frustum width and map size must be positive");
  }
  return Math.max(1 / mapSize, (gapMetres * Math.tan(sourceAngleRad)) / frustumWidthMetres);
}

/**
 * The caster gap that Unreal's shadow-map ray test sees (PRD-634). Each ray runs `rayLengthScale` times the
 * receiver's view distance toward the light, sampled `samplesPerRay` times at squared steps from a random
 * start, far end first. It counts as blocked only when its first sample under the caster lies inside the
 * caster's silhouette, so the edge spreads by that sample's distance and not by the caster's: this is that
 * distance, averaged over the random start. 0 samples keeps the gap as it is.
 * UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapSMRTTemplate.ush:41-130 (the sample
 * times and the hit test), VirtualShadowMapProjectionDirectional.ush:230 (the ray length),
 * Engine/Config/BaseScalability.ini:263 (4 samples per ray at Epic),
 * Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:760 (the 1.5 scale).
 */
export function shadowRayOccluderGap(
  gap: number,
  viewDistance: number,
  samplesPerRay: number,
  rayLengthScale: number,
): number {
  if (samplesPerRay === 0) return gap;
  const reach = rayLengthScale * viewDistance;
  const x = reach > 0 ? Math.min(1, Math.sqrt(gap / reach)) : 1;
  const n = samplesPerRay;
  return reach * (x >= 1 / n ? x * x - x / n + 1 / (3 * n * n) : (n * x ** 3) / 3);
}

export interface ISourceAngleShadowOptions {
  /** Required game-owned angular radius in radians, in [0, PI/2). No default. */
  sourceAngleRad: number;
  /** Fixed sample count, integer 1–64; default 16. Recreate the filter to change it. */
  blockerSamples?: number;
  /** Fixed sample count, integer 1–64; default 16. */
  filterSamples?: number;
  /**
   * The receiver's own pixel, this many times over, blurs the edge on top of the source angle (the two add as
   * the blur of two independent sources), so a contact edge is not a one-texel step that crawls as the camera
   * moves. Unreal's sharpest sun-shadow edge is about a pixel wide (its texel dither and temporal resolve).
   * Finite, in [0, 16]; default 0, which leaves the source angle alone.
   */
  minPenumbraPixels?: number;
  /**
   * Unreal's shadow-map ray samples (`r.Shadow.Virtual.SMRT.SamplesPerRayDirectional`, 4 at Epic): the edge
   * spreads from the caster gap that the ray test sees (`shadowRayOccluderGap`). Integer 0–64; default 4.
   * 0 is the override that spreads the edge by the full geometric gap.
   */
  samplesPerRay?: number;
  /** The ray's length over the receiver's view distance (`r.Shadow.Virtual.SMRT.RayLengthScaleDirectional`); default 1.5. */
  rayLengthScale?: number;
}

/** The object passed by three r185 ShadowNode.setupShadowFilter. */
export interface ISourceAngleShadowInputs {
  depthTexture: DepthTexture;
  shadowCoord: Node<"vec3">;
  shadow: LightShadow;
  depthLayer?: number;
}

/**
 * Blocker search followed by variable-radius PCF for orthographic directional shadows.
 * Camera bounds, zoom, near/far and mapSize are live references. Use a depth shadow map,
 * not VSM. Both ordinary and reversed depth comparisons are supported.
 * Ideas only: Unreal Engine/Shaders/Private/ShadowPercentageCloserFiltering.ush,
 * DirectionalPCSS (blocker average and source-angle gap); independently written TSL.
 */
export function sourceAngleShadowFilter({
  sourceAngleRad,
  blockerSamples = 16,
  filterSamples = 16,
  minPenumbraPixels = 0,
  samplesPerRay = 4,
  rayLengthScale = 1.5,
}: ISourceAngleShadowOptions): (inputs: ISourceAngleShadowInputs) => Node<"float"> {
  penumbraUv(0, sourceAngleRad, 1, 1);
  for (const count of [blockerSamples, filterSamples]) {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new RangeError("shadow sample counts must be integers in [1, 64]");
    }
  }
  if (!Number.isFinite(minPenumbraPixels) || minPenumbraPixels < 0 || minPenumbraPixels > 16)
    throw new RangeError("minPenumbraPixels must be finite and in [0, 16]");
  if (!Number.isInteger(samplesPerRay) || samplesPerRay < 0 || samplesPerRay > 64)
    throw new RangeError("samplesPerRay must be an integer in [0, 64]");
  if (!Number.isFinite(rayLengthScale) || rayLengthScale <= 0)
    throw new RangeError("rayLengthScale must be finite and positive");
  const tangent = Math.tan(sourceAngleRad);
  const disk = (index: number, count: number) => {
    const radius = Math.sqrt((index + 0.5) / count);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return vec2(radius * Math.cos(angle), radius * Math.sin(angle));
  };
  const filter = ({
    depthTexture,
    shadowCoord,
    shadow,
    depthLayer = 0,
  }: ISourceAngleShadowInputs) => {
    const camera = shadow.camera as OrthographicCamera;
    if (camera.isOrthographicCamera !== true) {
      throw new RangeError("source-angle shadows require an orthographic shadow camera");
    }
    penumbraUv(0, sourceAngleRad, (camera.right - camera.left) / camera.zoom, shadow.mapSize.x);
    penumbraUv(0, sourceAngleRad, (camera.top - camera.bottom) / camera.zoom, shadow.mapSize.y);
    if (
      !Number.isFinite(camera.near) ||
      camera.near < 0 ||
      !Number.isFinite(camera.far) ||
      camera.far <= camera.near
    ) {
      throw new RangeError("shadow camera requires finite 0 <= near < far");
    }
    if (!Number.isFinite(camera.zoom) || camera.zoom <= 0)
      throw new RangeError("shadow camera zoom must be positive and finite");
    if (
      depthTexture.compareFunction !== LessEqualCompare &&
      depthTexture.compareFunction !== GreaterEqualCompare
    )
      throw new RangeError("source-angle shadows require a comparison depth texture, not VSM");
    const reversed = depthTexture.compareFunction === GreaterEqualCompare;
    const size = reference("mapSize", "vec2", shadow);
    const near = reference("near", "float", camera);
    const range = reference("far", "float", camera).sub(near);
    const span = vec2(
      reference("right", "float", camera).sub(reference("left", "float", camera)),
      reference("top", "float", camera).sub(reference("bottom", "float", camera)),
    ).div(reference("zoom", "float", camera));
    const texel = vec2(1).div(size);
    const isArray = "isArrayTexture" in depthTexture && depthTexture.isArrayTexture === true;
    const withLayer = (sample: ReturnType<typeof texture>) =>
      isArray ? sample.depth(float(depthLayer)) : sample;
    const linearDepth = (depth: Node<"float">) => (reversed ? depth.oneMinus() : depth);
    return Fn(
      (_inputs: unknown, builder: { readonly material?: Parameters<typeof isLeafReceiver>[0] }) => {
        // A receiver marked twoSidedFoliage sees the sun at 5 degrees at least; the node is built per material.
        const reach = receiverSourceTangent(builder.material, tangent);
        const receiver = linearDepth(shadowCoord.z);
        // Near-plane distance bounds the largest possible caster/receiver gap.
        const searchRadius = max(texel, vec2(receiver.mul(range).mul(reach)).div(span)).toVar();
        const blockerSum = float(0).toVar();
        const blockerCount = float(0).toVar();
        // Integer loads read raw depth without interpolated blockers. Both loops load: three r185
        // gives a depth texture one sampler binding, typed by the first node that registers it, so
        // a load followed by `.compare()` emitted a plain sampler and failed to compile.
        const load = (uv: Node<"vec2">) =>
          linearDepth(
            withLayer(
              textureLoad(
                depthTexture,
                ivec2(min(max(uv.mul(size).floor(), vec2(0)), size.sub(1))),
              ),
            ).r,
          );
        for (let index = 0; index < blockerSamples; index++) {
          const depth = load(
            shadowCoord.xy.add(disk(index, blockerSamples).mul(searchRadius)),
          ).toVar();
          If(depth.lessThan(receiver), () => {
            blockerSum.addAssign(depth);
            blockerCount.addAssign(1);
          });
        }
        const blockerGap = max(0, receiver.sub(blockerSum.div(max(blockerCount, 1)))).mul(range);
        // shadowRayOccluderGap, per receiver.
        const n = samplesPerRay;
        const rayReach = positionWorld.distance(cameraPosition).mul(rayLengthScale);
        const x = min(1, sqrt(blockerGap.div(max(rayReach, 1e-6))));
        const gap =
          n === 0
            ? blockerGap
            : rayReach.mul(
                x.greaterThanEqual(1 / n).select(
                  x
                    .mul(x)
                    .sub(x.div(n))
                    .add(1 / (3 * n * n)),
                  x
                    .mul(x)
                    .mul(x)
                    .mul(n / 3),
                ),
              );
        const penumbra = vec2(gap.mul(reach)).div(span);
        // The receiver's pixel in this map's uv, per axis (the length of its two screen steps together), as
        // many times as `minPenumbraPixels` asks for, and at most 16 texels: the steps of a quad that straddles
        // a silhouette are the distance between two surfaces.
        const stepX = dFdx(shadowCoord.xy);
        const stepY = dFdy(shadowCoord.xy);
        const pixels = min(
          sqrt(stepX.mul(stepX).add(stepY.mul(stepY))).mul(minPenumbraPixels),
          texel.mul(16),
        );
        const radius = max(
          texel,
          minPenumbraPixels === 0 ? penumbra : sqrt(penumbra.mul(penumbra).add(pixels.mul(pixels))),
        ).toVar();
        const visibility = float(0).toVar();
        for (let index = 0; index < filterSamples; index++) {
          const depth = load(shadowCoord.xy.add(disk(index, filterSamples).mul(radius)));
          visibility.addAssign(step(receiver, depth));
        }
        return blockerCount.greaterThan(0).select(visibility.div(filterSamples), float(1));
      },
    )();
  };
  // Native virtual maps translate the same filter parameters into atlas-aware depth loads.
  return Object.assign(filter, {
    [Symbol.for("threenative.sourceAngleShadowFilter")]: Object.freeze({
      sourceAngleRad,
      blockerSamples,
      filterSamples,
      minPenumbraPixels,
      samplesPerRay,
      rayLengthScale,
    }),
  });
}

/**
 * A lamp's penumbra radius in tangent units (offset over distance) at the receiver: the disk of
 * `sourceRadius` metres seen past a blocker at `blockerDistance` from a receiver at `receiverDistance`.
 * Times the receiver distance it is the penumbra's world radius, linear in the caster gap and the radius.
 */
export function lampPenumbraTangent(
  sourceRadius: number,
  blockerDistance: number,
  receiverDistance: number,
): number {
  if (!Number.isFinite(sourceRadius) || sourceRadius < 0)
    throw new RangeError("sourceRadius must be finite and non-negative");
  if (!(blockerDistance > 0) || !(receiverDistance > 0) || !Number.isFinite(receiverDistance))
    throw new RangeError("blocker and receiver distances must be positive and finite");
  return sourceRadius * Math.max(0, 1 / blockerDistance - 1 / receiverDistance);
}

export interface ISourceRadiusShadowOptions {
  /** Required game-owned lamp radius in metres (Unreal's SourceRadius); 0 is one hard tap. */
  sourceRadius: number;
  /** Fixed sample count, integer 1–64; default 16. Recreate the filter to change it. */
  blockerSamples?: number;
  /** Fixed sample count, integer 1–64; default 16. */
  filterSamples?: number;
  /**
   * The share of the geometric penumbra the lamp keeps, in (0, 4]; default `LAMP_PENUMBRA_SCALE`.
   * 1 is the width a disk lamp throws; Unreal's shadow-map ray test samples each ray a few times and
   * resolves about 0.6 of it at its Epic counts.
   */
  penumbraScale?: number;
}

/**
 * The default `penumbraScale`. Unreal 5.8.3's local-light ray test (8 rays, 4 samples each at Epic) misses
 * the thin end of a penumbra: measured against a geometric disk lamp it keeps 0.47 to 0.69 of the width on
 * the calibration scenes (`lamp-room`, `cornell`), and a simulation of the test at those counts averages 0.6.
 */
export const LAMP_PENUMBRA_SCALE = 0.6;

/** A spot light's filter inputs (ShadowNode), or a point light's (PointShadowNode: `bd3D`, `dp`). */
export interface ISourceRadiusShadowInputs extends ISourceAngleShadowInputs {
  bd3D?: Node<"vec3">;
  dp?: Node<"float">;
}

/**
 * Blocker search followed by variable-radius PCF for a spot light's map or a point light's cube: the
 * penumbra is `penumbraScale * lampPenumbraTangent` at the average blocker that shades the receiver, at
 * least half a texel. The search runs `blockerPasses` times: the nearest blocker in a cone has the widest
 * penumbra and every blocker that shades the receiver lies inside it, so the cone shrinks to that penumbra;
 * the last cone averages only the blockers whose own penumbra reaches the receiver, so a volume's far
 * faces, a wall's own texels and a nearer object off to the side never pull the width. A texel is a blocker
 * only when it is nearer than the receiver's own plane (read from the screen derivatives), so a tilted wall
 * that the lamp sees nearer on one side never shades itself, and the filter compares each tap against
 * that plane too. The receiver's own ray is a tap of every cone and always counts when it is blocked, since
 * it lies inside the lamp's disk: a back-face map stores a box's far face within centimetres of the floor
 * behind it, and a thin rod falls between the taps. A receiver no blocker reaches is lit. Distances are
 * along the receiver's ray, so a cube's faces agree: a face stores the depth along its own axis.
 * The spot map reads raw depth like `sourceAngleShadowFilter`. A cube has no integer load in WGSL and
 * three r185 gives a depth texture one sampler, so the point light's search compares each tap at four
 * depths between the light and the plane and takes the blocker from the step where it turns dark.
 * Ideas only: Unreal VirtualShadowMapProjectionSpot.ush (rays in a cone of SourceRadius / distance);
 * independently written TSL. The owned engine reads the cube's raw depths instead.
 */
export function sourceRadiusShadowFilter({
  sourceRadius,
  blockerSamples = 16,
  filterSamples = 16,
  penumbraScale = LAMP_PENUMBRA_SCALE,
}: ISourceRadiusShadowOptions): (inputs: ISourceRadiusShadowInputs) => Node<"float"> {
  lampPenumbraTangent(sourceRadius, 1, 1);
  if (!Number.isFinite(penumbraScale) || penumbraScale <= 0 || penumbraScale > 4)
    throw new RangeError("penumbraScale must be in (0, 4]");
  for (const count of [blockerSamples, filterSamples]) {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new RangeError("shadow sample counts must be integers in [1, 64]");
    }
  }
  const levels = 4;
  // ponytail: two passes, as on the owned engine; a third moved the edge by under 3 % in the wall test.
  const blockerPasses = 2;
  const disk = (index: number, count: number) => {
    const radius = Math.sqrt((index + 0.5) / count);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return vec2(radius * Math.cos(angle), radius * Math.sin(angle));
  };
  const filter = ({ depthTexture, shadowCoord, shadow, bd3D, dp }: ISourceRadiusShadowInputs) => {
    const camera = shadow.camera as PerspectiveCamera;
    if (camera.isPerspectiveCamera !== true)
      throw new RangeError(
        "source-radius shadows require a spot or point light's perspective camera",
      );
    if (depthTexture.compareFunction !== LessEqualCompare)
      throw new RangeError("source-radius shadows require a forward-depth comparison texture");
    const near = reference("near", "float", camera);
    const far = reference("far", "float", camera);
    const size = reference("mapSize", "vec2", shadow).x;
    // A [0, 1] perspective depth and its view depth.
    const distanceOf = (depth: Node<"float">) =>
      near.mul(far).div(far.sub(depth.mul(far.sub(near))));
    const depthOf = (distance: Node<"float">) =>
      far.mul(distance.sub(near)).div(distance.mul(far.sub(near)));
    const radius = float(sourceRadius);
    // The lamp's disk seen past a blocker, in tangent units: the penumbra's radius at the receiver.
    const spreadOf = (blocker: Node<"float">, receiver: Node<"float">) =>
      radius.mul(max(0, float(1).div(blocker).sub(float(1).div(receiver))));
    const penumbraOf = (blocker: Node<"float">, receiver: Node<"float">, texel: Node<"float">) =>
      sourceRadius === 0
        ? float(0)
        : max(texel.mul(0.5), spreadOf(blocker, receiver).mul(penumbraScale));
    // ponytail: the search cone is cut at 0.5 tangent (27 degrees), as on the owned engine.
    const searchOf = (receiver: Node<"float">) => min(0.5, spreadOf(near, receiver));
    // d(distance) / d(tap offset): the 2x2 solve of the distance's screen derivatives against those of
    // the tap coordinates. Called in uniform control flow, before any branch.
    const slopeOf = (
      jx: Node<"vec2">,
      jy: Node<"vec2">,
      distance: Node<"float">,
      scale: Node<"float">,
    ) => {
      const [rx, ry] = [dFdx(distance), dFdy(distance)];
      const det = jx.x.mul(jy.y).sub(jx.y.mul(jy.x));
      const flat = det.abs().lessThan(1e-12);
      const safe = flat.select(float(1), det);
      return vec2(
        rx.mul(jy.y).sub(jx.y.mul(ry)).div(safe),
        jx.x.mul(ry).sub(jy.x.mul(rx)).div(safe),
      )
        .mul(flat.select(float(0), scale))
        .toVar();
    };
    if (bd3D && dp) {
      const absDir = bd3D.abs();
      const tangent = cross(
        bd3D,
        absDir.x.greaterThan(absDir.z).select(vec3(0, 1, 0), vec3(1, 0, 0)),
      ).normalize();
      const bitangent = cross(bd3D, tangent);
      // A depth compare answers a float; three's types call every texture read a vec4.
      const tap = (offset: Node<"vec2">, reference: Node<"float">) =>
        cubeTexture(
          depthTexture as unknown as CubeTexture,
          bd3D.add(tangent.mul(offset.x).add(bitangent.mul(offset.y))),
        ).compare(reference) as unknown as Node<"float">;
      // The depth along a tap's cube face over the distance along its ray: the ray's largest component
      // over its length.
      const axialPerEuclid = (offset: Node<"vec2">) => {
        const ray = bd3D.add(tangent.mul(offset.x).add(bitangent.mul(offset.y))).abs();
        return max(max(ray.x, ray.y), ray.z).div(
          bd3D.add(tangent.mul(offset.x).add(bitangent.mul(offset.y))).length(),
        );
      };
      return Fn(() => {
        const receiver = distanceOf(dp)
          .div(axialPerEuclid(vec2(0, 0)))
          .toVar();
        const slope = slopeOf(
          vec2(dFdx(bd3D).dot(tangent), dFdx(bd3D).dot(bitangent)),
          vec2(dFdy(bd3D).dot(tangent), dFdy(bd3D).dot(bitangent)),
          receiver,
          float(1),
        );
        // The receiver's plane at a tap offset as a distance along the tap's ray, and as the depth along its face.
        const planeDistance = (offset: Node<"vec2">) =>
          max(0, receiver.add(slope.x.mul(offset.x)).add(slope.y.mul(offset.y)));
        const planeAxial = (offset: Node<"vec2">) =>
          max(planeDistance(offset).mul(axialPerEuclid(offset)), near);
        const visibility = float(1).toVar();
        const cone = searchOf(receiver).toVar();
        // One search cone: how many blockers, their summed distance, and the nearest. The last cone counts only
        // the texels whose own penumbra reaches the receiver, and the receiver's own ray, which is inside the
        // lamp's disk whatever the blocker's reach.
        const blockerAt = (offset: Node<"vec2">) => {
          const plane = planeAxial(offset);
          const blocked = tap(offset, depthOf(plane)).oneMinus().toVar();
          // Darker at more of the levels: the blocker is nearer the light.
          let steps: Node<"float"> = float(0);
          for (let level = 1; level <= levels; level++)
            steps = steps.add(tap(offset, depthOf(plane.mul(level / (levels + 1)))).oneMinus());
          const blocker = plane
            .mul(float(levels + 0.5).sub(steps))
            .div(levels + 1)
            .div(axialPerEuclid(offset));
          return { blocked, blocker };
        };
        const search = (last: boolean) => {
          const sum = float(0).toVar();
          const count = float(0).toVar();
          const nearest = float(1e30).toVar();
          const visit = (offset: Node<"vec2">, own: boolean) => {
            const { blocked, blocker } = blockerAt(offset);
            const reaches = offset.length().lessThanEqual(spreadOf(blocker, planeDistance(offset)));
            const weight = last && !own ? reaches.select(blocked, float(0)) : blocked;
            sum.addAssign(weight.mul(blocker));
            count.addAssign(weight);
            nearest.assign(blocked.greaterThan(0.5).select(min(nearest, blocker), nearest));
          };
          visit(vec2(0, 0), true);
          for (let tapIndex = 0; tapIndex < blockerSamples; tapIndex++)
            visit(disk(tapIndex, blockerSamples).mul(cone), false);
          return { sum, count, nearest };
        };
        const pass = (index: number) => {
          const last = index + 1 === blockerPasses;
          const { sum, count, nearest } = search(last);
          If(count.greaterThan(0), () => {
            if (!last) {
              cone.assign(min(cone, spreadOf(nearest, receiver)));
              pass(index + 1);
              return;
            }
            const blocker = sum.div(count);
            const penumbra = penumbraOf(blocker, receiver, float(2).div(size)).toVar();
            let lit: Node<"float"> = float(0);
            for (let tapIndex = 0; tapIndex < filterSamples; tapIndex++) {
              const offset = disk(tapIndex, filterSamples).mul(penumbra);
              lit = lit.add(tap(offset, depthOf(planeAxial(offset))));
            }
            visibility.assign(lit.div(filterSamples));
          });
        };
        pass(0);
        return visibility;
      })();
    }
    const tanHalf = uniform(1).onRenderUpdate(
      () => Math.tan((camera.fov * Math.PI) / 360) / camera.zoom,
    );
    const uvPerTangent = float(0.5).div(tanHalf);
    const sizes = vec2(size);
    const load = (uv: Node<"vec2">) =>
      textureLoad(depthTexture, ivec2(min(max(uv.mul(sizes).floor(), vec2(0)), sizes.sub(1)))).r;
    return Fn(() => {
      const receiver = distanceOf(shadowCoord.z).toVar();
      const slope = slopeOf(dFdx(shadowCoord.xy), dFdy(shadowCoord.xy), receiver, uvPerTangent);
      // The receiver's plane at a tap offset, as a distance and as a [0, 1] depth.
      const planeDistance = (offset: Node<"vec2">) =>
        max(near, receiver.add(slope.x.mul(offset.x)).add(slope.y.mul(offset.y)));
      const planeDepth = (offset: Node<"vec2">) => depthOf(planeDistance(offset));
      const visibility = float(1).toVar();
      const cone = searchOf(receiver).toVar();
      const pass = (index: number) => {
        const last = index + 1 === blockerPasses;
        const sum = float(0).toVar();
        const count = float(0).toVar();
        const nearest = float(1e30).toVar();
        const visit = (offset: Node<"vec2">, own: boolean) => {
          const depth = load(shadowCoord.xy.add(offset.mul(uvPerTangent))).toVar();
          If(depth.lessThan(planeDepth(offset)), () => {
            const blocker = distanceOf(depth);
            if (!last) {
              nearest.assign(min(nearest, blocker));
              count.addAssign(1);
              return;
            }
            const shade = () => {
              sum.addAssign(blocker);
              count.addAssign(1);
            };
            // The receiver's own ray is inside the lamp's disk; any other texel shades the receiver only
            // when its own penumbra reaches it.
            if (own) shade();
            else If(offset.length().lessThanEqual(spreadOf(blocker, planeDistance(offset))), shade);
          });
        };
        visit(vec2(0, 0), true);
        for (let tapIndex = 0; tapIndex < blockerSamples; tapIndex++)
          visit(disk(tapIndex, blockerSamples).mul(cone), false);
        If(count.greaterThan(0), () => {
          if (!last) {
            cone.assign(min(cone, spreadOf(nearest, receiver)));
            pass(index + 1);
            return;
          }
          const blocker = sum.div(count);
          const penumbra = penumbraOf(blocker, receiver, tanHalf.mul(2).div(size)).toVar();
          const lit = float(0).toVar();
          for (let tapIndex = 0; tapIndex < filterSamples; tapIndex++) {
            const offset = disk(tapIndex, filterSamples).mul(penumbra);
            lit.addAssign(
              step(planeDepth(offset), load(shadowCoord.xy.add(offset.mul(uvPerTangent)))),
            );
          }
          visibility.assign(lit.div(filterSamples));
        });
      };
      pass(0);
      return visibility;
    })();
  };
  // The owned engine reads the same parameters from this tag (a lamp's filterNode).
  return Object.assign(filter, {
    [Symbol.for("threenative.sourceRadiusShadowFilter")]: Object.freeze({
      sourceRadius,
      blockerSamples,
      filterSamples,
      penumbraScale,
    }),
  });
}
