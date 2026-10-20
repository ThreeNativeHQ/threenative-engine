import { BoxGeometry, type Mesh, MeshStandardMaterial, Scene, Mesh as ThreeMesh } from "three";
import { describe, expect, it, vi } from "vitest";
import { type IRenderProjectionReport, SceneRenderProjection } from "../src/renderProjection.js";

/**
 * The host projection seam (PRD-573 v1.11 step 3).
 *
 * Where the scene root has `__tnProjectionReport` the host renderer batches the authored scene itself, so
 * core builds no mirror and reads no object: a read of `geometry`, `material`, `visible` or a matrix stands for
 * a bridge crossing on the native engine, and those are what the mirror's scan and sync spend per cube.
 */

const GEOMETRY = new BoxGeometry(1, 1, 1);
const MATERIAL = new MeshStandardMaterial();

interface IHostVerdict {
  projecting: boolean;
  reasonCode: string;
  sourceRenderables: number;
  projectedObjects: number;
  instancedBatches: number;
  materialBatches: number;
  skinnedBatches: number;
  exactObjects: number;
  exact: Record<string, number>;
}

function verdictFor(count: number, projecting = true): IHostVerdict {
  return {
    projecting,
    reasonCode: projecting ? "projected" : "belowMeshFloor",
    sourceRenderables: count,
    projectedObjects: projecting ? count : 0,
    instancedBatches: projecting ? 1 : 0,
    materialBatches: 0,
    skinnedBatches: 0,
    exactObjects: 0,
    exact: {},
  };
}

/** A scene of `count` cubes whose per-object reads are counted, with a host that answers `verdict`. */
function hostScene(
  count: number,
  verdict: IHostVerdict = verdictFor(count),
): { calls: () => unknown[][]; reads: () => number; scene: Scene } {
  let reads = 0;
  const calls: unknown[][] = [];
  const scene = new Scene();
  for (let index = 0; index < count; index += 1) {
    const mesh = new ThreeMesh(GEOMETRY, MATERIAL);
    scene.add(mesh);
    for (const name of ["geometry", "material", "visible", "matrixWorld", "castShadow"] as const) {
      const value = (mesh as unknown as Record<string, unknown>)[name];
      Object.defineProperty(mesh, name, {
        configurable: true,
        get() {
          reads += 1;
          return value;
        },
        set() {},
      });
    }
  }
  (scene as Scene & { __tnProjectionReport: (min: number) => IHostVerdict }).__tnProjectionReport =
    (...args: unknown[]) => {
      calls.push(args);
      return verdict;
    };
  return { calls: () => calls, reads: () => reads, scene };
}

function plainScene(count: number): Scene {
  const scene = new Scene();
  for (let index = 0; index < count; index += 1) {
    const mesh: Mesh = new ThreeMesh(GEOMETRY, MATERIAL);
    mesh.position.set(index, 0, 0);
    scene.add(mesh);
  }
  return scene;
}

