import { vec3 } from "three/tsl";
import * as three from "three/webgpu";
import { FluidParticles3D } from "../../../packages/core/src/fluid-particles.ts";
import { warmUpScene } from "../../../packages/core/src/warmup.ts";
import {
  assertCondition,
  startVisualScene,
} from "../../../packages/runtime-native/conformance/scenes/shared/scene-support.js";

const STEPS = 90;
const BOUNDS = { min: [-1.1, 0.0968, -0.55], max: [1.1, 2, 0.55] };

function isNativeConformanceRuntime() {
  return String(globalThis.__TN_ASSET_BASE__ ?? "").endsWith(":0/");
}

async function waitForSubmittedWork(renderer) {
  await renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
}

/** A small block of water drops, splashes and settles; the same passes run on web and desktop. */
export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "fluid-particles",
    async ({ camera, renderer, scene }) => {
      const water = new FluidParticles3D({
        bounds: BOUNDS,
        capacity: 600,
        readbackEvery: 1,
        spacing: 0.22,
      });
      const computeRenderer = {
        kind: "webgpu",
        compute: (node) => renderer.compute(node),
        readback: (attribute) => renderer.getArrayBufferAsync(attribute),
      };
      water.attachRenderer(computeRenderer);
      const warmup = await warmUpScene(renderer, scene, camera, {
        computeNodes: water.warmupNodes,
      });
      assertCondition(
        warmup.computeCompiled === water.warmupNodes.length,
        "fluid particles warm-up must compile every ordered solver pass",
      );

      const placed = water.fill([-0.9, 0.9, -0.44], [-0.1, 1.8, 0.44]);
      assertCondition(placed >= 100, `fluid particles must place a block, placed ${placed}`);
      for (let index = 0; index < STEPS; index += 1) water.process(computeRenderer);
      await waitForSubmittedWork(renderer);
      assertCondition(water.steps === STEPS, "fluid particles must advance every fixed step");

      let stats = null;
      if (!isNativeConformanceRuntime()) {
        // The readback lands asynchronously; give it a few frames before judging the solver.
        for (let attempt = 0; attempt < 40 && water.stats === undefined; attempt += 1) {
          water.process(computeRenderer);
          await waitForSubmittedWork(renderer);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        stats = water.stats ?? null;
        assertCondition(stats !== null, "fluid particles stats readback must land on web");
        assertCondition(
          stats.count === placed,
          `live particles ${stats.count} must equal ${placed}`,
        );
        assertCondition(
          stats.meanCompression < 0.05,
          `compression ${stats.meanCompression} must stay low`,
        );
        for (let axis = 0; axis < 3; axis += 1) {
          assertCondition(
            stats.min[axis] >= BOUNDS.min[axis] - 0.01 &&
              stats.max[axis] <= BOUNDS.max[axis] + 0.01,
            "fluid particles must stay inside their bounds",
          );
        }
        console.log(`FLUID_PARTICLES_STATS:${JSON.stringify(stats)}`);
      } else {
        console.log(
          "FLUID_PARTICLES_READBACK:skipped; native readback is verified by parity capture",
        );
      }

      const material = new three.SpriteNodeMaterial({ depthWrite: true });
      const particle = water.positions.toAttribute();
      material.positionNode = particle.xyz;
      material.scaleNode = particle.w.mul(0.17);
      material.colorNode = vec3(0.25, 0.75, 1);
      const points = new three.Sprite(material);
      points.count = water.capacity;
      points.frustumCulled = false;
      scene.add(points);
      camera.position.set(0, 1.2, 4.2);
      camera.lookAt(0, 0.8, 0);

      // The solver keeps stepping per frame so a capture sees the same settled state on both hosts.
      return {
        detail: {
          fixedSteps: water.steps,
          particles: placed,
          meanCompression: stats === null ? null : Number(stats.meanCompression.toFixed(6)),
          warmupNodes: water.warmupNodes.length,
        },
        mesh: points,
        water,
      };
    },
    { background: 0x05070e },
  );
}
