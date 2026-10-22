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
  cross,
  cubeTexture,
  dFdx,
  dFdy,
  float,
  ivec2,
  max,
  min,
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
}: ISourceAngleShadowOptions): (inputs: ISourceAngleShadowInputs) => Node<"float"> {
  penumbraUv(0, sourceAngleRad, 1, 1);
  for (const count of [blockerSamples, filterSamples]) {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new RangeError("shadow sample counts must be integers in [1, 64]");
    }
  }
  if (!Number.isFinite(minPenumbraPixels) || minPenumbraPixels < 0 || minPenumbraPixels > 16)
    throw new RangeError("minPenumbraPixels must be finite and in [0, 16]");
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
        const gap = max(0, receiver.sub(blockerSum.div(max(blockerCount, 1)))).mul(range);
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
}

/** A spot light's filter inputs (ShadowNode), or a point light's (PointShadowNode: `bd3D`, `dp`). */
export interface ISourceRadiusShadowInputs extends ISourceAngleShadowInputs {
  bd3D?: Node<"vec3">;
  dp?: Node<"float">;
}

/**
 * Blocker search followed by variable-radius PCF for a spot light's map or a point light's cube: the
 * penumbra is `lampPenumbraTangent` at the average blocker, at least half a texel. The spot map reads
 * raw depth like `sourceAngleShadowFilter`. A cube has no integer load in WGSL and three r185 gives a
 * depth texture one sampler, so the point light's search compares each tap at four depths between
 * the light and the receiver and takes the blocker from the step where it turns dark.
 * Ideas only: Unreal VirtualShadowMapProjectionSpot.ush (rays in a cone of SourceRadius / distance);
 * independently written TSL. The owned engine reads the cube's raw depths instead.
 */
export function sourceRadiusShadowFilter({
  sourceRadius,
  blockerSamples = 16,
  filterSamples = 16,
}: ISourceRadiusShadowOptions): (inputs: ISourceRadiusShadowInputs) => Node<"float"> {
  lampPenumbraTangent(sourceRadius, 1, 1);
  for (const count of [blockerSamples, filterSamples]) {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new RangeError("shadow sample counts must be integers in [1, 64]");
    }
  }
  const levels = 4;
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
    const penumbraOf = (blocker: Node<"float">, receiver: Node<"float">, texel: Node<"float">) =>
      sourceRadius === 0
        ? float(0)
        : max(
            texel.mul(0.5),
            radius.mul(max(0, float(1).div(blocker).sub(float(1).div(receiver)))),
          );
    // ponytail: the search cone is cut at 0.5 tangent (27 degrees), as on the owned engine.
    const searchOf = (receiver: Node<"float">) =>
      min(0.5, radius.mul(float(1).div(near).sub(float(1).div(receiver))));
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
      return Fn(() => {
        const receiver = distanceOf(dp).toVar();
        const search = searchOf(receiver);
        const blockerSum = float(0).toVar();
        const blockerCount = float(0).toVar();
        for (let index = 0; index < blockerSamples; index++) {
          const offset = disk(index, blockerSamples).mul(search);
          const blocked = tap(offset, dp).oneMinus().toVar();
          // Darker at more of the levels: the blocker is nearer the light.
          let steps: Node<"float"> = float(0);
          for (let level = 1; level <= levels; level++) {
            const at = depthOf(receiver.mul(level / (levels + 1)));
            steps = steps.add(tap(offset, at).oneMinus());
          }
          const blocker = receiver.mul(float(levels + 0.5).sub(steps)).div(levels + 1);
          blockerSum.addAssign(blocked.mul(blocker));
          blockerCount.addAssign(blocked);
        }
        const visibility = float(1).toVar();
        If(blockerCount.greaterThan(0), () => {
          const penumbra = penumbraOf(
            blockerSum.div(blockerCount),
            receiver,
            float(2).div(size),
          ).toVar();
          let sum: Node<"float"> = float(0);
          for (let index = 0; index < filterSamples; index++)
            sum = sum.add(tap(disk(index, filterSamples).mul(penumbra), dp));
          visibility.assign(sum.div(filterSamples));
        });
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
      const reference = shadowCoord.z;
      const receiver = distanceOf(reference).toVar();
      const search = searchOf(receiver).mul(uvPerTangent);
      const blockerSum = float(0).toVar();
      const blockerCount = float(0).toVar();
      for (let index = 0; index < blockerSamples; index++) {
        const depth = load(shadowCoord.xy.add(disk(index, blockerSamples).mul(search))).toVar();
        If(depth.lessThan(reference), () => {
          blockerSum.addAssign(depth);
          blockerCount.addAssign(1);
        });
      }
      const visibility = float(1).toVar();
      If(blockerCount.greaterThan(0), () => {
        const blocker = distanceOf(blockerSum.div(blockerCount));
        const texel = tanHalf.mul(2).div(size);
        const penumbra = penumbraOf(blocker, receiver, texel).mul(uvPerTangent).toVar();
        const sum = float(0).toVar();
        for (let index = 0; index < filterSamples; index++)
          sum.addAssign(
            step(reference, load(shadowCoord.xy.add(disk(index, filterSamples).mul(penumbra)))),
          );
        visibility.assign(sum.div(filterSamples));
      });
      return visibility;
    })();
  };
  // The owned engine reads the same parameters from this tag (a lamp's filterNode).
  return Object.assign(filter, {
    [Symbol.for("threenative.sourceRadiusShadowFilter")]: Object.freeze({
      sourceRadius,
      blockerSamples,
      filterSamples,
    }),
  });
}
