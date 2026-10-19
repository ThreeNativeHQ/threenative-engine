// Editable game appearance. The same DQS node is exercised by the GPU qualification probe.
import type { IAnimalPose } from "@threenative/procedural-animals";
import { attribute, float, mix, transformNormalToView, varying } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { animalSkin } from "./dqs.js";
export function animalMaterial(pose: IAnimalPose): MeshStandardNodeMaterial {
  const skin = (direction: boolean) =>
    animalSkin(
      pose.texture,
      attribute<"vec3">("position", "vec3"),
      attribute<"vec3">("normal", "vec3"),
      attribute<"vec4">("skinIndex", "vec4"),
      attribute<"vec4">("skinWeight", "vec4"),
      direction,
    );
  const material = new MeshStandardNodeMaterial();
  const tint = attribute<"vec4">("aTint", "vec4");
  const pattern = attribute<"vec4">("aPat", "vec4");
  material.colorNode = mix(tint.rgb, pattern.rgb, pattern.a.mul(float(0.25)));
  material.roughness = 0.82;
  material.metalness = 0;
  material.positionNode = skin(false);
  material.castShadowPositionNode = material.positionNode;
  material.normalNode = transformNormalToView(varying(skin(true), "animalDQNormal")).normalize();
  return material;
}
