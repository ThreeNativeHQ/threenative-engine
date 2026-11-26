// The rifle in the player's hands: boxes parented to the camera, moved by the weapon's state.
import { Group, MathUtils, type PerspectiveCamera } from "three";
import { createRifle } from "./props.js";

/** Where the rifle sits in camera space (the camera looks down -z): at the hip, and on the sights. */
const HIP = { x: 0.17, y: -0.17, z: -0.42 } as const;
const ADS = { x: 0, y: -0.085, z: -0.32 } as const;

export interface IViewmodelState {
  /** 0 at the hip, 1 on the sights. */
  readonly ads: number;
  /** 0..1 progress through the reload, or 0 when not reloading. */
  readonly reload: number;
  readonly sprinting: boolean;
  /** Kick in degrees: the rifle rides back with it. */
  readonly kick: number;
}

export function createViewmodel(camera: PerspectiveCamera): {
  update: (state: IViewmodelState) => void;
} {
  const root = new Group();
  root.name = "viewmodel";
  const rifle = createRifle();
  // The mannequin's rifle points along +z; the camera looks along -z.
  rifle.rotation.y = Math.PI;
  rifle.scale.setScalar(0.75);
  root.add(rifle);
  camera.add(root);
  return {
    update: ({ ads, reload, sprinting, kick }) => {
      const lower = sprinting ? 1 : 0;
      const dip = Math.sin(reload * Math.PI);
      root.position.set(
        MathUtils.lerp(HIP.x, ADS.x, ads) - lower * 0.08,
        MathUtils.lerp(HIP.y, ADS.y, ads) - dip * 0.22 - lower * 0.06,
        MathUtils.lerp(HIP.z, ADS.z, ads) + kick * 0.012,
      );
      root.rotation.set(dip * 0.7 + kick * 0.01, lower * 0.5, -dip * 0.3);
    },
  };
}
