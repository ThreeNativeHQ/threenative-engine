import {
  AnimationPlayer,
  type ICtx,
  normaliseToMetres,
  softCircleDataTexture,
} from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import {
  AdditiveBlending,
  type AnimationClip,
  Box3,
  CircleGeometry,
  ConeGeometry,
  Group,
  type Material,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  type Scene as ThreeScene,
  Vector3,
} from "three";
import { FIRST_PERSON } from "../render/camera.js";
import { PooledBillboards } from "../render/pooled-billboards.js";
import { scale } from "../render/scale.js";
import type { GameState } from "../state.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

export const MAGAZINE = 30;
export const RESERVE = 90;
const RELOAD_SECONDS = 0.7;
/**
 * 600 rounds a minute, the AK's cyclic rate. The trigger is held, not tapped: the scene reads
 * `input.pressed("fire")` and this cooldown is what turns a held button into a cadence.
 */
const CYCLIC_SECONDS = 0.1;

/**
 * Hip and aimed rest poses, in camera space. The shipped viewmodel is authored
 * at life scale pointing +z with its origin at the shoulder, so the only fixed
 * correction is a half turn; everything else is pose. The asset must keep float skinned
 * positions: a quantized re-encode folds its scale into the inverse-bind matrices and renders
 * the forearm as a sleeve filling the screen, whatever this pose says.
 */
const HIP = { x: 0.22, y: -0.29, z: -0.15, pitch: -0.03, yaw: 0.12, roll: 0.04 };
/** Measured on the shipped viewmodel's ADS capture: scope body spans 190..455 px, window center at ~265 px down from top. */
const SIGHT_WINDOW_FROM_TOP = 0.28;
const AIM_Z = -0.16;
const ZERO_DISTANCE = 25;
const MAX_CONVERGENCE_DEGREES = 8;
const UP = new Vector3(0, 1, 0);

export type AimRay = { origin: Vector3; direction: Vector3 };

export class Rifle {
  ammo = MAGAZINE;
  reserve = RESERVE;
  shots = 0;
  reloads = 0;
  reloading = false;
  /** Set by the scene: foley for the magazine leaving and returning. */
  onMagOut: (() => void) | undefined;
  onMagIn: (() => void) | undefined;
  readonly group = new Group();
  #flash: Mesh;
  #reticle: Mesh;
  #flashLife = 0;
  #light: PointLight;
  #smokeMaterial: MeshBasicMaterial;
  #smoke: PooledBillboards;
  #muzzlePoint = new Vector3();
  #kick = 0;
  #cooldown = 0;
  #blend = 0;
  #sway = 0;
  #lowered = 0;

  #animation: AnimationPlayer | undefined;
  #clips: ReadonlySet<string>;
  #shootFor = 0;
  #camera: PerspectiveCamera;
  #barrelTipLocal = new Vector3();
  #geometryTipLocal = new Vector3();
  #barrelAxisLocal = new Vector3(0, 0, -1);
  #opticLocal = new Vector3();
  #aimOrigin = new Vector3();
  #aimDirection = new Vector3(0, 0, -1);
  #hasAimRay = false;
  #viewmodelLength = 0;

