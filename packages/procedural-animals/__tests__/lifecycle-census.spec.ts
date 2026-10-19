import {
  BoxGeometry,
  BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import Info from "three/src/renderers/common/Info.js";
import { describe, expect, it } from "vitest";
import { observeGPUResources } from "../../../examples/procedural-animals/src/gpu-resources.js";
import { takeLifecycleCensus } from "../../../examples/procedural-animals/src/lifecycle-census.js";
import { Registry } from "../../core/src/entities.js";
import { GeometryCapture } from "../../core/src/geometry-capture.js";

async function fixture() {
  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  mesh.name = "wolf-surface-1-0";
  scene.add(mesh);
  const camera = new PerspectiveCamera();
  camera.position.z = 10;
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  const capture = new GeometryCapture();
  const result = capture.request({ limit: 500 });
  let pass: "main" | "shadow" = "main";
  capture.beginFrame({
    root: scene,
    camera,
    generation: 1,
    tick: 17,
    viewportHeight: 720,
    viewportWidth: 1280,
    activePassKind: () => pass,
  });
  mesh.onBeforeRender(null as never, scene, camera, mesh.geometry, mesh.material, null as never);
  pass = "shadow";
  mesh.onBeforeRender(null as never, scene, camera, mesh.geometry, mesh.material, null as never);
  capture.finishFrame([]);
  const info = new Info();
  (info as { frame: number }).frame = 9;
  info.createAttribute(new BufferAttribute(new Float32Array(12), 3));
  const entities = new Registry();
  entities.add("wolf-1-0", {});
  const context = {
    renderer: { info },
    physics: { numBodies: () => 3 },
    entities,
  } as unknown as Parameters<typeof takeLifecycleCensus>[0];
  const gpu = observeGPUResources({
    createBuffer: () => ({ destroy() {} }),
    createTexture: () => ({ destroy() {} }),
  });
  return {
    context,
    info,
    gpu,
    report: await result,
    dispose: () => {
      gpu.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

describe("animal lifetime public census", () => {
  it("reads actual Three memory, registry and completed per-pass geometry observations", async () => {
    const run = await fixture();
    try {
      expect(takeLifecycleCensus(run.context, run.gpu.snapshot(), run.report)).toMatchObject({
        frame: 9,
        memory: { attributes: 1, attributesSize: 48 },
        bodies: 3,
        entities: ["wolf-1-0"],
        surfaces: ["wolf-surface-1-0"],
        mainDraws: [1],
        shadowDraws: [1],
      });
    } finally {
      run.dispose();
    }
  });
  it.each(["geometry", "frame", "memory", "body"])(
    "rejects a missing %s observation",
    async (channel) => {
      const run = await fixture();
      try {
        if (channel === "geometry") Object.assign(run.report, { inspectionComplete: false });
        if (channel === "frame") Reflect.deleteProperty(run.info, "frame");
        if (channel === "memory") Reflect.deleteProperty(run.info.memory, "uniformBuffers");
        if (channel === "body") Object.assign(run.context.physics, { numBodies: () => Number.NaN });
        expect(() => takeLifecycleCensus(run.context, run.gpu.snapshot(), run.report)).toThrow(
          /TN_ANIMAL_LIFECYCLE/,
        );
      } finally {
        run.dispose();
      }
    },
  );
});
