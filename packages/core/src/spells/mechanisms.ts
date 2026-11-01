/**
 * The four things a spell draws besides particles.
 *
 * Each is pooled and reused: a spell allocates its drawables once at `create`, and a cast only
 * moves uniforms and a transform. Nothing here is added to the scene at cast time, because an
 * object added mid-frame changes the frame's draw list and, in Three.js, can cost a program.
 *
 * All shader code is TSL. There is no GLSL string in this package.
 */

import {
  abs,
  float,
  length,
  mix,
  oneMinus,
  pow,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  Color,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  PlaneGeometry,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from "three/webgpu";

const TAU = Math.PI * 2;

const finite = (label: string, value: number): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};

/** A hot, soft ball: the thing the player is actually aiming. */
export class SpellCore {
  readonly sprite = new Sprite();
  readonly #colour = uniform(new Color(1, 0.72, 0.34));
  readonly #highlight = uniform(new Color(1, 0.95, 0.72));
  readonly #radius = uniform(0.35);
  readonly #intensity = uniform(1);
  readonly #material: SpriteNodeMaterial;

  constructor(parent: Object3D) {
    this.#material = new SpriteNodeMaterial({
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    const point = uv().sub(0.5);
    const radius = length(point);
    // A flat core inside a hot rim: the eye reads a sphere, not a disc.
    const core = float(1).sub(smoothstep(0.04, 0.44, radius));
    const rim = pow(oneMinus(smoothstep(0.3, 0.5, radius)), 2.5);
    this.#material.colorNode = vec4(
      mix(this.#colour, this.#highlight, core.mul(0.85).add(0.15)),
      core.add(rim.mul(0.55)).mul(this.#intensity),
    );
    this.#material.scaleNode = vec2(this.#radius, this.#radius).mul(2.6);
    this.sprite.material = this.#material;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
    parent.add(this.sprite);
  }

  /** Metres across, the tint, and how hard it burns. */
  show(
    position: Vector3,
    radius: number,
    colour: Color,
    highlight: Color,
    intensity: number,
  ): void {
    this.sprite.position.copy(position);
    this.#radius.value = Math.max(0.001, finite("core.radius", radius));
    this.#colour.value.copy(colour);
    this.#highlight.value.copy(highlight);
    this.#intensity.value = Math.max(0, finite("core.intensity", intensity));
    this.sprite.visible = true;
  }

  hide(): void {
    this.sprite.visible = false;
  }
}

/** An expanding shell: the pressure wave of an impact, and the edge of a shield. */
export class ShockShell {
  readonly mesh: Mesh;
  readonly #colour = uniform(new Color(1, 0.7, 0.3));
  readonly #progress = uniform(0);
  readonly #strength = uniform(0);
  readonly #material: MeshBasicNodeMaterial;

