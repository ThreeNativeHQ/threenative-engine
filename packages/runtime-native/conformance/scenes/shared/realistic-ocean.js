import * as THREE from "three/webgpu";
import { warmUpScene } from "../../../../core/src/warmup.ts";
import {
  createRealisticMaps,
  createRealisticSea,
  createRealisticWaterMesh,
} from "../../../../create-threenative/template-assets/realistic-ocean/src/render/realisticSea.ts";
import { oceanRenderer, sampleHeightField } from "./spectral-ocean.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * The opt-in realistic-ocean bundle (PRD-648), built from its shipped source: three cascades, the
 * derivative and foam compute passes, and the slope-variance-filtered material, with no mirror.
 *
 * Wave time is dispatched, never read off a clock, so both hosts capture the same field. The sea
 * is the bundle's own tuning: this row proves the graph and its compute chain execute and draw,
 * and says nothing about whether it is good looking.
 */
const SIMULATION_STEPS = 24;
const STEP_SECONDS = 1 / 30;
const HEIGHT_SAMPLES_PER_SIDE = 16;
/** Frames of rendering allowed for the asynchronous copy to land before the row fails. */
const READBACK_FRAME_BUDGET = 120;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settleQueue(renderer) {
  await renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "realistic-ocean",
    async ({ camera, renderer, scene }) => {
      const ocean = createRealisticSea();
      scene.add(ocean);
      const maps = createRealisticMaps(ocean);
      scene.add(maps);
      const host = oceanRenderer(renderer);
      ocean.attachRenderer(host);
      maps.attachRenderer(host);
      const surface = createRealisticWaterMesh(ocean, maps, undefined, {});
      scene.add(surface.mesh);
      surface.setSun([0.45, 0.35, 0.82]);
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      camera.position.set(0, 14, 0);
      camera.lookAt(0, 0, -34);
      camera.far = 6500;
      camera.updateProjectionMatrix();

      const warmup = await warmUpScene(renderer, scene, camera, {
        computeNodes: [...ocean.warmupNodes, ...maps.warmupNodes],
      });
      assertCondition(
        warmup.computeCompiled === ocean.warmupNodes.length + maps.warmupNodes.length,
        "realistic ocean warm-up must compile every ordered simulation and map pass",
      );

      for (let step = 0; step < SIMULATION_STEPS; step += 1) {
        const seconds = step * STEP_SECONDS;
        ocean.advance(seconds);
        maps.advance(seconds);
        surface.advance(seconds);
        ocean.process(host);
        maps.process(host);
        renderer.render(scene, camera);
        await settleQueue(renderer);
        await nextFrame();
      }

      // Foam must exist after the first run of steps and must have moved after the next: a grid
      // that is never written, or never aged, draws the same picture until the sea breaks.
      const readFoam = async () => {
        const values = new Float32Array(await host.readback(maps.foam(0).value));
        let sum = 0;
        for (const value of values) {
          assertCondition(Number.isFinite(value), "the foam grid must hold finite values");
          sum += value;
        }
        return sum;
      };
      const foamBefore = await readFoam();
      for (let step = SIMULATION_STEPS; step < SIMULATION_STEPS * 2; step += 1) {
        const seconds = step * STEP_SECONDS;
        ocean.advance(seconds);
        maps.advance(seconds);
        surface.advance(seconds);
        ocean.process(host);
        maps.process(host);
        renderer.render(scene, camera);
        await settleQueue(renderer);
        await nextFrame();
      }
      const foamAfter = await readFoam();
      assertCondition(foamBefore > 0, `foam must exist after the first steps, sum ${foamBefore}`);
      assertCondition(
        Math.abs(foamAfter - foamBefore) > 1e-6,
        `foam must evolve between steps, sum stayed ${foamBefore}`,
      );
      console.log(`REALISTIC_OCEAN_FOAM:${JSON.stringify({ foamAfter, foamBefore })}`);

      let field = sampleHeightField(ocean, ocean.cascadePatchSize(0), HEIGHT_SAMPLES_PER_SIDE);
      for (let frame = 0; frame < READBACK_FRAME_BUDGET && field === null; frame += 1) {
        renderer.render(scene, camera);
        await settleQueue(renderer);
        await nextFrame();
        field = sampleHeightField(ocean, ocean.cascadePatchSize(0), HEIGHT_SAMPLES_PER_SIDE);
      }
      assertCondition(ocean.steps === SIMULATION_STEPS * 2, "expected every simulation step dispatched");
      assertCondition(ocean.cascades.length === 3, "the realistic sea has three cascades");
      assertCondition(field !== null, "a height readback must land within the frame budget");
      assertCondition(field.finite === true, "the copied height field must be finite");
      assertCondition(field.span > 1e-3, `the height field must not be flat, span ${field.span}`);
      assertCondition(
        Number.isInteger(field.staleFrames) && field.staleFrames >= 0,
        "every height must report its age in frames",
      );
      console.log(`REALISTIC_OCEAN_HEIGHT_FIELD:${JSON.stringify(field)}`);
      return { detail: { steps: ocean.steps, span: field.span, stale: field.staleFrames } };
    },
    { background: 0x9bb6cf },
  );
}
