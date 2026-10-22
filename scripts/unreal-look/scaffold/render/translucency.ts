// Unreal lights a translucent surface from its translucency volume, the same in every direction: the default lighting
// mode, Volumetric NonDirectional (UE 5.8.3: Engine/Shaders/Private/TranslucencyVolumeCommon.ush,
// GetVolumeLightingNonDirectional; Engine/Shaders/Private/TranslucentLightInjectionShaders.usf, InjectMainPS). The volume
// holds each light as spherical harmonics and the surface reads the L0 term alone, so a light reaches the surface at a
// quarter of what it gives a surface that faces it: the mean of max(0, n.l) over every normal n. A pane of glass in a room
// is dim beside the walls it covers, and it takes no shadow, because the lamp's light never has to turn a corner.
import { type MeshStandardMaterial, type PointLight, type SpotLight, Vector3 } from "three";
import { dot, float, positionWorld, uniform, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";

/** The mean of max(0, n.l) over the sphere. */
const SPHERE_MEAN_COSINE = 0.25;

/**
 * What the lamps give a point in every direction, as a radiance (E / pi), the unit the GI cache reads in: the quarter of
 * what a surface facing each lamp receives. Unreal shadows the volume's light. This is unshadowed, so a lamp behind a wall
 * still lights a pane on the other side of it. The lamps are read live: a lamp switched off at run time leaves the pane at once.
 */
export function pointLightMean(
  lights: readonly (PointLight | SpotLight)[],
  position: Node<"vec3">,
): Node<"vec3"> {
  let sum: Node<"vec3"> = vec3(0, 0, 0);
  for (const light of lights) {
    // A cone would need the spot's falloff: refuse it rather than light a pane from outside the cone.
    if (light.type !== "PointLight")
      throw new Error(
        `TN_TRANSLUCENT_LIGHT: ${light.name} is a ${light.type}; a translucent surface takes point lights only`,
      );
    const at = new Vector3();
    const radiance = new Vector3();
    const toLight = uniform(at)
      .onRenderUpdate(() => light.getWorldPosition(at))
      .sub(position);
    const distanceSquared = dot(toLight, toLight).max(0.0004);
    // three's getDistanceAttenuation: inverse square times a window that closes at the cutoff distance.
    const window =
      light.distance > 0
        ? float(1)
            .sub(distanceSquared.div(light.distance ** 2).pow(2))
            .clamp(0, 1)
            .pow(2)
        : float(1);
    const colour = uniform(radiance).onRenderUpdate(() =>
      radiance
        .set(light.color.r, light.color.g, light.color.b)
        .multiplyScalar(light.visible ? light.intensity / Math.PI : 0),
    );
    sum = sum.add(colour.mul(window.div(distanceSquared)));
  }
  return sum.mul(SPHERE_MEAN_COSINE);
}

/**
 * The material a translucent source becomes: unlit, its colour times the light every direction receives, drawn with the
 * source's own blending, opacity, sides and depth write. `light` is that light at a world position.
 */
export function translucentTwin(
  source: Pick<MeshStandardMaterial, "color" | "depthWrite" | "opacity" | "side">,
  light: (position: Node<"vec3">) => Node<"vec3">,
): MeshBasicNodeMaterial {
  const twin = new MeshBasicNodeMaterial();
  twin.transparent = true;
  twin.opacity = source.opacity;
  twin.side = source.side;
  twin.depthWrite = source.depthWrite;
  twin.colorNode = vec3(source.color.r, source.color.g, source.color.b).mul(light(positionWorld));
  return twin;
}