  constructor(parent: Object3D) {
    this.#material = new MeshBasicNodeMaterial({
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      transparent: true,
    });
    // Rim-bright: the silhouette carries the wave, the middle stays clear.
    const rim = pow(oneMinus(abs(uv().sub(0.5).length().mul(2).sub(1))), 3);
    this.#material.colorNode = vec4(this.#colour, rim.mul(this.#strength));
    this.mesh = new Mesh(new SphereGeometry(1, 24, 16), this.#material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** `progress` 0..1 drives both the radius and the fade, so a shell cannot outlive its impact. */
  show(
    centre: Vector3,
    progress: number,
    radius: number,
    colour: Color,
    strength: number,
    fade = 1 - Math.min(1, Math.max(0, progress)),
  ): void {
    this.mesh.position.copy(centre);
    this.#progress.value = Math.min(1, Math.max(0, progress));
    // A wave at progress 0 is a point; keep a floor so the first frame is not an empty sphere.
    const scale =
      Math.max(0.001, finite("shell.radius", radius)) * Math.max(0.02, this.#progress.value);
    this.mesh.scale.setScalar(scale);
    this.#colour.value.copy(colour);
    this.#strength.value = Math.max(0, finite("shell.strength", strength)) * Math.max(0, fade);
    this.mesh.visible = this.#strength.value > 0.001;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

/** A crackling column from the sky to a point, or from a hand to a point. */
export class BoltColumn {
  readonly mesh: Mesh;
  readonly #colour = uniform(new Color(0.85, 0.93, 1));
  readonly #core = uniform(new Color(1, 1, 1));
  readonly #strength = uniform(0);
  readonly #seed = uniform(0);
  readonly #material: MeshBasicNodeMaterial;
  readonly #up = new Vector3(0, 1, 0);

  constructor(parent: Object3D, segments = 28) {
    this.#material = new MeshBasicNodeMaterial({
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      transparent: true,
    });
    // The jitter is evaluated per vertex from a hash of the segment and the seed, so a bolt's shape
    // is a number the spell can hold still or re-roll without rebuilding the geometry.
    const across = uv().x.sub(0.5);
    const along = uv().y;
    const jag = along
      .mul(41.7)
      .add(this.#seed)
      .fract()
      .sub(0.5)
      .mul(0.055)
      .add(along.mul(97.3).add(this.#seed.mul(1.7)).fract().sub(0.5).mul(0.022));
    const coreWidth = float(0.16).mul(oneMinus(smoothstep(0.0, 0.5, across.abs().mul(2))));
    const glowWidth = oneMinus(smoothstep(0.0, 0.5, across.abs().mul(2).sub(coreWidth)));
    this.#material.colorNode = vec4(
      mix(this.#colour, this.#core, coreWidth),
      glowWidth.mul(this.#strength).mul(oneMinus(along.mul(0.25))),
    );
    this.#material.positionNode = vec3(across.add(jag), along, 0);
    this.mesh = new Mesh(new PlaneGeometry(1, 1, 1, segments), this.#material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Stretch the ribbon from `from` to `to`, facing the camera enough to read from any angle. */
  show(
    from: Vector3,
    to: Vector3,
    width: number,
    colour: Color,
    core: Color,
    strength: number,
    seed: number,
    camera?: { position: Vector3 },
  ): void {
    const direction = new Vector3().subVectors(to, from);
    const span = direction.length();
    if (!(span > 1e-4)) {
      this.hide();
      return;
    }
    this.mesh.position.copy(from).addScaledVector(direction, 0.5);
    const axis = direction.clone().normalize();
    this.mesh.quaternion.setFromUnitVectors(this.#up, axis);
    // A flat column disappears edge-on, so the ribbon twists about its own axis to face the camera.
    if (camera !== undefined) {
      const toCamera = new Vector3().subVectors(camera.position, this.mesh.position);
      toCamera.addScaledVector(axis, -toCamera.dot(axis));
      if (toCamera.lengthSq() > 1e-6) {
        const basis = new Vector3(1, 0, 0).applyQuaternion(this.mesh.quaternion);
        this.mesh.rotateY(
          Math.atan2(new Vector3().crossVectors(basis, toCamera).dot(axis), basis.dot(toCamera)),
        );
      }
    }
    this.mesh.scale.set(Math.max(0.01, finite("bolt.width", width)), span, 1);
    this.#colour.value.copy(colour);
    this.#core.value.copy(core);
    this.#strength.value = Math.max(0, finite("bolt.strength", strength));
    this.#seed.value = seed % 1;
    this.mesh.visible = this.#strength.value > 0.001;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

/** A shield: a bubble whose rim brightens as it takes a hit. */
export class ShieldBubble {
  readonly mesh: Mesh;
  readonly #colour = uniform(new Color(1, 0.4, 0.9));
  readonly #strength = uniform(0);
  readonly #pulse = uniform(0);
  readonly #material: MeshBasicNodeMaterial;

  constructor(parent: Object3D) {
    this.#material = new MeshBasicNodeMaterial({
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      transparent: true,
    });
    // A six-fold cell pattern on the sphere reads as a faceted ward, not a soap bubble.
    const cells = uv().mul(TAU * 6);
    const facet = abs(cells.x.sin().mul(cells.y.sin())).mul(0.5).add(0.5);
    const rim = pow(oneMinus(abs(uv().x.mul(2).sub(1)).mul(0.6)), 1.6);
    this.#material.colorNode = vec4(
      this.#colour,
      facet.mul(0.85).add(rim.mul(0.9)).mul(this.#strength).mul(this.#pulse.add(0.75)),
    );
    this.mesh = new Mesh(new SphereGeometry(1, 32, 24), this.#material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  show(centre: Vector3, radius: number, colour: Color, strength: number, pulse: number): void {
    this.mesh.position.copy(centre);
    this.mesh.scale.setScalar(Math.max(0.001, finite("shield.radius", radius)));
    this.#colour.value.copy(colour);
    this.#strength.value = Math.max(0, finite("shield.strength", strength));
    this.#pulse.value = Math.min(1, Math.max(0, pulse));
    this.mesh.visible = this.#strength.value > 0.001;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

/** The pool of drawables one spell owns. */
export interface ISpellDrawables {
  readonly core: SpellCore;
  readonly shell: ShockShell;
  readonly bolt: BoltColumn;
  readonly shield: ShieldBubble;
}

/**
 * Build a spell's drawables and add them to the world's scene.
 *
 * A spell builds these at `create`; a cast only shows and hides them. That is the whole reason the
 * first cast of a spell is not slower than its hundredth.
 */
export function createDrawables(parent: Object3D): ISpellDrawables {
  return {
    bolt: new BoltColumn(parent),
    core: new SpellCore(parent),
    shell: new ShockShell(parent),
    shield: new ShieldBubble(parent),
  };
}
