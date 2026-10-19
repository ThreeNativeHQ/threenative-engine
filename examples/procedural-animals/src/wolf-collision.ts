import { CollisionShape3D } from "@threenative/physics";
import type { IAnimalBake } from "@threenative/procedural-animals";
import { Box3, BufferAttribute, Vector3 } from "three";

/** Measured bind-origin radius supplies horizontal clearance against the course's tall wall. */
export function wolfCollision(bake: IAnimalBake) {
  const box = new Box3().setFromBufferAttribute(new BufferAttribute(bake.pos, 3));
  const point = new Vector3();
  let radius = 0;
  for (let offset = 0; offset < bake.pos.length; offset += 3)
    radius = Math.max(radius, point.fromArray(bake.pos, offset).length());
  if (!Number.isFinite(radius) || radius <= 0) throw new Error("TN_ANIMAL_COLLISION_MEASUREMENT");
  const visualOriginOffset = new Vector3(0, -radius, 0);
  return {
    radius,
    shape: () => CollisionShape3D.sphere(radius),
    visualOriginOffset,
    startHeight: radius + box.getSize(point).y,
    cameraCenter: box.getCenter(new Vector3()).add(visualOriginOffset),
  };
}
