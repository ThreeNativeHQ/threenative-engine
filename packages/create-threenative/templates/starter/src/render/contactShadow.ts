// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// A baked blob under a prop: what makes a crate sit on the floor on every tier. Unreal grounds a
// contact with ambient occlusion, which is on by default (UE 5.8.3: Engine/Source/Runtime/Engine/
// Private/SceneView.cpp:168-173, Scene.cpp:567) and off at its Low scalability level
// (Engine/Config/BaseScalability.ini:568-569); its lights add no contact shadow of their own
// (ULightComponent::ContactShadowLength = 0, LightComponent.cpp:470). This game's `low` tier
// (software adapters and phones) draws no screen-space pass either, and at the +1 EV Unreal exposure
// the floor's highlight shoulder dilutes the sun shadow's edge, so the blob carries the contact.
//
// The blob is stacked flat discs, not a gradient texture: a sampled map drew nothing on the owned engine.
import { CircleGeometry, Group, Mesh, MeshBasicMaterial } from "three";

const LAYERS = 24;

export interface IContactShadow {
  readonly object: Group;
  /** Scales the blob's darkness: 1 at rest, 0 gone. */
  fade(amount: number): void;
}

/**
 * A soft blob `diameter` metres across, lying in the XZ plane, darkest at the centre where its
 * `strength` (0 to 1) is reached. The caller moves `object` to the floor under its prop. It casts
 * and receives nothing and does not write depth, so it never fights the floor or another blob.
 */
export function contactShadow(diameter: number, strength = 0.55): IContactShadow {
  const layerAlpha = 1 - (1 - strength) ** (1 / LAYERS);
  const material = new MeshBasicMaterial({
    color: 0x000000,
    depthWrite: false,
    opacity: layerAlpha,
    transparent: true,
  });
  const object = new Group();
  for (let layer = 0; layer < LAYERS; layer += 1) {
    const geometry = new CircleGeometry((diameter / 2) * (1 - layer / LAYERS), 32);
    geometry.rotateX(-Math.PI / 2);
    const disc = new Mesh(geometry, material);
    disc.renderOrder = 1;
    object.add(disc);
  }
  return {
    fade: (amount) => {
      material.opacity = layerAlpha * amount;
    },
    object,
  };
}
