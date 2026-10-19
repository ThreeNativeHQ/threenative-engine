// The volume graph: what the camera, the bounds and the lights are each frame, plus the target
// the transport is rendered into and the one screen-space sample that reads it back. It owns that
// target and its material; the controller that owns this graph disposes both.
import {
  type DirectionalLight,
  HalfFloatType,
  NearestFilter,
  type PerspectiveCamera,
  type PointLight,
  Vector3,
} from "three";
import { Fn, If, float, getViewPosition, max, rtt, screenUV, uniform, vec2, vec4 } from "three/tsl";
import type { Node, NodeMaterial, RenderTarget } from "three/webgpu";
import type { IFogVolume, IVolumetricFogOptions } from "./volumetricFogOptions.js";
import {
  type IFogBounds,
  type IFogLocalLight,
  type ScenePass,
  fogTransport,
} from "./volumetricFogTransport.js";

type FogTexture = ReturnType<typeof rtt> & {
  renderTarget: RenderTarget;
  _quadMesh: { material: NodeMaterial };
};
export interface IFogVolumeGraph {
  /** The bounded integrator itself, before the target it is rendered into. */
  transport: Node<"vec4">;
  target: RenderTarget;
  material: NodeMaterial;
  /** Scene radiance attenuated by the medium, composited before exposure. */
  compose: Node<"vec4">;
}

function lightRadiance(light: DirectionalLight | PointLight) {
  const value = new Vector3();
  return uniform(value).onRenderUpdate(() =>
    value
      .set(light.color.r, light.color.g, light.color.b)
      .multiplyScalar(light.visible ? light.intensity : 0),
  );
}

export function composeFogVolume(
  camera: PerspectiveCamera,
  options: IVolumetricFogOptions,
  volumes: IFogVolume[],
  scenePass: ScenePass,
): IFogVolumeGraph {
  const bounds: IFogBounds[] = volumes.map((volume) => ({
    ...volume,
    low: uniform(volume.bounds.min.clone()),
    high: uniform(volume.bounds.max.clone()),
  }));
  const cameraMatrix = uniform(camera.matrixWorld);
  const inverseProjection = uniform(camera.projectionMatrixInverse);
  const cameraPosition = new Vector3();
  const origin = uniform(cameraPosition).onRenderUpdate(() =>
    camera.getWorldPosition(cameraPosition),
  );
  const ambient = uniform(new Vector3(options.ambient.r, options.ambient.g, options.ambient.b));
  const albedo = uniform(new Vector3(options.albedo.r, options.albedo.g, options.albedo.b));
  const sun = options.sun;
  const shadowDepth = sun?.shadow.map?.depthTexture;
  const directionValue = new Vector3();
  const targetValue = new Vector3();
  const sunDirection =
    sun === undefined
      ? undefined
      : uniform(directionValue).onRenderUpdate(() =>
          sun
            .getWorldPosition(directionValue)
            .sub(sun.target.getWorldPosition(targetValue))
            .normalize(),
        );
  const sunRadiance = sun === undefined ? undefined : lightRadiance(sun);
  const localLights: IFogLocalLight[] = (options.points ?? []).map((point) => {
    const position = new Vector3();
    return {
      point,
      radiance: lightRadiance(point),
      position: uniform(position).onRenderUpdate(() => point.getWorldPosition(position)),
    };
  });
  const depth = scenePass.getTextureNode("depth");
  const scene = scenePass.getTextureNode("output");
  const inputs = {
    albedo,
    ambient,
    anisotropy: options.anisotropy,
    bounds,
    cameraMatrix,
    depth,
    inverseProjection,
    localLights,
    origin,
    shadowDepth,
    steps: options.steps,
    sun,
    sunDirection,
    sunRadiance,
  };
  const transport = fogTransport(inputs);
  const rendered = rtt(transport, null, null, {
    depthBuffer: false,
    type: HalfFloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  }) as FogTexture;
  rendered.setResolutionScale(options.resolutionScale);
  const sizeValue = new Vector3();
  const size = uniform(sizeValue).onRenderUpdate(() =>
    sizeValue.set(rendered.renderTarget.width, rendered.renderTarget.height, 0),
  );
  const compose = Fn(() => {
    const result = rendered.sample(screenUV).toVar();
    // Half-resolution nearest sampling cannot blend fog across a wall. At a depth mismatch,
    // integrate the full-resolution pixel instead; do not borrow stale/foreground history.
    if (options.resolutionScale < 1) {
      const lowUV = screenUV.mul(size.xy).floor().add(0.5).div(size.xy);
      const fullZ = getViewPosition(screenUV, depth.r, inverseProjection).z;
      const lowZ = getViewPosition(lowUV, depth.sample(lowUV).r, inverseProjection).z;
      If(
        fullZ
          .sub(lowZ)
          .abs()
          .greaterThan(max(fullZ.abs().mul(0.01), 0.01)),
        () => result.assign(fogTransport(inputs)),
      );
    }
    return vec4(scene.rgb.mul(result.a).add(result.rgb), scene.a);
  })();
  return {
    transport,
    target: rendered.renderTarget,
    material: rendered._quadMesh.material,
    compose,
  };
}