  constructor(
    camera: PerspectiveCamera,
    viewmodel: Object3D,
    clips: readonly AnimationClip[],
    scene: ThreeScene,
  ) {
    this.#camera = camera;
    // Asset scenes are cached between restarts. Reset the outer transform before measuring so a
    // previous normalisation cannot compound into a giant weapon on the second run.
    viewmodel.removeFromParent();
    viewmodel.position.set(0, 0, 0);
    viewmodel.rotation.set(0, 0, 0);
    viewmodel.scale.setScalar(1);
    normaliseToMetres(viewmodel, { axis: "longest", metres: scale.rifleLength });
    viewmodel.traverse((object) => {
      object.castShadow = false;
      object.receiveShadow = false;
      object.frustumCulled = false;
      // The viewmodel is drawn over the world, so nothing in the yard can clip it.
      const mesh = object as Mesh;
      if (mesh.isMesh === true) mesh.renderOrder = 20;
      // The scope glass is 58% opaque dark navy. It makes the view center black while aiming.
      // Alpha test keeps only the opaque frame, so the window stays clear.
      const material = mesh.material as Material | undefined;
      if (material?.name === "Scope") {
        material.alphaTest = 0.9;
        material.transparent = false;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
    });
    // The fixed half-turn is the authored asset correction; the barrel axis and tip below are
    // measured after this transform, so no caller has to guess where the suppressor ends.
    const fit = new Group();
    fit.rotation.y = Math.PI;
    fit.add(viewmodel);
    this.group.add(fit);
    this.#measureBarrel(fit, viewmodel);
    this.#clips = new Set(clips.map((clip) => clip.name));
    if (clips.length > 0) {
      this.#animation = new AnimationPlayer({ clips, root: fit });
      this.#play("Idle", 0);
    }
    this.group.renderOrder = 20;
    // A suppressed muzzle makes a tight, forward-pointing flame. The old 60 cm
    // camera-facing card sat well to the right of the visible suppressor and could
    // briefly cover most of the frame as an obvious square.
    this.#flash = new Mesh(
      new ConeGeometry(0.055, 0.24, 6, 1, true),
      new MeshBasicMaterial({
        blending: AdditiveBlending,
        color: 0xffd9a0,
        depthWrite: false,
        opacity: 0,
        transparent: true,
      }),
    );
    this.#flash.position.copy(this.#barrelTipLocal);
    this.#flash.quaternion.setFromUnitVectors(UP, this.#barrelAxisLocal);
    // Keep the zero-opacity mesh in the render list so WebGPU compiles this
    // material during loading instead of stalling on the first trigger pull.
    this.#flash.visible = true;
    this.#flash.renderOrder = 30;
    this.group.add(this.#flash);
    // The flash has to light the hands and the barrel, not just draw over them.
    // The light stays in the scene for the whole run with its intensity driven to zero.
    // Toggling `visible` changes the lighting setup, which makes the renderer rebuild every
    // material pipeline that uses it — measured at up to a 1.2 s freeze on the first shot.
    this.#light = new PointLight(0xffc46a, 0, 6, 2);
    this.#light.position.copy(this.#barrelTipLocal);
    this.group.add(this.#light);
    // The dot radius is 1.75 px at 1280x720 with the aim FOV. At the optic distance d, the view
    // is 2 d tan(FOV / 2) meters tall. It spans 720 px, so one pixel is that height divided by 720.
    const opticDistance = -(AIM_Z + this.#opticLocal.z);
    const halfFov = MathUtils.degToRad(FIRST_PERSON.aimFov) / 2;
    const metresPerPixel = (2 * opticDistance * Math.tan(halfFov)) / 720;
    this.#reticle = new Mesh(
      new CircleGeometry(1.75 * metresPerPixel, 16),
      new MeshBasicMaterial({
        color: 0xff2a2a,
        depthTest: false,
        opacity: 0,
        toneMapped: false,
        transparent: true,
      }),
    );
    this.#reticle.position.copy(this.#opticLocal);
    this.#reticle.renderOrder = 31;
    this.group.add(this.#reticle);
    // Smoke lives in world space, not on the camera, so it stays where it was made when you
    // turn — smoke welded to the viewmodel slides with the view and reads as a bug. The
    // shared billboard pool keeps every puff present at zero opacity from the first frame.
    this.#smokeMaterial = new MeshBasicMaterial({
      color: 0xc3c8d0,
      depthWrite: false,
      map: softCircleDataTexture(64, 0.05),
      opacity: 0.42,
      transparent: true,
    });
    this.#smoke = new PooledBillboards(scene, {
      count: 8,
      geometry: new PlaneGeometry(0.22, 0.22),
      materialPrototype: this.#smokeMaterial,
      renderOrder: 29,
    });
    camera.add(this.group);
    this.#apply(0, 0);
  }

  /** Measure the final-scale viewmodel in group space, including the visible suppressor tip. */
  #measureBarrel(fit: Group, viewmodel: Object3D): void {
    fit.updateWorldMatrix(true, true);
    const worldBounds = new Box3().setFromObject(viewmodel);
    const fitInverse = fit.matrixWorld.clone().invert();
    const fitBounds = new Box3();
    for (const x of [worldBounds.min.x, worldBounds.max.x]) {
      for (const y of [worldBounds.min.y, worldBounds.max.y]) {
        for (const z of [worldBounds.min.z, worldBounds.max.z]) {
          fitBounds.expandByPoint(new Vector3(x, y, z).applyMatrix4(fitInverse));
        }
      }
    }
    const tipInFit = new Vector3(
      (fitBounds.min.x + fitBounds.max.x) / 2,
      (fitBounds.min.y + fitBounds.max.y) / 2,
      fitBounds.max.z,
    );
    this.#geometryTipLocal.copy(tipInFit).applyMatrix4(fit.matrix);
    this.#barrelTipLocal.copy(this.#geometryTipLocal);
    // The asset's forward +z transformed through the fit's half-turn is the visible -z barrel
    // axis. Object3D's +z convention makes this less error-prone than a hand-typed direction.
    this.#barrelAxisLocal.set(0, 0, 1).applyQuaternion(fit.quaternion).normalize();
    const size = fitBounds.getSize(new Vector3());
    this.#viewmodelLength = Math.max(size.x, size.y, size.z);
    let namedOptic: Object3D | undefined;
    viewmodel.traverse((object) => {
      if (namedOptic === undefined && /sight|optic|rail|dot/i.test(object.name))
        namedOptic = object;
    });
    if (namedOptic !== undefined) {
      this.#opticLocal
        .copy(fit.worldToLocal(namedOptic.getWorldPosition(new Vector3())))
        .applyMatrix4(fit.matrix);
      return;
    }

    // This viewmodel has no optic node. Select the compact mesh at the top of the receiver as a
    // geometric rail fallback; hands and the long receiver are deliberately excluded by size.
    const overall = fitBounds.getSize(new Vector3());
    const candidate = new Box3();
    let bestScore = Number.POSITIVE_INFINITY;
    viewmodel.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh !== true) return;
      const world = new Box3().setFromObject(mesh);
      const local = new Box3();
      for (const x of [world.min.x, world.max.x]) {
        for (const y of [world.min.y, world.max.y]) {
          for (const z of [world.min.z, world.max.z]) {
            local.expandByPoint(new Vector3(x, y, z).applyMatrix4(fitInverse));
          }
        }
      }
      const meshSize = local.getSize(new Vector3());
      const compact = meshSize.y < overall.y * 0.5 && meshSize.z < overall.z * 0.35;
      if (!compact || local.max.y < fitBounds.max.y - overall.y * 0.35) return;
      const score = Math.abs(local.getCenter(new Vector3()).z - this.#barrelTipLocal.z * 0.28);
      if (score < bestScore) {
        bestScore = score;
        candidate.copy(local);
      }
    });
    if (bestScore < Number.POSITIVE_INFINITY) {
      const center = candidate.getCenter(new Vector3());
      center.y = candidate.max.y - (candidate.max.y - candidate.min.y) * SIGHT_WINDOW_FROM_TOP;
      this.#opticLocal.copy(center).applyMatrix4(fit.matrix);
    } else {
      this.#opticLocal
        .set(
          (fitBounds.min.x + fitBounds.max.x) / 2,
          fitBounds.max.y - overall.y * 0.16,
          fitBounds.max.z - overall.z * 0.42,
        )
        .applyMatrix4(fit.matrix);
    }
  }

  get ready(): boolean {
    return !this.reloading && this.ammo > 0 && this.#cooldown <= 0;
  }

  /**
   * One round, if the action is cycled. The scene calls this every frame the trigger is held;
   * the cyclic cooldown here decides which of those frames actually sends a round, so
   * hold-to-fire and a single tap run through exactly the same path.
   */
  fire(): boolean {
    if (!this.ready) return false;
    this.#cooldown = CYCLIC_SECONDS;
    this.ammo -= 1;
    this.shots += 1;
    this.#kick = 1;
    this.#shootFor = 0.12;
    this.#play("Shoot", 0.02);
    this.#flashLife = 0.045;
    (this.#flash.material as MeshBasicMaterial).opacity = 1;
    this.#flash.rotateOnAxis(this.#barrelAxisLocal, this.shots * 1.7);
    this.#flash.scale.setScalar(0.8 + ((this.shots * 37) % 10) / 25);
    this.#light.intensity = 3.5;
    this.#spawnSmoke();
    return true;
  }

  /** World-space muzzle ray from the measured barrel tip along the measured barrel axis. */
  barrelRay(): AimRay {
    this.group.updateWorldMatrix(true, false);
    return {
      origin: this.group.localToWorld(this.#barrelTipLocal.clone()),
      direction: this.#barrelAxisLocal
        .clone()
        .applyQuaternion(this.group.getWorldQuaternion(new Quaternion()))
        .normalize(),
    };
  }

  /** Two puffs at the muzzle, in world space so they hang in the air as the view turns. */
  #spawnSmoke(): void {
    this.#muzzlePoint.copy(this.barrelRay().origin);
    for (let index = 0; index < 2; index += 1) {
      const spin = this.shots * 2.399 + index;
      this.#smoke.spawn({
        at: this.#muzzlePoint,
        drift: new Vector3(
          Math.sin(spin) * 0.24,
          0.5 + ((index * 7) % 3) * 0.1,
          Math.cos(spin) * 0.24,
        ),
        life: 0.6,
        opacity: 0.42,
        scaleFrom: 0.2,
        scaleTo: 0.2 + 0.6 * 1.1,
      });
    }
  }

  /** Drift, grow and fade the muzzle smoke. `eye` keeps the billboards facing the camera. */
  updateSmoke(dt: number, eye: Vector3): void {
    this.#smoke.update(dt, eye);
  }

  reload(ctx: GameCtx): void {
    if (this.reloading || this.reserve <= 0 || this.ammo >= MAGAZINE) return;
    this.reloading = true;
    this.onMagOut?.();
    this.#play("Reload", 0.05);
    ctx.after(RELOAD_SECONDS, () => {
      const moved = Math.min(MAGAZINE - this.ammo, this.reserve);
      this.ammo += moved;
      this.reserve -= moved;
      this.reloads += 1;
      this.reloading = false;
      this.onMagIn?.();
    });
  }

  #play(name: string, fade = 0.14): void {
    if (this.#animation === undefined || !this.#clips.has(name)) return;
    if (this.#animation.current === name) return;
    this.#animation.play(name, { fade });
  }

  converge(origin: Vector3, direction: Vector3): void {
    this.#aimOrigin.copy(origin);
    this.#aimDirection.copy(direction).normalize();
    this.#hasAimRay = true;
  }

  /**
   * Retire the visible effects of a shot: the muzzle cone, its point light, and the kick.
   *
   * Separate from `update` because it must run on frames where the game is not being played —
   * the end card, a paused round. `update` used to own it, `update` only ran while the phase was
   * "playing", and a round fired on the frame the clock expired therefore left the cone and its
   * light burning on screen for as long as the end card was up.
   *
   * `update` calls this itself, so a scene that always updates the rifle needs nothing extra.
   */
  decay(dt: number): void {
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    this.#flashLife = Math.max(0, this.#flashLife - dt);
    (this.#flash.material as MeshBasicMaterial).opacity = Math.min(1, this.#flashLife / 0.025);
    this.#light.intensity = Math.max(0, this.#light.intensity - dt * 90);
    this.#kick = Math.max(0, this.#kick - dt * 7);
  }

  /** Let the smoke pool stop drawing its spent cards once their pipelines exist. */
  settlePools(): void {
    this.#smoke.settle();
  }

  /** Peak opacity of the muzzle cone. A playtest reads this to prove the flash retires. */
  get flashOpacity(): number {
    return (this.#flash.material as MeshBasicMaterial).opacity;
  }

  update(dt: number, aiming: boolean, moving: number): void {
    this.#shootFor = Math.max(0, this.#shootFor - dt);
    if (this.reloading) this.#play("Reload");
    else if (this.#shootFor > 0) this.#play("Shoot", 0.02);
    else if (moving > 0.6) this.#play("Run");
    else if (moving > 0.05) this.#play("Walk");
    else this.#play("Idle");
    this.#animation?.update(dt);
    this.decay(dt);
    // The sights drop while the magazine is out and come back up after.
    const wantLowered = this.reloading ? 1 : 0;
    this.#lowered += (wantLowered - this.#lowered) * Math.min(1, dt * 9);
    this.#blend += ((aiming && !this.reloading ? 1 : 0) - this.#blend) * Math.min(1, dt * 12);
    this.#sway += dt * (2.6 + moving * 4.4);
    this.#apply(moving, dt);
  }

  #apply(moving: number, _dt: number): void {
    const t = this.#blend;
    const hipMotion = 1 - t;
    const bob = Math.sin(this.#sway) * 0.008 * (0.35 + moving) * hipMotion;
    const bobY = Math.abs(Math.cos(this.#sway)) * 0.01 * (0.25 + moving) * hipMotion;
    const kick = this.#kick * this.#kick;
    this.group.position.set(
      HIP.x + (-this.#opticLocal.x - HIP.x) * t + bob,
      HIP.y + (-this.#opticLocal.y - HIP.y) * t + bobY - this.#lowered * 0.34,
      HIP.z + (AIM_Z - HIP.z) * t + kick * 0.045,
    );
    this.group.rotation.set(
      HIP.pitch - kick * 0.05 + this.#lowered * 0.5,
      HIP.yaw * (1 - t),
      HIP.roll * (1 - t) + this.#lowered * 0.18,
    );
    // The red dot shows only at full aim. Opacity keeps it in the render list, as the flash does.
    (this.#reticle.material as MeshBasicMaterial).opacity = this.#blend > 0.9 ? 1 : 0;
    if (!this.#hasAimRay) return;

    const target = this.#aimOrigin.clone().addScaledVector(this.#aimDirection, ZERO_DISTANCE);
    const current = this.barrelRay();
    const desired = target.sub(current.origin).normalize();
    const parentQuaternion =
      this.group.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
    const desiredParent = desired.applyQuaternion(parentQuaternion.clone().invert());
    const currentParent = this.#barrelAxisLocal.clone().applyQuaternion(this.group.quaternion);
    const correction = new Quaternion().setFromUnitVectors(currentParent, desiredParent);
    const maxAngle = MathUtils.degToRad(MAX_CONVERGENCE_DEGREES);
    const angle = 2 * Math.acos(MathUtils.clamp(correction.w, -1, 1));
    if (angle > maxAngle) correction.slerp(new Quaternion(), maxAngle / angle);
    this.group.quaternion.premultiply(correction);
  }

  debug(): {
    barrelAxisErrorDeg: number;
    flashOpacity: number;
    muzzleLocal: number[];
    tipGapToGeometry: number;
    opticScreen: { x: number; y: number };
    viewmodelLength: number;
  } {
    const ray = this.barrelRay();
    const cameraDirection = this.#camera.getWorldDirection(new Vector3()).normalize();
    const optic = this.group.localToWorld(this.#opticLocal.clone()).project(this.#camera);
    return {
      barrelAxisErrorDeg: MathUtils.radToDeg(ray.direction.angleTo(cameraDirection)),
      // Zero once the shot has retired. A non-zero reading long after the last round is the
      // stuck-flash bug, and it is the only way a gate can see it.
      flashOpacity: this.flashOpacity,
      muzzleLocal: this.#barrelTipLocal.toArray(),
      tipGapToGeometry: this.#flash.position.distanceTo(this.#geometryTipLocal),
      opticScreen: { x: (optic.x + 1) / 2, y: (1 - optic.y) / 2 },
      viewmodelLength: this.#viewmodelLength,
    };
  }

  dispose(): void {
    this.#animation?.dispose();
    this.group.removeFromParent();
  }
}
