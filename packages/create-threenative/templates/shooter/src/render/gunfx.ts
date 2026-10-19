import {
  AdditiveBlending,
  Color,
  DataTexture,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Object3D,
  PlaneGeometry,
  PointLight,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import type { ImpactSurface } from "../surfaces.js";

/**
 * A white disc that falls off to nothing at the rim: the smoke and dust sprite.
 *
 * Written here rather than imported from the core package because nothing under
 * `src/render/` may import a package — this file is the user's to rewrite, and a
 * framework call in it is one more thing to unlearn when the look changes. It is the
 * same 20 lines the framework ships, and the reason it exists at all is in
 * `particles.ts`: `CanvasTexture` samples black under `WebGPURenderer`.
 */
export function softCircleTexture(size = 64, hardness = 0.05): Texture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const falloff = distance >= 1 ? 0 : Math.min(1, (1 - distance) / (1 - hardness)) ** 1.6;
      const index = (y * size + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = Math.round(falloff * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Gunshot feedback, built as pixel data rather than painted canvases.
 *
 * What a gunshot needs to read is not one sprite but three time-scales at once: a
 * flash that lives ~3 frames, debris that flies for a few hundred milliseconds,
 * and dust that lingers after both are gone. Everything here is pooled and
 * allocated once — the fire path may not allocate, or rapid fire GC-hitches.
 *
 * Textures are `DataTexture` for the reason recorded in `particles.ts`:
 * `CanvasTexture` samples black under `WebGPURenderer`.
 */

type Ray = { angle: number; length: number; width: number };

/** Uneven petal lengths are what separate a flash silhouette from a glow ball. */
const FLASH_RAYS: readonly Ray[] = [
  { angle: 0.0, length: 0.98, width: 0.045 },
  { angle: 0.17, length: 0.52, width: 0.03 },
  { angle: 0.35, length: 0.82, width: 0.038 },
  { angle: 0.53, length: 0.44, width: 0.028 },
  { angle: 0.69, length: 0.94, width: 0.042 },
  { angle: 0.86, length: 0.56, width: 0.03 },
];

/**
 * Star-shaped muzzle flash: a white-hot core with six tapered rays of uneven
 * reach. Brightness lands in both RGB and alpha, with the core pushed towards
 * pure white and the ray tips left warm, so the silhouette has temperature
 * variation instead of one flat colour.
 */
export function flashTexture(size = 128): Texture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  const coreRadius = size * 0.17;
  const glowRadius = size * 0.36;
  const raySpan = size * 0.48;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x - centre;
      const py = y - centre;
      const distance = Math.sqrt(px * px + py * py);
      let brightness = Math.max(0, 1 - distance / glowRadius) ** 2.2;
      brightness += Math.max(0, 1 - distance / coreRadius) ** 1.4 * 1.35;
      for (const ray of FLASH_RAYS) {
        const rayAngle = ray.angle * Math.PI * 2;
        const along = px * Math.cos(rayAngle) + py * Math.sin(rayAngle);
        const reach = ray.length * raySpan;
        if (along <= 0 || along >= reach) continue;
        const across = Math.abs(-px * Math.sin(rayAngle) + py * Math.cos(rayAngle));
        const falloff = 1 - along / reach;
        brightness += Math.exp(-((across / (ray.width * size)) ** 2)) * falloff ** 1.7 * 1.15;
      }
      const value = Math.min(1, brightness);
      const heat = Math.min(1, value * 1.6);
      const index = (y * size + x) * 4;
      data[index] = Math.round(value * 255);
      data[index + 1] = Math.round(value * (196 + 59 * heat));
      data[index + 2] = Math.round(value * (150 + 105 * heat));
      data[index + 3] = Math.round(value * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Spark streak: bright round head at the top of the frame, fading tail below.
 * Burst quads are stretched along their velocity with this mapped on, so the
 * head always leads the motion.
 */
function streakTexture(size = 64): Texture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const across = Math.abs(x - centre) / centre;
      const along = y / (size - 1);
      const edges = Math.max(0, 1 - across) ** 1.8;
      const value = edges * (0.18 + 0.82 * along ** 1.6);
      const index = (y * size + x) * 4;
      data[index] = Math.round(Math.min(1, value * 1.25) * 255);
      data[index + 1] = Math.round(value * 235);
      data[index + 2] = Math.round(value * 190);
      data[index + 3] = Math.round(value * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/** How one surface answers a bullet. Counts are per burst; pools hold several. */
const SURFACE_STYLES: Readonly<
  Record<
    ImpactSurface,
    {
      flashColour: number;
      flashScale: number;
      chipColour: number;
      chipCount: number;
      chipSpeed: number;
      chipSize: number;
      dustColour: number;
      dustCount: number;
      dustSize: number;
      sparkColour: number;
      sparkCount: number;
      sparkSpeed: number;
    }
  >
> = {
  // Steel rings and sheds fast bright sparks that die mid-air.
  steel: {
    flashColour: 0xfff3d0,
    flashScale: 0.62,
    chipColour: 0xffcf7d,
    chipCount: 3,
    chipSpeed: 4.5,
    chipSize: 0.026,
    dustColour: 0x8d8d92,
    dustCount: 1,
    dustSize: 0.3,
    sparkColour: 0xffe08a,
    sparkCount: 11,
    sparkSpeed: 9,
  },
  // Stone spalls pale chips and throws a real cloud.
  stone: {
    flashColour: 0xf2dcb2,
    flashScale: 0.46,
    chipColour: 0xcfc6b2,
    chipCount: 6,
    chipSpeed: 3.2,
    chipSize: 0.034,
    dustColour: 0xa39d90,
    dustCount: 2,
    dustSize: 0.52,
    sparkColour: 0xd99c56,
    sparkCount: 4,
    sparkSpeed: 5.5,
  },
  // Plaster is softer: more dust, cream-coloured crumbs, almost no sparks.
  plaster: {
    flashColour: 0xefd9ae,
    flashScale: 0.44,
    chipColour: 0xe3dac4,
    chipCount: 5,
    chipSpeed: 2.6,
    chipSize: 0.04,
    dustColour: 0xbdb3a0,
    dustCount: 3,
    dustSize: 0.58,
    sparkColour: 0xcf9a5c,
    sparkCount: 2,
    sparkSpeed: 4.5,
  },
  // Wood throws brown splinters and a tan puff; sparks barely feature.
  wood: {
    flashColour: 0xe8c795,
    flashScale: 0.4,
    chipColour: 0x7d5a36,
    chipCount: 7,
    chipSpeed: 3.6,
    chipSize: 0.045,
    dustColour: 0xa8875d,
    dustCount: 2,
    dustSize: 0.44,
    sparkColour: 0xc47f3c,
    sparkCount: 2,
    sparkSpeed: 4,
  },
};

type BurstSlot = {
  age: number;
  life: number;
  mesh: Mesh;
  velocity: Vector3;
  spin: number;
  seed: number;
  baseScale: number;
};

const GRAVITY_SPARKS = 9;
const GRAVITY_CHIPS = 19;

// Scratch state for the spawn/update loops — nothing below allocates per shot.
const scratchBasisT1 = new Vector3();
const scratchBasisT2 = new Vector3();
const scratchDir = new Vector3();
const scratchAxisX = new Vector3();
const scratchAxisZ = new Vector3();
const scratchMatrix = new Matrix4();
const scratchColour = new Color();

/**
 * Pooled impact bursts: an additive surface flash, velocity-stretched spark
 * streaks, tumbling material chips and a lingering dust puff, styled per
 * surface. Steel sprays bright fast sparks; stone and plaster throw pale chips
 * under grey dust; wood spits brown splinters.
 *
 * Every mesh sits in the scene from construction at zero opacity — revealing a
 * hidden mesh on the first shot makes WebGPU build its pipeline mid-frame.
 */
export class ImpactBursts {
  readonly #sparks: BurstSlot[] = [];
  readonly #chips: BurstSlot[] = [];
  readonly #dust: BurstSlot[] = [];
  readonly #flashes: { age: number; baseScale: number; life: number; mesh: Mesh; roll: number }[] =
    [];
  /** Dead slots stop being submitted once their pipeline exists. See `settle`. */
  #settled = false;
  #sparkCursor = 0;
  #chipCursor = 0;
  #dustCursor = 0;
  #flashCursor = 0;
  readonly #rng: () => number;
  readonly #streakMap: Texture;
  readonly #dustMap: Texture;

  constructor(parent: Object3D, rng: () => number) {
    this.#rng = rng;
    this.#streakMap = streakTexture();
    this.#dustMap = softCircleTexture(64, 0.05);
    const quad = new PlaneGeometry(1, 1);
    const buildPool = (
      count: number,
      blending: typeof AdditiveBlending | typeof NormalBlending,
      renderOrder: number,
      map: Texture | undefined,
    ): BurstSlot[] => {
      const slots: BurstSlot[] = [];
      for (let index = 0; index < count; index += 1) {
        const material = new MeshBasicMaterial({
          blending,
          color: 0xffffff,
          depthWrite: false,
          map,
          opacity: 0,
          transparent: true,
        });
        const mesh = new Mesh(quad, material);
        mesh.visible = true;
        mesh.frustumCulled = false;
        mesh.renderOrder = renderOrder;
        parent.add(mesh);
        slots.push({
          age: 0,
          baseScale: 1,
          life: 0,
          mesh,
          seed: index * 1.618,
          spin: 0,
          velocity: new Vector3(),
        });
      }
      return slots;
    };
    this.#sparks.push(...buildPool(40, AdditiveBlending, 26, this.#streakMap));
    this.#chips.push(...buildPool(32, NormalBlending, 25, undefined));
    this.#dust.push(...buildPool(18, NormalBlending, 24, this.#dustMap));
    for (let index = 0; index < 6; index += 1) {
      const material = new MeshBasicMaterial({
        blending: AdditiveBlending,
        color: 0xffffff,
        depthWrite: false,
        map: flashTexture(),
        opacity: 0,
        transparent: true,
      });
      const mesh = new Mesh(quad, material);
      mesh.visible = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 27;
      parent.add(mesh);
      this.#flashes.push({ age: 0, baseScale: 1, life: 0, mesh, roll: 0 });
    }
  }

  /** Throw one surface's worth of reaction off `at`, facing along `normal`. */
  spawn(at: Vector3, normal: Vector3, surface: ImpactSurface): void {
    const style = SURFACE_STYLES[surface];
    // A tangent basis around the normal lets burst directions hug the surface
    // hemisphere without calling out to allocation-heavy helpers.
    scratchBasisT1.set(0, 1, 0);
    if (Math.abs(normal.y) > 0.9) scratchBasisT1.set(1, 0, 0);
    scratchBasisT1.cross(normal).normalize();
    scratchBasisT2.crossVectors(normal, scratchBasisT1);

    this.#spawnFlash(at, normal, style);
    for (let index = 0; index < style.sparkCount; index += 1) this.#spawnSpark(at, normal, style);
    for (let index = 0; index < style.chipCount; index += 1) this.#spawnChip(at, normal, style);
    for (let index = 0; index < style.dustCount; index += 1) this.#spawnDust(at, normal, style);
  }

  #hemisphere(normal: Vector3, spread: number, out: Vector3): void {
    const rng = this.#rng;
    out
      .copy(normal)
      .addScaledVector(scratchBasisT1, (rng() * 2 - 1) * spread)
      .addScaledVector(scratchBasisT2, (rng() * 2 - 1) * spread)
      .normalize();
  }

  #spawnFlash(at: Vector3, normal: Vector3, style: (typeof SURFACE_STYLES)[ImpactSurface]): void {
    const slot = this.#flashes[this.#flashCursor % this.#flashes.length];
    this.#flashCursor += 1;
    if (slot === undefined) return;
    slot.mesh.position.copy(at).addScaledVector(normal, 0.035);
    slot.baseScale = style.flashScale * (0.85 + this.#rng() * 0.4);
    slot.roll = this.#rng() * Math.PI * 2;
    slot.life = 0.075;
    this.#wake(slot.mesh);
    slot.age = 0;
    (slot.mesh.material as MeshBasicMaterial).color.setHex(style.flashColour);
    (slot.mesh.material as MeshBasicMaterial).opacity = 1;
  }

  #spawnSpark(at: Vector3, normal: Vector3, style: (typeof SURFACE_STYLES)[ImpactSurface]): void {
    const slot = this.#sparks[this.#sparkCursor % this.#sparks.length];
    this.#sparkCursor += 1;
    if (slot === undefined) return;
    this.#hemisphere(normal, 0.85, scratchDir);
    slot.velocity.copy(scratchDir).multiplyScalar(style.sparkSpeed * (0.45 + this.#rng() * 0.85));
    slot.mesh.position.copy(at).addScaledVector(normal, 0.012);
    slot.age = 0;
    slot.life = 0.2 + this.#rng() * 0.2;
    this.#wake(slot.mesh);
    slot.seed = this.#rng() * 10;
    slot.baseScale = 1;
    scratchColour.setHex(style.sparkColour);
    const material = slot.mesh.material as MeshBasicMaterial;
    material.color.copy(scratchColour);
    material.opacity = 1;
  }

  #spawnChip(at: Vector3, normal: Vector3, style: (typeof SURFACE_STYLES)[ImpactSurface]): void {
    const slot = this.#chips[this.#chipCursor % this.#chips.length];
    this.#chipCursor += 1;
    if (slot === undefined) return;
    this.#hemisphere(normal, 1.15, scratchDir);
    slot.velocity.copy(scratchDir).multiplyScalar(style.chipSpeed * (0.4 + this.#rng() * 0.9));
    slot.mesh.position.copy(at).addScaledVector(normal, 0.01);
    slot.mesh.scale.setScalar(style.chipSize * (0.6 + this.#rng() * 0.8));
    slot.mesh.rotation.set(this.#rng() * Math.PI, this.#rng() * Math.PI, this.#rng() * Math.PI);
    slot.spin = (this.#rng() * 2 - 1) * 18;
    slot.age = 0;
    slot.life = 0.38 + this.#rng() * 0.3;
    this.#wake(slot.mesh);
    slot.baseScale = slot.mesh.scale.x;
    const material = slot.mesh.material as MeshBasicMaterial;
    material.color.setHex(style.chipColour);
    material.opacity = 1;
  }

  #spawnDust(at: Vector3, normal: Vector3, style: (typeof SURFACE_STYLES)[ImpactSurface]): void {
    const slot = this.#dust[this.#dustCursor % this.#dust.length];
    this.#dustCursor += 1;
    if (slot === undefined) return;
    slot.mesh.position
      .copy(at)
      .addScaledVector(normal, style.dustSize * 0.3)
      .addScaledVector(scratchBasisT1, (this.#rng() * 2 - 1) * style.dustSize * 0.25)
      .addScaledVector(scratchBasisT2, (this.#rng() * 2 - 1) * style.dustSize * 0.25);
    // Dust hangs: a slow push off the wall, then near-stationary drift.
    slot.velocity
      .copy(normal)
      .multiplyScalar(style.chipSpeed * 0.22)
      .addScaledVector(scratchBasisT1, (this.#rng() * 2 - 1) * 0.2)
      .addScaledVector(scratchBasisT2, (this.#rng() * 2 - 1) * 0.2);
    slot.age = 0;
    slot.life = 0.55 + this.#rng() * 0.3;
    this.#wake(slot.mesh);
    slot.baseScale = style.dustSize * (0.7 + this.#rng() * 0.5);
    const material = slot.mesh.material as MeshBasicMaterial;
    material.color.setHex(style.dustColour);
    material.opacity = 0;
  }

  /** Integrate everything live; `eye` keeps flashes, dust and sparks camera-facing. */
  /**
   * Stop drawing spent bursts.
   *
   * Every slot is resident from frame one so its pipeline compiles during loading. On a phone the
   * draw call costs more than the quad does, so a dead card is not free the way it is on a
   * desktop; once the pipeline exists, hiding it is reversible for nothing.
   */
  settle(): void {
    this.#settled = true;
    for (const pool of [this.#sparks, this.#chips, this.#dust]) {
      for (const slot of pool) if (slot.life <= 0) slot.mesh.visible = false;
    }
    for (const flash of this.#flashes) if (flash.life <= 0) flash.mesh.visible = false;
  }

  /** Show a slot that is being reused after `settle` hid it. */
  #wake(mesh: Mesh): void {
    if (this.#settled) mesh.visible = true;
  }

  update(dt: number, eye: Vector3): void {
    for (const slot of this.#sparks) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.life = 0;
        if (this.#settled) slot.mesh.visible = false;
        (slot.mesh.material as MeshBasicMaterial).opacity = 0;
        continue;
      }
      slot.velocity.y -= GRAVITY_SPARKS * dt;
      slot.velocity.multiplyScalar(Math.exp(-3.4 * dt));
      slot.mesh.position.addScaledVector(slot.velocity, dt);
      // Stretched billboard: the quad's long axis follows the velocity as seen
      // from the camera, so streaks stay readable from any view angle.
      const speed = slot.velocity.length();
      scratchAxisZ.subVectors(eye, slot.mesh.position).normalize();
      scratchAxisX.crossVectors(slot.velocity, scratchAxisZ);
      if (scratchAxisX.lengthSq() < 1e-6) scratchAxisX.set(1, 0, 0);
      scratchAxisX.normalize();
      scratchAxisZ.crossVectors(scratchAxisX, slot.velocity).normalize();
      scratchMatrix.makeBasis(scratchAxisX, slot.velocity.clone().normalize(), scratchAxisZ);
      slot.mesh.quaternion.setFromRotationMatrix(scratchMatrix);
      slot.mesh.scale.set(0.028, Math.min(0.34, 0.05 + speed * 0.03), 1);
      // Flicker on the way out keeps sparks from dying like a fading lamp.
      const flicker = 0.7 + 0.3 * Math.sin(slot.age * 80 + slot.seed * 7);
      (slot.mesh.material as MeshBasicMaterial).opacity = (1 - t) ** 1.5 * flicker;
    }
    for (const slot of this.#chips) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.life = 0;
        if (this.#settled) slot.mesh.visible = false;
        (slot.mesh.material as MeshBasicMaterial).opacity = 0;
        continue;
      }
      slot.velocity.y -= GRAVITY_CHIPS * dt;
      slot.velocity.multiplyScalar(Math.exp(-0.7 * dt));
      slot.mesh.position.addScaledVector(slot.velocity, dt);
      slot.mesh.rotation.z += slot.spin * dt;
      (slot.mesh.material as MeshBasicMaterial).opacity = Math.min(1, (1 - t) * 3);
    }
    for (const slot of this.#dust) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.life = 0;
        if (this.#settled) slot.mesh.visible = false;
        (slot.mesh.material as MeshBasicMaterial).opacity = 0;
        continue;
      }
      slot.velocity.multiplyScalar(Math.exp(-2.6 * dt));
      slot.velocity.y += dt * 0.35;
      slot.mesh.position.addScaledVector(slot.velocity, dt);
      slot.mesh.lookAt(eye);
      const grow = slot.baseScale * (0.55 + t * 1.5);
      slot.mesh.scale.setScalar(grow);
      // Fast in, slow out: the puff appears with the flash and outlives it.
      (slot.mesh.material as MeshBasicMaterial).opacity =
        Math.min(1, slot.age * 9) * (1 - t) ** 1.6 * 0.55;
    }
    for (const slot of this.#flashes) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.life = 0;
        if (this.#settled) slot.mesh.visible = false;
        (slot.mesh.material as MeshBasicMaterial).opacity = 0;
        continue;
      }
      slot.mesh.lookAt(eye);
      slot.mesh.rotateZ(slot.roll);
      // Pop: slightly larger than life at birth, settled by mid-life.
      slot.mesh.scale.setScalar(slot.baseScale * (1.18 - t * 0.3));
      (slot.mesh.material as MeshBasicMaterial).opacity = (1 - t) ** 1.4;
    }
  }
}

/**
 * One reusable muzzle flash: the star card plus a point light that kicks the
 * world for a couple of frames. Allocated once per shooter and driven by
 * lifetime — never constructed during play, and `visible` never toggles
 * (pipeline rebuilds stall the frame; see the note in `Rifle`).
 */
export class MuzzleFlash {
  readonly #card: Mesh;
  readonly #light: PointLight;
  #life = 0;
  readonly #maxLife: number;
  readonly #peakIntensity: number;
  #roll = 0;
  readonly #baseSize: number;
  readonly #forwardOffset: number;
  #settled = false;

  constructor(
    parent: Object3D,
    options: {
      size?: number;
      colour?: number;
      lightColour?: number;
      lightIntensity?: number;
      lightDistance?: number;
      life?: number;
      forwardOffset?: number;
    } = {},
  ) {
    this.#baseSize = options.size ?? 0.4;
    this.#maxLife = options.life ?? 0.07;
    this.#peakIntensity = options.lightIntensity ?? 30;
    this.#forwardOffset = options.forwardOffset ?? 0.05;
    const material = new MeshBasicMaterial({
      blending: AdditiveBlending,
      color: options.colour ?? 0xffd9a0,
      depthWrite: false,
      map: flashTexture(),
      opacity: 0,
      transparent: true,
    });
    this.#card = new Mesh(new PlaneGeometry(1, 1), material);
    this.#card.visible = true;
    this.#card.frustumCulled = false;
    this.#card.renderOrder = 28;
    this.#settled = false;
    parent.add(this.#card);
    this.#light = new PointLight(
      options.lightColour ?? 0xffc46a,
      0,
      options.lightDistance ?? 10,
      2,
    );
    parent.add(this.#light);
  }

  /** Fire the flash from `at`, pointing along `direction`. */
  spawn(at: Vector3, direction: Vector3, rng: () => number): void {
    this.#card.position.copy(at).addScaledVector(direction, this.#forwardOffset);
    this.#light.position.copy(this.#card.position).addScaledVector(direction, 0.4);
    this.#roll = rng() * Math.PI * 2;
    this.#card.scale.setScalar(this.#baseSize * (0.85 + rng() * 0.5));
    this.#card.visible = true;
    (this.#card.material as MeshBasicMaterial).opacity = 1;
    this.#light.intensity = this.#peakIntensity;
    this.#life = this.#maxLife;
  }

  /**
   * Stop submitting the card while no flash is alive.
   *
   * The card is resident from construction at zero opacity so its pipeline compiles during
   * loading; the cost is a draw per idle flash forever, and on a phone the draw call is the
   * expensive part. Once compiled the pipeline is cached, so `spawn` re-showing it is free.
   */
  settle(): void {
    this.#settled = true;
    if (this.#life <= 0) this.#card.visible = false;
  }

  /** Current card opacity. Zero means retired — the playtest gate for a stuck flash reads this. */
  get opacity(): number {
    return (this.#card.material as MeshBasicMaterial).opacity;
  }

  update(dt: number, eye: Vector3): void {
    this.#life = Math.max(0, this.#life - dt);
    if (this.#life <= 0) {
      (this.#card.material as MeshBasicMaterial).opacity = 0;
      if (this.#settled) this.#card.visible = false;
      this.#light.intensity = 0;
      return;
    }
    const t = this.#life / this.#maxLife;
    this.#card.lookAt(eye);
    this.#card.rotateZ(this.#roll);
    (this.#card.material as MeshBasicMaterial).opacity = Math.min(1, t * 1.6);
    this.#light.intensity = this.#peakIntensity * t ** 1.5;
  }

  dispose(): void {
    (this.#card.material as Material).dispose();
    this.#card.removeFromParent();
    this.#light.removeFromParent();
  }
}

/**
 * Independent muzzle flashes, one per concurrent shot.
 *
 * ## The bug this replaces
 *
 * A squad used to share a single flash quad and a single point light. Two soldiers firing a few
 * frames apart teleported the quad between them, and — worse — every shot from anyone reset the
 * one shared lifetime. Under sustained fire from five men that lifetime never reached zero, so
 * the flash sat permanently lit at whichever muzzle fired last, looking for all the world like a
 * flash that had failed to clean itself up. It had not: it was being kept alive by other people's
 * gunfire.
 *
 * Round-robin over N independent slots fixes it by construction. Each slot owns its own lifetime,
 * so no shooter can hold another shooter's flash open, and `update` retires slots on their own
 * clock whatever else is firing.
 *
 * Every slot's card and light are in the scene from construction with opacity and intensity at
 * zero — revealing a hidden mesh or a hidden light mid-round makes WebGPU rebuild pipelines and
 * stalls the frame, which is the note in `Rifle` and it applies just as hard here.
 */
export class MuzzleFlashPool {
  readonly #slots: MuzzleFlash[] = [];
  #cursor = 0;

  constructor(
    parent: Object3D,
    count: number,
    options: ConstructorParameters<typeof MuzzleFlash>[1] = {},
  ) {
    for (let index = 0; index < count; index += 1) {
      this.#slots.push(new MuzzleFlash(parent, options));
    }
  }

  spawn(at: Vector3, direction: Vector3, rng: () => number): void {
    const slot = this.#slots[this.#cursor % this.#slots.length];
    this.#cursor += 1;
    slot?.spawn(at, direction, rng);
  }

  /** Stop submitting every idle slot's card. See `MuzzleFlash.settle`. */
  settle(): void {
    for (const slot of this.#slots) slot.settle();
  }

  /** Every slot, every frame. Call this outside any gameplay-phase gate — see `Play`. */
  update(dt: number, eye: Vector3): void {
    for (const slot of this.#slots) slot.update(dt, eye);
  }

  /** Highest opacity across the pool. A playtest reads it to prove flashes retire. */
  peakOpacity(): number {
    let peak = 0;
    for (const slot of this.#slots) peak = Math.max(peak, slot.opacity);
    return peak;
  }

  dispose(): void {
    for (const slot of this.#slots) slot.dispose();
    this.#slots.length = 0;
  }
}
