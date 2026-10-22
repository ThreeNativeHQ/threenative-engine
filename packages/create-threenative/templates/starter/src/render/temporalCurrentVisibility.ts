// Generated appearance policy: replay original standard alpha/deformation/depth, without lighting.
// Private passes retain the original render-list order and use the existing scheduled motion node.
import {
  Color,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoBlending,
  NormalBlending,
  Object3D,
  type Scene,
} from "three";
import { float, vec3, vec4 } from "three/tsl";
import type { Node, NodeMaterial, Renderer } from "three/webgpu";

interface IMaterialLibrary {
  fromMaterial(material: Material): NodeMaterial;
}

/** A clone of the actual renderer conversion keeps its vertex and alpha implementation. Replacing
 * fragmentNode would bypass alpha discard. Replacing lighting/output after diffuse setup retains it,
 * and the explicit output avoids NodeMaterial's nonnegative RGB clamp on signed motion. */
export function currentVisibilityMaterial(
  renderer: Renderer,
  source: Material,
  motion: Node<"vec2">,
): NodeMaterial {
  const converted = (renderer.library as unknown as IMaterialLibrary).fromMaterial(source);
  const material = converted.clone();
  // Pinned NodeMaterial.copy skips inherited alphaTest's backing field. Material.copy restores
  // all raster/alpha state; the converted clone already retained its material-specific maps.
  Material.prototype.copy.call(material, source);
  material.name = "Temporal current visibility";
  material.setupAmbientOcclusion = () => float(1);
  material.setupVariants = () => {};
  material.setupLighting = () => vec3(0);
  material.outputNode = vec4(motion, 0, 1);
  material.fog = false;
  return material;
}

/** Unknown/custom inputs use the ordinary provider. The shared VelocityTracker must already have
 * scheduled the previous frame once; no pass here creates, advances or commits another tracker. */
export function currentVisibilityEligible(scene: Scene): boolean {
  // Background sites have clear depth1/motion0, not an independent coverage alpha mask.
  let eligible =
    (scene.background === null || scene.background instanceof Color) &&
    scene.overrideMaterial === null &&
    !authoredNode(scene) &&
    scene.onBeforeRender === Object3D.prototype.onBeforeRender &&
    scene.onAfterRender === Object3D.prototype.onAfterRender;
  scene.traverseVisible((object) => {
    if (!eligible) return;
    if (Reflect.get(object, "isBundleGroup")) {
      eligible = false;
      return;
    }
    if (
      Reflect.get(object, "isClippingGroup") &&
      Reflect.get(object, "enabled") &&
      Reflect.get(object, "clippingPlanes")?.length
    ) {
      eligible = false;
      return;
    }
    if (
      object.onBeforeRender !== Object3D.prototype.onBeforeRender ||
      object.onAfterRender !== Object3D.prototype.onAfterRender ||
      object.onBeforeShadow !== Object3D.prototype.onBeforeShadow ||
      object.onAfterShadow !== Object3D.prototype.onAfterShadow
    ) {
      eligible = false;
      return;
    }
    if (
      Reflect.get(object, "isLine") ||
      Reflect.get(object, "isPoints") ||
      Reflect.get(object, "isSprite")
    ) {
      eligible = false;
      return;
    }
    if (authoredNode(object) || authoredNode(Reflect.get(object, "shadow"))) {
      eligible = false;
      return;
    }
    if (!(object instanceof Mesh)) return;
    if (
      Object.values(object.geometry.morphAttributes).some(
        (attributes) => (attributes as readonly unknown[]).length > 0,
      )
    ) {
      eligible = false;
      return;
    }
    if (
      !(
        Reflect.get(object, Symbol.for("threenative.velocity.previousWorldMatrix")) instanceof
        Matrix4
      )
    ) {
      eligible = false;
      return;
    }
    if (
      Reflect.get(object, "isBatchedMesh") ||
      (Reflect.get(object, "isInstancedMesh") &&
        Reflect.get(object, Symbol.for("threenative.velocity.previousInstanceMatrices")) ===
          undefined) ||
      (Reflect.get(object, "isSkinnedMesh") &&
        Reflect.get(object, Symbol.for("threenative.velocity.previousBoneMatrices")) === undefined)
    ) {
      eligible = false;
      return;
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const defines = Reflect.get(material, "defines") ?? {};
      const ordinaryDefines = Object.keys(defines).every(
        (name) =>
          name === "STANDARD" &&
          defines[name] === "" &&
          Reflect.get(material, "isMeshStandardMaterial") === true,
      );
      if (
        (material.constructor !== MeshStandardMaterial &&
          material.constructor !== MeshBasicMaterial) ||
        Object.keys(material).some(
          (name) =>
            (name.endsWith("Node") && Reflect.get(material, name) != null) ||
            (name.startsWith("setup") && typeof Reflect.get(material, name) === "function"),
        )
      )
        eligible = false;
      if (
        (Reflect.get(material, "isMeshStandardMaterial") !== true &&
          Reflect.get(material, "isMeshBasicMaterial") !== true) ||
        Reflect.get(material, "isNodeMaterial") ||
        Reflect.get(material, "isMeshPhysicalMaterial") ||
        Reflect.get(material, "displacementMap") ||
        material.transparent ||
        material.alphaHash ||
        material.alphaToCoverage ||
        !material.depthTest ||
        !material.depthWrite ||
        !material.colorWrite ||
        material.stencilWrite ||
        (material.blending !== NormalBlending && material.blending !== NoBlending) ||
        material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
        material.onBeforeRender !== Material.prototype.onBeforeRender ||
        material.customProgramCacheKey !== Material.prototype.customProgramCacheKey ||
        material.clippingPlanes?.length ||
        Reflect.get(material, "contextNode") ||
        !ordinaryDefines
      )
        eligible = false;
    }
  });
  return eligible;
}

function authoredNode(owner: unknown): boolean {
  if (typeof owner !== "object" || owner === null) return false;
  return Reflect.ownKeys(owner).some((field) => {
    if (typeof field !== "string" || !field.endsWith("Node")) return false;
    const value = Reflect.get(owner, field);
    return value !== undefined && value !== null;
  });
}
