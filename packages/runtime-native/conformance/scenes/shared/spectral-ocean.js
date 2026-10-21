import { float, instanceIndex, positionLocal, vec3 } from "three/tsl";
import * as THREE from "three/webgpu";
import { SpectralOcean } from "../../../../core/src/ocean/spectral.ts";
import { warmUpScene } from "../../../../core/src/warmup.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * The tuning is the scene's, not the class's: every number here is a look or physics decision a
 * game owns. Fixed values keep the field identical on both hosts, which is the only reason two
 * captures of a stochastic ocean can be compared at all.
 */
const OCEAN = {
  amplitude: 4e-4,
  cascades: [{ patchSize: 200 }, { patchSize: 40 }],
  choppiness: 1.1,
  directionality: 2,
  gravity: 9.81,
  readbackEveryFrames: 1,
  readbackResolution: 16,
  resolution: 32,
  seed: 1234,
  smallWaveCutoff: 0.4,
  windDirection: 0.6,
  windSpeed: 12,
};

const SIMULATION_STEPS = 8;
const STEP_SECONDS = 1 / 60;
const HEIGHT_SAMPLES_PER_SIDE = 16;
/** Frames of rendering allowed for the asynchronous copy to land before the row fails. */
const READBACK_FRAME_BUDGET = 120;
const GRID_EXTENT = 2.6;
const HEIGHT_GAIN = 0.55;

/**
 * The `IRendererLike` slice `SpectralOcean` consumes, over the raw renderer this harness owns.
 *
 * `readback` delegates exactly as the package's renderer wrapper does — `getArrayBufferAsync` when
 * the host offers it, a named throw when it does not — so a host without the call fails this row
 * with the reason rather than quietly handing back an ocean with no height.
 */
export function oceanRenderer(renderer) {
  return {
    compute: (node) => renderer.compute(node),
    readback: (attribute) => {
      if (typeof renderer.getArrayBufferAsync !== "function") {
        throw new Error("spectral ocean readback requires getArrayBufferAsync on the renderer");
      }
      return renderer.getArrayBufferAsync(attribute);
    },
  };
}

/**
 * Reads the CPU height copy across one patch, or `null` while nothing has landed.
 *
 * It goes through `sampleHeight` on purpose: that query, with its reported age, is the whole
 * contract this class offers over an analytic wave field.
 */
export function sampleHeightField(ocean, patchSize, samplesPerSide) {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let staleFrames = null;
  for (let row = 0; row < samplesPerSide; row += 1) {
    for (let column = 0; column < samplesPerSide; column += 1) {
      const sample = ocean.sampleHeight(
        (column * patchSize) / samplesPerSide,
        (row * patchSize) / samplesPerSide,
      );
      if (sample === undefined) return null;
      if (!Number.isFinite(sample.height)) return { finite: false, staleFrames: sample.staleFrames };
      staleFrames = sample.staleFrames;
      minimum = Math.min(minimum, sample.height);
      maximum = Math.max(maximum, sample.height);
    }
  }
  return { finite: true, maximum, minimum, span: maximum - minimum, staleFrames };
}

/**
 * The observations this row exists to make, all of them fail-closed.
 *
 * A field that never landed, a flat field, or a height with no reported age each mean the copy off
 * the GPU did not happen the way the class promises, and each is indistinguishable from a working
 * ocean in a screenshot.
 */
