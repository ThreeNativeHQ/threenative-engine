// The integrator: what one bounded volume does to one pixel, marching `steps` equal slices
// between the depth-correct entry and exit of the camera ray. Everything it reads arrives on
// `inputs`, so the uniforms that describe the camera, the bounds and the lights stay with the
// graph that owns them.
import type { DepthTexture, DirectionalLight, PointLight } from "three";
import {
  Fn,
  If,
  Loop,
  float,
  getViewPosition,
  lightShadowMatrix,
  max,
  min,
  type pass,
  reference,
  screenUV,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";

export type ScenePass = ReturnType<typeof pass>;
type FogDepth = ReturnType<ScenePass["getTextureNode"]>;
export interface IFogBounds {
  low: Node<"vec3">;
  high: Node<"vec3">;
  /** Extinction per metre at/below baseHeight, independent of light intensity. */
  density: number;
  baseHeight: number;
  heightFalloff: number;
}
export interface IFogLocalLight {
  point: PointLight;
  radiance: Node<"vec3">;
  position: Node<"vec3">;
}
export interface IFogTransportInputs {
  albedo: Node<"vec3">;
  ambient: Node<"vec3">;
  anisotropy: number;
  bounds: IFogBounds[];
  cameraMatrix: Node<"mat4">;
  depth: FogDepth;
  inverseProjection: Node<"mat4">;
  localLights: IFogLocalLight[];
  origin: Node<"vec3">;
  shadowDepth: DepthTexture | null | undefined;
  steps: number;
  sun: DirectionalLight | undefined;
  sunDirection: Node<"vec3"> | undefined;
  sunRadiance: Node<"vec3"> | undefined;
}

export function fogTransport(inputs: IFogTransportInputs): Node<"vec4"> {
  const {
    albedo,
    ambient,
    anisotropy,
    bounds,
    cameraMatrix,
    depth,
    inverseProjection,
    localLights,
    origin,
    shadowDepth,
    steps,
    sun,
    sunDirection,
    sunRadiance,
  } = inputs;
  const phase = (cosine: Node<"float">) =>
    float(1 - anisotropy ** 2).div(
      float(1 + anisotropy ** 2)
        .sub(cosine.mul(2 * anisotropy))
        .pow(1.5)
        .mul(4 * Math.PI),
    );
  return Fn(() => {
    const endpoint = cameraMatrix.mul(
      vec4(getViewPosition(screenUV, depth.r, inverseProjection), 1),
    ).xyz;
    const toSurface = endpoint.sub(origin).toVar();
    const distance = toSurface.length().max(0.000001).toVar();
    const direction = toSurface.div(distance).toVar();
    const safeDirection = direction
      .greaterThanEqual(0)
      .select(direction.abs().max(0.000001), direction.abs().max(0.000001).negate());
    const near = distance.toVar();
    const far = float(0).toVar();
    for (const volume of bounds) {
      const a = volume.low.sub(origin).div(safeDirection);
      const b = volume.high.sub(origin).div(safeDirection);
      const entry = min(a, b);
      const exit = max(a, b);
      const start = max(max(entry.x, entry.y), max(entry.z, 0));
      const end = min(min(exit.x, exit.y), min(exit.z, distance));
      If(end.greaterThan(start), () => {
        near.assign(min(near, start));
        far.assign(max(far, end));
      });
    }
    const transmission = float(1).toVar();
    const scattering = vec3(0).toVar();
    If(far.greaterThan(near), () => {
      const ds = far.sub(near).div(steps).toVar();
      Loop(steps, ({ i }) => {
        const position = origin.add(direction.mul(near.add(float(i).add(0.5).mul(ds)))).toVar();
        const extinction = float(0).toVar();
        for (const volume of bounds) {
          If(
            position
              .greaterThanEqual(volume.low)
              .all()
              .and(position.lessThanEqual(volume.high).all()),
            () => {
              extinction.addAssign(
                position.y
                  .sub(volume.baseHeight)
                  .max(0)
                  .mul(-volume.heightFalloff)
                  .exp()
                  .mul(volume.density),
              );
            },
          );
        }
        const illumination = vec3(ambient).toVar();
        if (
          sun !== undefined &&
          shadowDepth != null &&
          sunDirection !== undefined &&
          sunRadiance !== undefined
        ) {
          const projected = lightShadowMatrix(sun).mul(vec4(position, 1));
          const coordinate = projected.xyz.div(projected.w).toVar();
          // Outside the finite shadow map, Three treats the directional source as unshadowed.
          const visibility = float(1).toVar();
          If(coordinate.greaterThanEqual(0).all().and(coordinate.lessThanEqual(1).all()), () => {
            visibility.assign(
              texture(shadowDepth, vec2(coordinate.x, coordinate.y.oneMinus())).compare(
                coordinate.z.add(reference("bias", "float", sun.shadow)),
              ),
            );
          });
          illumination.addAssign(
            sunRadiance.mul(phase(direction.dot(sunDirection))).mul(visibility),
          );
        }
        for (const local of localLights) {
          const toLight = local.position.sub(position);
          const radius = toLight.length().max(0.01);
          const attenuation = radius
            .div(local.point.distance)
            .pow(4)
            .oneMinus()
            .max(0)
            .pow(2)
            .div(radius.pow(local.point.decay));
          illumination.addAssign(
            local.radiance.mul(attenuation).mul(phase(direction.dot(toLight.div(radius)))),
          );
        }
        // Exact homogeneous-step solution. Extinction persists when every light is off.
        const stepTransmission = extinction.mul(ds).negate().exp();
        scattering.addAssign(
          transmission.mul(stepTransmission.oneMinus()).mul(albedo).mul(illumination),
        );
        transmission.mulAssign(stepTransmission);
      });
    });
    return vec4(scattering, transmission);
  })();
}
