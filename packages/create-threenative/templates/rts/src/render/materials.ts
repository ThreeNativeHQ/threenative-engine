// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The look, in one place: the node materials that draw the painted ground and the water. `terrain.ts` builds the ground; everything that decides what the ground *is* lives here,
// so a rebalance is one file rather than a hunt through the scene.
import { type BufferGeometry, CircleGeometry, type DataTexture } from "three";
import {
  color,
  float,
  length,
  max,
  mix,
  oneMinus,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  time,
  uv,
} from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { HALF, WORLD } from "../sim/terrain.js";
import { paintGround } from "./ground.js";
import { palette } from "./palette.js";

/**
 * The ground: the painted battlefield from `ground.ts`, with the fog of war sampled in the same
 * material rather than painted over it.
 *
 * An overlay plane is one more full-map draw, and it cannot be depth-tested against the very slope
 * it is drawn on without z-fighting it. One material, one texture, one draw — and the fog is lit
 * with the ground, so a shadow crossing unexplored ground darkens both together. The fog texture
 * holds how much of the ground shows through: 1 in sight, 0.76 remembered, 0.41 never seen.
 */
export function createTerrainMaterial(fog: DataTexture): MeshStandardNodeMaterial {
  const mapUv = positionWorld.xz.add(HALF).div(WORLD);
  const material = new MeshStandardNodeMaterial({ metalness: 0.025, roughness: 0.94 });
  material.colorNode = mix(
    color(palette.unseen),
    texture(paintGround(), mapUv).rgb,
    texture(fog, mapUv).r,
  );
  return material;
}

/** The pools the simulation refuses to path across: two greens that ripple, faded at the rim. */
export function createWaterMaterial(): MeshBasicNodeMaterial {
  const water = new MeshBasicNodeMaterial({ depthWrite: false, transparent: true });
  const p = positionWorld.xz;
  const wave = sin(p.x.mul(2.4).add(p.y.mul(0.7)).add(time)).mul(
    sin(p.y.mul(2.2).sub(p.x.mul(0.3)).sub(time.mul(0.7))),
  );
  const ripple = pow(max(wave, 0), 10);
  water.colorNode = mix(color(0x183e3c), color(0x2b5e57), wave.mul(0.5).add(0.5)).add(
    color(0x363d2e).mul(ripple.mul(0.4)),
  );
  water.opacityNode = float(0.87).mul(oneMinus(smoothstep(0.43, 0.5, length(uv().sub(0.5)))));
  return water;
}
/** The unit disc the water instances: a circle, already flat, already facing up. */
export function waterDisc(): BufferGeometry {
  return new CircleGeometry(1, 48).rotateX(-Math.PI / 2);
}