describe("SceneRenderProjection on a host that batches the authored scene", () => {
  it("hands the renderer the authored scene and reads no object, whatever the cube count", () => {
    for (const count of [250, 2500]) {
      const { calls, reads, scene } = hostScene(count);
      const projection = new SceneRenderProjection(scene, { onReport: () => {} });
      for (let frame = 0; frame < 3; frame += 1) projection.reconcile();
      expect(projection.root).toBe(scene);
      expect(reads()).toBe(0);
      expect(calls()).toEqual([[200], [200], [200]]);
      projection.dispose();
    }
  });

  it("states that the host path ran, with the host's counts", () => {
    const { scene } = hostScene(500, {
      ...verdictFor(500),
      instancedBatches: 3,
      projectedObjects: 480,
      exactObjects: 20,
      exact: { tooFewToBatch: 20 },
    });
    const reports: IRenderProjectionReport[] = [];
    const projection = new SceneRenderProjection(scene, {
      onReport: (value) => reports.push(value),
    });
    projection.reconcile();
    const report = projection.report;
    expect(reports).toHaveLength(1);
    expect(report).toMatchObject({
      projecting: true,
      reasonCode: "hostProjected",
      path: "host",
      pathOverridden: false,
      sourceRenderables: 500,
      resultDrawCandidates: 500,
      projectedObjects: 480,
      instancedBatches: 3,
      batches: 3,
      exactObjects: 20,
      exact: { tooFewToBatch: 20 },
      drawsPlanned: 23,
    });
    expect(projection.deoptimized).toBe(true);
    expect(projection.describeOwnership().size).toBe(0);
    projection.dispose();
  });

  it("passes its own mesh floor to the host", () => {
    const { calls, scene } = hostScene(10);
    const projection = new SceneRenderProjection(scene, { minMeshes: 8, onReport: () => {} });
    projection.reconcile();
    expect(calls()).toEqual([[8]]);
    projection.dispose();
  });

  it("reports a host decline with the host's reason and the authored draw count", () => {
    const { scene } = hostScene(40, verdictFor(40, false));
    const projection = new SceneRenderProjection(scene, { onReport: () => {} });
    projection.reconcile();
    expect(projection.root).toBe(scene);
    expect(projection.report).toMatchObject({
      projecting: false,
      reasonCode: "belowMeshFloor",
      path: "host",
      projectedObjects: 0,
      batches: 0,
      drawsPlanned: 40,
    });
    expect(projection.report.reason).toContain("belowMeshFloor");
    projection.dispose();
  });

  it("is a host report even before the first reconcile", () => {
    const { scene } = hostScene(10);
    const projection = new SceneRenderProjection(scene, { onReport: () => {} });
    expect(projection.report).toMatchObject({
      path: "host",
      projecting: false,
      sourceRenderables: 0,
    });
    projection.dispose();
  });
});

describe('renderer.projection: "js" on a host that batches', () => {
  it("forces the mirror, never asks the host, and says it was forced", () => {
    const { calls, reads, scene } = hostScene(250);
    const projection = new SceneRenderProjection(scene, { projection: "js", onReport: () => {} });
    projection.reconcile();
    expect(calls()).toEqual([]);
    // The control for the zero above: the mirror reads every cube, so the counter does count.
    expect(reads()).toBeGreaterThanOrEqual(250);
    expect(projection.root).not.toBe(scene);
    expect(projection.report).toMatchObject({
      projecting: true,
      reasonCode: "projected",
      path: "js",
      pathOverridden: true,
    });
    projection.dispose();
  });

  it("changes nothing where there is no host seam: three always has the mirror", () => {
    for (const projection of [undefined, "js" as const]) {
      const scene = plainScene(250);
      const subject = new SceneRenderProjection(scene, { projection, onReport: () => {} });
      subject.reconcile();
      expect(subject.root).not.toBe(scene);
      expect(subject.report).toMatchObject({
        reasonCode: "projected",
        path: "js",
        pathOverridden: false,
      });
      subject.dispose();
    }
  });

  it("leaves `false` as the opt-out, which never asks the host", () => {
    const { calls, scene } = hostScene(250);
    const projection = new SceneRenderProjection(scene, { projection: false, onReport: () => {} });
    projection.reconcile();
    expect(projection.root).toBe(scene);
    expect(calls()).toEqual([]);
    expect(projection.report).toMatchObject({ reasonCode: "disabled", path: "js" });
    projection.dispose();
  });

  it("logs the path on the default marker", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { scene } = hostScene(250);
      const projection = new SceneRenderProjection(scene);
      projection.reconcile();
      const line = info.mock.calls
        .map(String)
        .find((text) => text.startsWith("TN_RENDER_PROJECTION:"));
      expect(line).toContain('"reasonCode":"hostProjected"');
      expect(line).toContain('"path":"host"');
      projection.dispose();
    } finally {
      info.mockRestore();
    }
  });
});
