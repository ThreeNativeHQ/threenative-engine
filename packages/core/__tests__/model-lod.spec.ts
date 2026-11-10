import {
  BufferGeometry,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Sphere,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import {
  type ILodView,
  conservativeViewDepth,
  drawTriangles,
  lodPixelScale,
  projectedLodError,
  selectLodLevel,
  worldSphere,
} from "../src/model-lod.js";

function perspective(distance: number, viewportHeight = 1080, fov = 60): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, 1, 0.1, 1000);
  camera.position.set(0, 0, distance);
  camera.updateMatrixWorld(true);
  return camera;
}

function view(camera: PerspectiveCamera, depth: number, viewportHeight = 1080): ILodView {
  return { camera, depth, degenerate: false, viewportHeight };
}

describe("lodPixelScale", () => {
  it("projects a unit error at depth through the camera's own fov and viewport", () => {
    const camera = perspective(20);
    const scale = lodPixelScale(camera, 1080, 10);
    expect(scale).toBeCloseTo(1080 / (2 * Math.tan(Math.PI / 6)) / 10, 6);
  });

  it("includes camera zoom", () => {
    const camera = perspective(20);
    const plain = lodPixelScale(camera, 1080, 10);
    camera.zoom = 2;
    expect(lodPixelScale(camera, 1080, 10)).toBeCloseTo(plain * 2, 6);
  });

  it("uses the frustum height and ignores depth for an orthographic camera", () => {
    const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.updateMatrixWorld(true);
    // 20 world units tall over a 1080-pixel viewport -> 54 px per unit, at any depth.
    expect(lodPixelScale(camera, 1080, 1)).toBeCloseTo(54, 6);
    expect(lodPixelScale(camera, 1080, 100)).toBeCloseTo(54, 6);
  });

  it("refuses a zero-depth perspective scale instead of returning a finite wrong number", () => {
    expect(lodPixelScale(perspective(20), 1080, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects a non-positive viewport", () => {
    expect(() => lodPixelScale(perspective(20), 0, 10)).toThrow(/viewport/u);
  });
});

describe("projectedLodError", () => {
  it("is linear in the world error and zero for LOD0", () => {
    const camera = perspective(20);
    expect(projectedLodError(0, camera, 1080, 10)).toBe(0);
    expect(projectedLodError(0.02, camera, 1080, 10)).toBeCloseTo(
      lodPixelScale(camera, 1080, 10) * 0.02,
      6,
    );
  });
});

describe("conservativeViewDepth", () => {
  it("subtracts the sphere radius so an error near the camera is not projected from the centre", () => {
    const camera = perspective(10);
    const { depth, degenerate } = conservativeViewDepth(camera, new Vector3(0, 0, 0), 2, 0.1);
    expect(depth).toBeCloseTo(8, 6);
    expect(degenerate).toBe(false);
  });

  it("reports a camera inside the sphere as degenerate", () => {
    const camera = perspective(1);
    const { degenerate } = conservativeViewDepth(camera, new Vector3(0, 0, 0), 5, 0.1);
    expect(degenerate).toBe(true);
  });
});

describe("worldSphere", () => {
  it("transforms the centre and scales the radius by the largest axis", () => {
    const local = new Sphere(new Vector3(0, 0, 0), 1);
    const object = new Object3D();
    object.scale.setScalar(2);
    object.position.set(5, 0, 0);
    object.updateMatrixWorld(true);
    const world = worldSphere(local, object);
    expect(world.center.x).toBeCloseTo(5, 6);
    expect(world.radius).toBeCloseTo(2, 6);
  });
});

describe("selectLodLevel", () => {
  const levels = [0, 0.005, 0.02];

  it("selects LOD0 for an empty chain, a non-positive budget, or no views", () => {
    expect(selectLodLevel([], 2, 1, 0.15, [view(perspective(10), 10)])).toBe(0);
    expect(selectLodLevel(levels, 2, 0, 0.15, [view(perspective(10), 10)])).toBe(0);
    expect(selectLodLevel(levels, 2, 1, 0.15, [])).toBe(0);
  });

  it("coarsens when the candidate is comfortably inside the hysteresis-adjusted budget", () => {
    // 0.005 * 93.53 = 0.468 px, well under (1 - 0.15) * 1.
    expect(selectLodLevel(levels, 0, 1, 0.15, [view(perspective(10), 10)])).toBe(1);
  });

  it("keeps the current level when a marginal coarsen is not comfortably under budget", () => {
    // 0.0095 * 93.53 = 0.888 px: within the 1-pixel budget, above the 0.85 hysteresis line.
    const marginal = [0, 0.0095, 0.02];
    expect(selectLodLevel(marginal, 0, 1, 0.15, [view(perspective(10), 10)])).toBe(0);
    // With hysteresis off the same candidate is exactly the budget's choice.
    expect(selectLodLevel(marginal, 0, 1, 0, [view(perspective(10), 10)])).toBe(1);
  });

  it("refines immediately when the current level exceeds the budget", () => {
    // 0.02 * 93.53 = 1.87 px at depth 10; the level that fits is index 1, not the current 2.
    expect(selectLodLevel(levels, 2, 1, 0.15, [view(perspective(10), 10)])).toBe(1);
  });

  it("selects the finest level the whole budget cannot cover any other way", () => {
    // At depth 10, index 1 fits; at depth 2 the same error is 2.34 px, so only LOD0 fits.
    const near = view(perspective(2), 2);
    expect(selectLodLevel(levels, 1, 1, 0.15, [view(perspective(10), 10), near])).toBe(0);
  });

  it("returns full detail for a degenerate (near-plane or inside-bounds) view", () => {
    const inside: ILodView = {
      camera: perspective(0.05),
      depth: 0,
      degenerate: true,
      viewportHeight: 1080,
    };
    expect(selectLodLevel(levels, 2, 1, 0.15, [inside])).toBe(0);
  });

  it("never coarsens past a view marked finest", () => {
    const shadow: ILodView = {
      camera: perspective(10),
      depth: 10,
      degenerate: false,
      viewportHeight: 1080,
      finest: true,
    };
    expect(selectLodLevel(levels, 0, 1, 0.15, [shadow])).toBe(0);
  });

  it("handles a zero-error derived level as a real, freely selectable level", () => {
    const zero = [0, 0, 0.02];
    expect(selectLodLevel(zero, 0, 1, 0.15, [view(perspective(10), 10)])).toBe(1);
  });
});

describe("drawTriangles", () => {
  it("reads a level's index once, not once a frame", () => {
    // On the owned engine each `geometry.index` read crosses the bridge; Midway's fleet read it 528
    // times a frame through `ModelLod.triangles` and failed its playtest on TN_BRIDGE_WARNING.
    const geometry = new BufferGeometry();
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    let reads = 0;
    const index = geometry.index;
    Object.defineProperty(geometry, "index", {
      get: () => {
        reads += 1;
        return index;
      },
    });
    for (let frame = 0; frame < 60; frame += 1) expect(drawTriangles(geometry)).toBe(2);
    expect(reads).toBe(1);
  });
});
