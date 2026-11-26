// The stage: grid floor, a backdrop, a lighting truss, two speaker stacks and two pads. Every
// surface is the procedural metre grid; the pads and lamps are the only lit things, and they
// pulse on the beat. No texture or model file.
import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SpotLight,
} from "three";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";

/** Where the two performers stand, metres from the middle of the stage. */
export const TEACHER_X = -2.4;
export const PLAYER_X = 2.4;

const WARM = 0xe8b86a;
const BLUE = 0x2a6cf0;
/** Spot intensity in candela at the dimmest and brightest point of the beat. */
const LAMP_DIM = 90;
const LAMP_BRIGHT = 420;
/** Pad glow at the dimmest and brightest point of the beat. */
const PAD_DIM = 0.25;
const PAD_BRIGHT = 1.6;

function box(width: number, height: number, depth: number, x: number, y: number, z: number, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(worldGridUVs(new BoxGeometry(width, height, depth).translate(x, y, z)), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export class Stage {
  readonly mesh = new Group();
  readonly tags = ["stage"];
  readonly #lamps: SpotLight[] = [];
  readonly #pads: MeshStandardMaterial[] = [];
  #pulse = 0;

  constructor() {
    this.mesh.name = "stage";
    this.mesh.add(box(26, 0.4, 14, 0, -0.2, 0, floorMaterial));
    // The ground beyond the stage, so the horizon is not a hard edge of the platform.
    const ground = new Mesh(worldGridUVs(new PlaneGeometry(240, 240).rotateX(-Math.PI / 2).translate(0, -0.41, 0)), structureMaterial);
    ground.receiveShadow = true;
    this.mesh.add(ground);
    this.mesh.add(box(22, 6.5, 0.4, 0, 3.25, -5.5, structureMaterial));
    // The truss: two posts and a beam, with a lamp can under it for each spot.
    this.mesh.add(box(0.3, 5.2, 0.3, -8.5, 2.6, -2.2, structureMaterial), box(0.3, 5.2, 0.3, 8.5, 2.6, -2.2, structureMaterial));
    this.mesh.add(box(17.3, 0.25, 0.25, 0, 5.2, -2.2, structureMaterial));
    this.mesh.add(...[-1, 1].flatMap((side) => [0, 1, 2].map((tier) => box(1.4, 0.9, 1.2, side * 11, 0.45 + tier * 0.95, -3.2, structureMaterial))));
    for (const [x, colour, aimX] of [[-4.2, WARM, -2.4], [0, 0xffffff, 0], [4.2, BLUE, 2.4]] as const) {
      const can = new Mesh(new CylinderGeometry(0.22, 0.3, 0.5, 16).translate(x, 4.85, -2.2), new MeshStandardMaterial({ color: 0x202226, roughness: 0.5, metalness: 0.4 }));
      can.castShadow = true;
      this.mesh.add(can);
      const lamp = new SpotLight(new Color(colour), LAMP_DIM, 30, 0.5, 0.6, 1.4);
      lamp.position.set(x, 4.7, -2.2);
      lamp.target.position.set(aimX, 1, 0);
      this.mesh.add(lamp, lamp.target);
      this.#lamps.push(lamp);
    }
    for (const [x, colour] of [[TEACHER_X, WARM], [PLAYER_X, BLUE]] as const) {
      const material = new MeshStandardMaterial({ color: 0x303236, emissive: new Color(colour), emissiveIntensity: PAD_DIM, roughness: 0.4 });
      const pad = new Mesh(new CircleGeometry(1.25, 40).rotateX(-Math.PI / 2).translate(x, 0.012, 0), material);
      pad.receiveShadow = true;
      this.mesh.add(pad);
      this.#pads.push(material);
    }
    // A strip of the accent colour along the stage lip: the one thing you act on.
    this.mesh.add(box(26, 0.12, 0.2, 0, 0.06, 7, propMaterial));
  }

  /** Called once per tick with the beat's pulse (1 on the beat, falling to 0). */
  update(pulse: number): void {
    this.#pulse = pulse;
    for (const lamp of this.#lamps) lamp.intensity = LAMP_DIM + (LAMP_BRIGHT - LAMP_DIM) * pulse;
    for (const pad of this.#pads) pad.emissiveIntensity = PAD_DIM + (PAD_BRIGHT - PAD_DIM) * pulse;
  }

  /** What a playtest reads: the live lamp intensity, which only the beat moves. */
  debug(): Record<string, unknown> {
    const lamp = this.#lamps[0]?.intensity ?? 0;
    return { lamp: Math.round(lamp), pad: Math.round((this.#pads[0]?.emissiveIntensity ?? 0) * 100) / 100, pulse: Math.round(this.#pulse * 100) / 100 };
  }
}
