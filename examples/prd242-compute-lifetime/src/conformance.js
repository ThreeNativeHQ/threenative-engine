import { Mesh, MeshBasicNodeMaterial, PlaneGeometry } from "three/webgpu";
// The root package bundles its Three.js dependency; this source-module import keeps this
// conformance bundle on the same Three.js runtime as the scene while exercising the exported
// registry implementation.
import { ComputeDrivenRegistry } from "../../../packages/core/src/compute-driven.ts";
import { createPipelineCensus } from "../../../packages/core/src/pipeline-census.ts";
import { SoftBody3D } from "../../../packages/core/src/softbody.ts";
import { warmUpComputeNodes, warmUpScene } from "../../../packages/core/src/warmup.ts";
import {
  assertCondition,
  startVisualScene,
} from "../../../packages/runtime-native/conformance/scenes/shared/scene-support.js";
import { PingPongField } from "./ping-pong-field.ts";

async function waitForSubmittedWork(renderer) {
  await renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
}

// Cached-pipeline proof: the baseline prepares GPU buffers with zero workgroups first.
async function assertCachedClothWarmupPreservesBuffers(renderer) {
  assertCondition(renderer.backend?.isWebGPUBackend === true, "cloth warmup proof requires WebGPU");
  const cloth = new SoftBody3D(
    new Mesh(new PlaneGeometry(1, 1, 2, 2), new MeshBasicNodeMaterial()),
    {
      damping: 1.8,
      gravity: [0, 0, 0],
      pinned: [0],
      stiffness: 36,
      wind: [0, 0.4, 4.5],
    },
  );
  const attributes = new Set();
  const backend = renderer.backend;
  const originalCreate = backend.createStorageAttribute;
  const census = createPipelineCensus({ kind: "webgpu", adapterIdentity: "conformance-probe" });
  census.installRenderer(renderer);
  backend.createStorageAttribute = function (attribute) {
    attributes.add(attribute);
    return originalCreate.call(this, attribute);
  };
  try {
    // The engine's warm-up compiles through three 0.187's compile-only path
    // (src/renderers/common/Renderer.js:1359, `compileComputeAsync`): nothing is dispatched.
    await warmUpComputeNodes(renderer, cloth.warmupNodes);
  } finally {
    backend.createStorageAttribute = originalCreate;
  }
  const pipelines = census
    .snapshot()
    .events.filter((event) => event.kind === "compute" && event.status === "created");
  census.dispose();
  assertCondition(
    pipelines.length === 2,
    "cached cloth baseline must observe both real compute pipelines",
  );
  // This snapshots every solver storage attribute, including both position and velocity pairs.
  assertCondition(
    attributes.size >= 4,
    "cloth proof must capture all four nonempty solver buffers",
  );
  const snapshots = async () =>
    Promise.all(
      [...attributes].map(async (attribute) => {
        const bytes = new Uint8Array(await renderer.getArrayBufferAsync(attribute));
        assertCondition(bytes.byteLength > 0, "cloth GPU readback must not be empty");
        return bytes.slice();
      }),
    );
  const before = await snapshots();
  let calls = 0;
  let clock = 0;
  let completion;
  let report;
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  const seam = {
    backend,
    compileComputeAsync(node) {
      calls += 1;
      completion = renderer.compileComputeAsync(node);
      clock = 20;
      return completion;
    },
  };
  // Controlled deadline, not a wall-clock timeout; GPU dispatch and readback remain real.
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    report = await warmUpComputeNodes(seam, cloth.warmupNodes, {
      budgetMs: 10,
      compileTimeoutMs: 10,
    });
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(performance, "now");
    else Object.defineProperty(performance, "now", descriptor);
  }
  assertCondition(completion?.then !== undefined, "cloth proof must await its real GPU delegate");
  await completion;
  await waitForSubmittedWork(renderer);
  const after = await snapshots();
  assertCondition(
    calls === 1 && report.compiled === 0 && report.timedOut && report.abandoned === 2,
    `cached cloth warmup must time out during the first half of its ordered pair: ${JSON.stringify({ calls, report })}`,
  );
  const equal = (left, right) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  assertCondition(
    before.every((bytes, index) => equal(bytes, after[index])),
    "cached cloth warmup mutated live GPU storage at its controlled half-pair deadline",
  );
  cloth.process({ kind: "webgpu", compute: (node) => renderer.compute(node) });
  await waitForSubmittedWork(renderer);
  const advanced = await snapshots();
  const changed = after.filter((bytes, index) => !equal(bytes, advanced[index])).length;
  assertCondition(
    changed >= 4,
    "the next real cloth solver step must mutate both position and velocity pairs",
  );
  cloth.detach();
  const detail = {
    pipelines: pipelines.length,
    buffers: before.length,
    unchanged: true,
    changed,
    calls,
    report,
    deadline: { budgetMs: 10, start: 0, end: 20 },
  };
  console.info(`TN_COMPUTE_WARMUP_CACHED_CONTROLLED:${JSON.stringify(detail)}`);
  return detail;
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "compute-driven-lifetime",
    async ({ camera, renderer, scene }) => {
      const cachedClothWarmup = await assertCachedClothWarmupPreservesBuffers(renderer);
      const registry = new ComputeDrivenRegistry();
      const add = (object) => {
        scene.add(object);
        registry.add(object, renderer);
        return object;
      };
      const warm = async () => {
        assertCondition(
          registry.warmupNodes.length === 2,
          "compute registry must expose two warmup kernels",
        );
        const report = await warmUpScene(renderer, scene, camera, {
          computeNodes: registry.warmupNodes,
        });
        assertCondition(
          report.computeCompiled === 2,
          "compute registry kernels must warm before conformance dispatch",
        );
      };
      let releases = 0;
      const first = add(
        new PingPongField({
          onRelease: () => {
            releases += 1;
          },
        }),
      );
      await warm();
      for (let index = 0; index < 4; index += 1) registry.process(renderer);
      await waitForSubmittedWork(renderer);
      registry.clear();
      assertCondition(first.released, "the outgoing compute field must release on scene removal");
      first.removeFromParent();

      const second = add(
        new PingPongField({
          onRelease: () => {
            releases += 1;
          },
        }),
      );
      second.position.x = 0.02;
      await warm();
      for (let index = 0; index < 4; index += 1) registry.process(renderer);
      await waitForSubmittedWork(renderer);

      assertCondition(second.steps === 4, "the replacement compute field must advance");
      assertCondition(
        second.passOneDispatches === 4 && second.passTwoDispatches === 4,
        "both ordered compute passes must run on every fixed-step equivalent",
      );
      assertCondition(releases === 1, "exactly the outgoing field must be released");
      return {
        field: second,
        detail: {
          cachedClothWarmup,
          attachments: 2,
          firstReleased: first.released,
          passesPerStep: 2,
          pingPong: true,
          releases,
          replacementSteps: second.steps,
          warmupNodes: second.warmupNodes.length,
        },
      };
    },
  );
}
