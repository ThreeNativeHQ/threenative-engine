import { GPUParticles3D, type ICtx, Scene, type SceneFrame } from "@threenative/core";
import {
  Fn,
  If,
  cos,
  deltaTime,
  float,
  hash,
  instanceIndex,
  mix,
  sin,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { createLighting } from "../render/lighting.js";
import { createPostProcessing } from "../render/postprocessing.js";

type AbyssStatus = "attract" | "over" | "play";

const initialState = {
  best: 0,
  elapsed: 0,
  energy: 100,
  fps: 0,
  hull: 100,
  hunters: 0,
  playerX: 0,
  pulsing: false,
  score: 0,
  status: "attract" as AbyssStatus,
};

export type AbyssState = typeof initialState;

/** React asks for a run by dispatching this; the scene owns what starting means. */
export const START_EVENT = "abyss:start";

type AbyssCtx = ICtx<AbyssState>;
type Pearl = { drift: THREE.Vector2; mesh: THREE.Mesh };
type Hunter = { mesh: THREE.Mesh; speed: number; spin: number };

const PLANKTON = 90_000;
const VIEW = 520;
const CAMERA_DISTANCE = 6_000;

export class Abyss extends Scene<AbyssState> {
  static override readonly initialState = initialState;

  #startCleanup: (() => void) | undefined;

  override enter(ctx: AbyssCtx): SceneFrame<AbyssState> {
    const camera = ctx.camera as THREE.OrthographicCamera;
    camera.position.set(0, 0, CAMERA_DISTANCE);
    camera.lookAt(0, 0, 0);
    ctx.viewport.resize();
    ctx.scene.background = new THREE.Color(0x04080d);
    ctx.add(createLighting());

    const field = { d: 320, h: VIEW * 2, w: VIEW * 2 * ctx.viewport.size.aspect };

    /* ------------------------------------------------------- plankton (GPU) */

    const uLamp = uniform(new THREE.Vector3());
    const uField = uniform(new THREE.Vector3(field.w, field.h, field.d));
    const uReach = uniform(210);
    const uPull = uniform(150);

    const rimSpawn = Fn(() => {
      const a = hash(instanceIndex).mul(6.2831853).add(time.mul(1.7));
      const r = hash(instanceIndex.add(31)).mul(0.35).add(0.62);
      return vec3(
        cos(a).mul(uField.x.mul(0.5).mul(r)),
        sin(a).mul(uField.y.mul(0.5).mul(r)),
        hash(instanceIndex.add(97)).sub(0.5).mul(uField.z),
      );
    });

    const planktonMaterial = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    planktonMaterial.scaleNode = vec2(7);
    const plankton = new GPUParticles3D({
      amount: PLANKTON,
      material: planktonMaterial,
      start: ({ positions, velocities }) => {
        const speed = velocities.toAttribute().length();
        const falloff = float(1).sub(uv().sub(0.5).length().mul(2)).max(0).pow(2.6);
        planktonMaterial.colorNode = vec4(
          mix(vec3(0.09, 0.38, 0.78), vec3(0.52, 0.94, 1), speed.mul(0.007).clamp(0, 1)),
          falloff.mul(0.65),
        );
        return Fn(() => {
          positions
            .element(instanceIndex)
            .assign(
              vec3(
                hash(instanceIndex).sub(0.5).mul(uField.x),
                hash(instanceIndex.add(11)).sub(0.5).mul(uField.y),
                hash(instanceIndex.add(23)).sub(0.5).mul(uField.z),
              ),
            );
          velocities.element(instanceIndex).assign(vec3(0));
        })().compute(PLANKTON);
      },
      process: ({ positions, velocities }) =>
        Fn(() => {
          const pos = positions.element(instanceIndex);
          const vel = velocities.element(instanceIndex);
          const dt = deltaTime.min(1 / 30);
          const toLamp = uLamp.sub(pos);
          const dist = toLamp.length().max(0.001);
          const dir = toLamp.div(dist);
          const acc = vec3(
            sin(pos.y.mul(0.011).add(time.mul(0.47))),
            cos(pos.x.mul(0.009).sub(time.mul(0.41))),
            sin(pos.z.mul(0.021).add(time.mul(0.33))),
          )
            .mul(26)
            .toVar();

          If(dist.lessThan(uReach), () => {
            const pull = float(1).sub(dist.div(uReach));
            acc.addAssign(dir.mul(pull.mul(uPull)));
            acc.addAssign(vec3(dir.y.negate(), dir.x, 0).mul(pull.mul(230)));
          });

          vel.assign(vel.add(acc.mul(dt)).mul(0.984));
          const speed = vel.length();
          If(speed.greaterThan(240), () => {
            vel.assign(vel.mul(float(240).div(speed)));
          });
          pos.addAssign(vel.mul(dt));
          If(dist.lessThan(26), () => {
            pos.assign(rimSpawn());
            vel.assign(vec3(0));
          });
          const half = uField.mul(0.5);
          pos.assign(pos.add(half).div(uField).fract().mul(uField).sub(half));
        })().compute(PLANKTON),
    });
    ctx.add(plankton);

    /* ------------------------------------------------------- entities (CPU) */

    const glowMaterial = (hex: number, intensity = 1) => {
      const material = new THREE.MeshBasicNodeMaterial({ toneMapped: false });
      material.color = new THREE.Color(hex).multiplyScalar(intensity);
      return material;
    };
    const lure = new THREE.Mesh(new THREE.SphereGeometry(11, 24, 16), glowMaterial(0xffd27a, 2.2));
    ctx.add(lure);

    const halo = new THREE.Sprite(
      new THREE.SpriteNodeMaterial({
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    halo.material.colorNode = vec4(
      vec3(1, 0.78, 0.42),
      float(1).sub(uv().sub(0.5).length().mul(2)).max(0).pow(3).mul(0.85),
    );
    halo.scale.setScalar(170);
    ctx.add(halo);

    const pearls: Pearl[] = [];
    const pearlGeometry = new THREE.SphereGeometry(9, 20, 14);
    const pearlMaterial = glowMaterial(0x6fe8ff, 2.6);
    for (let index = 0; index < 6; index += 1) {
      const mesh = new THREE.Mesh(pearlGeometry, pearlMaterial);
      ctx.add(mesh);
      pearls.push({ drift: new THREE.Vector2(), mesh });
    }

    const hunters: Hunter[] = [];
    const hunterGeometry = new THREE.IcosahedronGeometry(15, 0);
    const hunterMaterial = glowMaterial(0x8a6bff, 2);
    const spawnHunter = () => {
      const mesh = new THREE.Mesh(hunterGeometry, hunterMaterial);
      const angle = ctx.random() * Math.PI * 2;
      mesh.position.set(Math.cos(angle) * field.w * 0.55, Math.sin(angle) * field.h * 0.55, 0);
      ctx.add(mesh);
      hunters.push({ mesh, speed: 96 + ctx.random() * 40, spin: ctx.random() * 2 - 1 });
    };
    const placePearl = (pearl: Pearl, index: number, randomize = true) => {
      const phase = index * 2.3999632297;
      if (index === 0) {
        pearl.mesh.position.set(125, 0, 0);
      } else {
        pearl.mesh.position.set(
          randomize ? (ctx.random() - 0.5) * field.w * 0.86 : Math.sin(phase) * field.w * 0.38,
          randomize
            ? (ctx.random() - 0.5) * field.h * 0.86
            : Math.cos(phase * 1.17) * field.h * 0.38,
          0,
        );
      }
      pearl.drift.set(
        randomize ? (ctx.random() - 0.5) * 40 : Math.cos(phase) * 18,
        randomize ? (ctx.random() - 0.5) * 40 : Math.sin(phase * 1.17) * 18,
      );
    };

    ctx.renderer.setOutputNode(createPostProcessing(ctx.scene, camera));

    let status: AbyssStatus = "attract";
    let score = 0;
    let hull = 100;
    let energy = 100;
    let elapsed = 0;
    let nextHunter = 6;
    let best = 0;
    let simulationTime = 0;
    const target = new THREE.Vector2();
    const temporary = new THREE.Vector3();
    // Seeded from the live pointer, not from NaN: an unequal first comparison
    // would hand steering to a pointer that has never moved, whose default
    // (0, 0) maps to the top-left corner of the field.
    const lastPointer = ctx.input.raw.pointer.position.clone();
    let usingPointer = false;

    ctx.entities.add("player", {
      debug: () => ({ hull, position: lure.position.toArray(), score }),
      mesh: lure,
    });

    const publish = (pulsing: boolean) => {
      ctx.state.set({
        best,
        elapsed,
        energy,
        fps: ctx.fps,
        hull,
        hunters: hunters.length,
        playerX: lure.position.x,
        pulsing,
        score,
        status,
      });
    };
    const start = () => {
      status = "play";
      score = 0;
      hull = 100;
      energy = 100;
      elapsed = 0;
      nextHunter = 6;
      lure.position.set(0, 0, 0);
      target.set(0, 0);
      for (const hunter of hunters) hunter.mesh.removeFromParent();
      hunters.length = 0;
      spawnHunter();
      pearls.forEach((pearl, index) => placePearl(pearl, index));
      publish(false);
      // React renders on a 10Hz throttle; flush so the veil clears immediately.
      ctx.state.flush();
    };
    globalThis.addEventListener(START_EVENT, start);
    this.#startCleanup = () => {
      globalThis.removeEventListener(START_EVENT, start);
    };
    pearls.forEach((pearl, index) => placePearl(pearl, index, false));

    return (frameCtx, dt) => {
      field.w = VIEW * 2 * frameCtx.viewport.size.aspect;
      uField.value.x = field.w;
      simulationTime += dt;
      const now = simulationTime * 1_000;
      const move = frameCtx.input.vector("move");
      const pulse = frameCtx.input.pressed("pulse") && energy > 1;

      camera.position.z = THREE.MathUtils.clamp(
        camera.position.z - frameCtx.input.axis("zoom") * CAMERA_DISTANCE * 0.5 * dt,
        CAMERA_DISTANCE * 0.75,
        CAMERA_DISTANCE * 1.25,
      );
      camera.zoom = CAMERA_DISTANCE / camera.position.z;
      camera.updateProjectionMatrix();

      if (status !== "play" && frameCtx.input.pressed("start")) start();

      // Last device to move wins, the way the vanilla build switches between
      // pointAt() and the WASD branch.
      const pointer = frameCtx.input.raw.pointer.position;
      if (!lastPointer.equals(pointer)) {
        lastPointer.copy(pointer);
        usingPointer = true;
      }
      if (move.lengthSq() > 0) usingPointer = false;

      if (status === "play") {
        elapsed += dt;
        const speed = 560 * dt;
        if (usingPointer) {
          const world = ctx.viewport.projectPosition(pointer);
          target.set(world.x, world.y);
        } else {
          target.x += move.x * speed;
          target.y += move.y * speed;
        }
        target.x = THREE.MathUtils.clamp(target.x, -field.w / 2, field.w / 2);
        target.y = THREE.MathUtils.clamp(target.y, -field.h / 2, field.h / 2);
        energy = THREE.MathUtils.clamp(energy + (pulse ? -24 : 13) * dt, 0, 100);
        if (
          pulse &&
          score === 0 &&
          lure.position.distanceTo(pearls[0]?.mesh.position ?? lure.position) < 170
        ) {
          score = 1;
          energy = Math.min(100, energy + 6);
          if (pearls[0] !== undefined) placePearl(pearls[0], 0);
        }
        if (elapsed > nextHunter && hunters.length < 12) {
          nextHunter += 10;
          spawnHunter();
        }
      } else {
        target.set(Math.cos(now / 3_400) * field.w * 0.3, Math.sin(now / 2_600) * field.h * 0.28);
      }

      const ease = 1 - 0.002 ** dt;
      lure.position.x += (target.x - lure.position.x) * ease;
      lure.position.y += (target.y - lure.position.y) * ease;
      lure.scale.setScalar(1 + (pulse ? 0.18 : 0));
      halo.position.copy(lure.position);
      halo.scale.setScalar(150 + (pulse ? 220 : 0));
      uLamp.value.copy(lure.position);
      uReach.value = 200 + (pulse ? 300 : 0);
      uPull.value = 150 + (pulse ? 620 : 0);

      for (const pearl of pearls) {
        pearl.mesh.position.x += pearl.drift.x * dt;
        pearl.mesh.position.y += pearl.drift.y * dt;
        if (Math.abs(pearl.mesh.position.x) > field.w / 2) pearl.drift.x *= -1;
        if (Math.abs(pearl.mesh.position.y) > field.h / 2) pearl.drift.y *= -1;
        pearl.mesh.rotation.y += dt * 1.4;
      }
      for (const hunter of hunters) {
        temporary.subVectors(lure.position, hunter.mesh.position);
        const distance = Math.max(temporary.length(), 0.001);
        temporary.divideScalar(distance).multiplyScalar(hunter.speed * dt);
        hunter.mesh.position.add(temporary);
        hunter.mesh.rotation.x += dt * hunter.spin;
        hunter.mesh.rotation.z += dt * hunter.spin * 0.7;
        if (status === "play" && distance < 30) hull -= 46 * dt;
      }
      if (hull <= 0 && status === "play") {
        hull = 0;
        status = "over";
        best = Math.max(best, score);
      }
      publish(pulse);
    };
  }

  override exit(): void {
    this.#startCleanup?.();
    this.#startCleanup = undefined;
  }
}
