import type { Object3D } from "three";
import { float, screenCoordinate, uniform, vec4 } from "three/tsl";

export const velocityFixtureRadius = 0.8;
export const velocityFixturePositions = [1.5, 1.35, 1.65, 1.25, 1.6, 1.45, 1.45, 1.7, 1.3] as const;

/** The authored moving subdraw stays wholly right of centre; every static subdraw stays left. */
export function velocityCoverageNode(movingObject: Object3D, width: number) {
  const objectId = uniform(0)
    .setName("velocityFixtureObject")
    .onObjectUpdate(({ object }) => (object === movingObject ? 1 : 0));
  // This attachment shares the actual geometry/depth coverage, with no lighting or history input.
  return vec4(objectId.mul(float(screenCoordinate.x.greaterThanEqual(width / 2))), 0, 0, 1);
}
