import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  cos,
  float,
  fract,
  instanceIndex,
  mix,
  sin,
  time,
  uint,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { GPUParticles3D } from "../../../../core/src/particles.js";
import { startVisualScene } from "./scene-support.js";

const PARTICLE_COUNT = 64;

export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "vfx-spawn-requests", ({ renderer, scene, camera }) => {
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    material.scaleNode = vec2(0.12);
    const particles = new GPUParticles3D({
      amount: PARTICLE_COUNT,
      material,
      spawn: (buffers, request) => {
        const age = time.sub(buffers.births.toAttribute());
        const phase = varying(age.div(0.5).clamp(0, 1));
        const alive = varying(age.greaterThanEqual(0).and(age.lessThan(0.5)).select(1, 0));
        material.colorNode = vec4(
          mix(vec3(1, 0.8, 0.3), vec3(1, 0.2, 0.05), phase),
          alive,
        );
        return Fn(() => {
          If(instanceIndex.lessThan(request.count), () => {
            const slot = request.first.add(instanceIndex).mod(uint(PARTICLE_COUNT));
            buffers.velocities.element(slot).assign(request.origin);
            buffers.positions.element(slot).assign(request.origin);
          });
        })().compute(PARTICLE_COUNT);
      },
      process: (buffers, runtime) => Fn(() => {
        const slot = float(instanceIndex);
        const angle = slot.mul(2.399963);
        const speed = fract(slot.mul(0.618034)).mul(1.4).add(0.6);
        const direction = vec3(cos(angle), 0.35, sin(angle)).normalize();
        const age = runtime.time.sub(buffers.births.element(instanceIndex));
        const elapsed = age.clamp(0, 0.5);
        buffers.positions.element(instanceIndex).assign(
          buffers.velocities.element(instanceIndex)
            .add(direction.mul(speed).mul(elapsed))
            .add(vec3(0, elapsed.mul(elapsed).mul(-4.9), 0)),
        );
      })().compute(PARTICLE_COUNT),
    });
    particles.attachRenderer({ compute: (node) => renderer.compute(node) });
    scene.add(particles);

    let frame = 0;
    const render = () => {
      if (frame === 1) particles.emitParticle({ count: 24, origin: { x: -0.6, y: 0, z: 0 } });
      if (frame === 4) particles.emitParticle({ count: 24, origin: { x: 0.6, y: 0, z: 0 } });
      const moving = frame > 0 && frame <= 8;
      scene.background.set(moving ? 0x321a42 : 0x090b20);
      if (frame === 0) console.info("TN_CONFORMANCE_TEMPORAL_FRAME:vfx-spawn-requests:frame-zero");
      if (frame === 8) console.info("TN_CONFORMANCE_TEMPORAL_FRAME:vfx-spawn-requests:settled");
      if (frame === 9) console.info("TN_CONFORMANCE_TEMPORAL_FRAME:vfx-spawn-requests:next");
      particles.process();
      renderer.render(scene, camera);
      frame += 1;
      if (frame >= 8) {
        globalThis.__TN_CONFORMANCE_TEMPORAL = {
          effect: "vfx-spawn-requests",
          frame,
          frameZeroRendered: true,
          settledFrameRendered: true,
          nextFrameRendered: frame > 8,
          restoredFrameRendered: frame > 8,
          restoredToFrameZero: frame > 8 && scene.background.getHex() === 0x090b20,
        };
      }
    };
    return {
      detail: { computeDriven: true, sprite: true, spawnRequests: 2, amount: PARTICLE_COUNT },
      particles,
      render,
    };
  }, { background: 0x090b20 });
}