export function assertSpectralOceanProof(ocean, field, steps) {
  if (ocean?.readbackFloats !== OCEAN.readbackResolution ** 2 * 2) {
    throw new Error("spectral ocean proof requires the height query to be switched on.");
  }
  if (ocean.steps !== steps) {
    throw new Error(`spectral ocean proof expected ${steps} dispatched simulation steps.`);
  }
  if (field === null) {
    throw new Error(
      "spectral ocean proof requires a landed height readback; none arrived within the frame budget.",
    );
  }
  if (field.finite !== true) {
    throw new Error("spectral ocean proof requires finite heights in the copied field.");
  }
  if (!(field.span > 1e-4)) {
    throw new Error(
      `spectral ocean proof requires a non-flat height field; span was ${String(field.span)}.`,
    );
  }
  if (!Number.isInteger(field.staleFrames) || field.staleFrames < 0) {
    throw new Error("spectral ocean proof requires every height to report its age in frames.");
  }
}

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
    "spectral-ocean",
    async ({ camera, renderer, scene }) => {
      const ocean = new SpectralOcean(OCEAN);
      scene.add(ocean);
      const oceanHost = oceanRenderer(renderer);
      ocean.attachRenderer(oceanHost);

      const spacing = GRID_EXTENT / OCEAN.resolution;
      const displacement = ocean.cascadeDisplacement(0);
      const detail = ocean.cascadeDisplacement(1);
      const gridSize = float(OCEAN.resolution);
      const index = float(instanceIndex);
      const column = index.mod(gridSize);
      const row = index.div(gridSize).floor();
      const wave = displacement.element(instanceIndex);
      const ripple = detail.element(instanceIndex);
      const height = wave.y.add(ripple.y).mul(HEIGHT_GAIN);
      const material = new THREE.MeshBasicNodeMaterial();
      material.positionNode = positionLocal.add(
        vec3(
          column.sub(gridSize.mul(0.5)).mul(spacing),
          height,
          row.sub(gridSize.mul(0.5)).mul(spacing),
        ),
      );
      // Colour is the scene's; the class supplies the number and decides nothing about the water.
      material.colorNode = vec3(0.08, 0.26, 0.46).add(vec3(0.5, 0.42, 0.3).mul(height.mul(1.6)));
      const surface = new THREE.InstancedMesh(
        new THREE.BoxGeometry(spacing * 0.82, spacing * 0.82, spacing * 0.82),
        material,
        OCEAN.resolution * OCEAN.resolution,
      );
      surface.frustumCulled = false;
      const identity = new THREE.Matrix4();
      for (let instance = 0; instance < OCEAN.resolution * OCEAN.resolution; instance += 1) {
        surface.setMatrixAt(instance, identity);
      }
      scene.add(surface);

      const warmup = await warmUpScene(renderer, scene, camera, {
        computeNodes: ocean.warmupNodes,
      });
      assertCondition(
        warmup.computeCompiled === ocean.warmupNodes.length,
        "spectral ocean warm-up must compile every ordered simulation pass",
      );

      // Wave time is dispatched, never read off a clock: the field both hosts capture has to be
      // the same field, and a wall clock guarantees it is not.
      for (let step = 0; step < SIMULATION_STEPS; step += 1) {
        ocean.advance(step * STEP_SECONDS);
        ocean.process(oceanHost);
        renderer.render(scene, camera);
        await settleQueue(renderer);
        await nextFrame();
      }

      let field = sampleHeightField(ocean, OCEAN.cascades[0].patchSize, HEIGHT_SAMPLES_PER_SIDE);
      for (let frame = 0; frame < READBACK_FRAME_BUDGET && field === null; frame += 1) {
        renderer.render(scene, camera);
        await settleQueue(renderer);
        await nextFrame();
        field = sampleHeightField(ocean, OCEAN.cascades[0].patchSize, HEIGHT_SAMPLES_PER_SIDE);
      }
      assertSpectralOceanProof(ocean, field, SIMULATION_STEPS);
      console.log(`SPECTRAL_OCEAN_HEIGHT_FIELD:${JSON.stringify(field)}`);
      console.log(`SPECTRAL_OCEAN_READBACK_STATS:${JSON.stringify(ocean.staleFrames)}`);

      // The simulation stops here. The surface keeps whatever the last dispatch wrote, so the
      // captured frame depends on the step count and not on how many frames each host took.
      return {
        ocean,
        surface,
        detail: {
          cascades: OCEAN.cascades.length,
          heightSpan: Number(field.span.toFixed(6)),
          readbackFloats: ocean.readbackFloats,
          simulationSteps: ocean.steps,
          staleFrames: field.staleFrames,
          warmupNodes: ocean.warmupNodes.length,
        },
      };
    },
    {
      background: 0x050a14,
      camera: (size) => {
        const view = new THREE.PerspectiveCamera(48, size.width / size.height, 0.1, 100);
        view.position.set(0, 1.75, 2.85);
        view.lookAt(0, 0, 0);
        return view;
      },
    },
  );
}
