import {
  type DepthTexture,
  GreaterEqualCompare,
  LessEqualCompare,
  type LightShadow,
  type OrthographicCamera,
} from "three";
import {
  Fn,
  If,
  float,
  ivec2,
  max,
  min,
  reference,
  step,
  type texture,
  textureLoad,
  vec2,
} from "three/tsl";
import type { Node } from "three/webgpu";

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
}: ISourceAngleShadowOptions): (inputs: ISourceAngleShadowInputs) => Node<"float"> {
  penumbraUv(0, sourceAngleRad, 1, 1);
  for (const count of [blockerSamples, filterSamples]) {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new RangeError("shadow sample counts must be integers in [1, 64]");
    }
  }
  const tangent = Math.tan(sourceAngleRad);
  const disk = (index: number, count: number) => {
    const radius = Math.sqrt((index + 0.5) / count);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return vec2(radius * Math.cos(angle), radius * Math.sin(angle));
  };
  return ({ depthTexture, shadowCoord, shadow, depthLayer = 0 }) => {
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
    return Fn(() => {
      const receiver = linearDepth(shadowCoord.z);
      // Near-plane distance bounds the largest possible caster/receiver gap.
      const searchRadius = max(texel, vec2(receiver.mul(range).mul(tangent)).div(span)).toVar();
      const blockerSum = float(0).toVar();
      const blockerCount = float(0).toVar();
      // Integer loads read raw depth without interpolated blockers. Both loops load: three r185
      // gives a depth texture one sampler binding, typed by the first node that registers it, so
      // a load followed by `.compare()` emitted a plain sampler and failed to compile.
      const load = (uv: Node<"vec2">) =>
        linearDepth(
          withLayer(
            textureLoad(depthTexture, ivec2(min(max(uv.mul(size).floor(), vec2(0)), size.sub(1)))),
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
      const radius = max(texel, vec2(gap.mul(tangent)).div(span)).toVar();
      const visibility = float(0).toVar();
      for (let index = 0; index < filterSamples; index++) {
        const depth = load(shadowCoord.xy.add(disk(index, filterSamples).mul(radius)));
        visibility.addAssign(step(receiver, depth));
      }
      return blockerCount.greaterThan(0).select(visibility.div(filterSamples), float(1));
    })();
  };
}
