import {
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from "three";
import { describe, expect, it } from "vitest";
import {
  displacementFadeDistance,
  edgeFactor,
  occlusionBuffer,
  patternTriangles,
  priceDisplacedSurface,
} from "../src/displaced-surface.js";

// PRD-668 Phase 1: the price of Nanite-style dicing, counted before any dice pass is built.

describe("the dice-pattern triangle count", () => {
  it("is n squared for a uniform factor, as Unreal's uniform pattern is", () => {
    for (let n = 1; n <= 14; n += 1) expect(patternTriangles(n, n, n)).toBe(n * n);
  });

  it("fans a split edge without interior vertices on small patterns", () => {
    expect(patternTriangles(2, 1, 1)).toBe(2);
    expect(patternTriangles(2, 2, 1)).toBe(3);
  });

  it("rounds factors up and clamps them to the 1-14 table", () => {
    expect(patternTriangles(0.2, 0.5, 0.9)).toBe(1);
    expect(patternTriangles(1.1, 1.1, 1.1)).toBe(4);
    expect(patternTriangles(40, 40, 40)).toBe(196);
  });
});

describe("the edge factor", () => {
  it("is edge length over the nearer depth, in pixels, over the dice rate", () => {
    expect(edgeFactor(0.1, 2, 1000, 2, 0, 0.1)).toBeCloseTo(25, 9);
  });

  it("drops to a quarter past the fade distance", () => {
    expect(edgeFactor(0.1, 2, 1000, 2, 1, 0.1)).toBeCloseTo(6.25, 9);
    expect(edgeFactor(0.1, 2, 1000, 2, 3, 0.1)).toBeCloseTo(25, 9);
  });

  it("never divides by a depth nearer than the near plane", () => {
    expect(edgeFactor(0.1, 0.01, 1000, 2, 0, 0.1)).toBeCloseTo(500, 9);
    expect(edgeFactor(0.1, -5, 1000, 2, 0, 0.1)).toBeCloseTo(500, 9);
  });
});

describe("the fade distance", () => {
  it("is where the largest displacement projects to the fade-out size", () => {
    // 4 cm about a 0.5 center moves at most 2 cm; 2 cm at 20 m spans 1 px at 1000 px per unit.
    expect(displacementFadeDistance(0.04, 0.5, 1, 1000, 1)).toBeCloseTo(20, 9);
    expect(displacementFadeDistance(0.04, 0.25, 2, 1000, 1)).toBeCloseTo(60, 9);
  });

  it("is zero when the fade is off, Unreal's stock material", () => {
    expect(displacementFadeDistance(0.04, 0.5, 1, 1000, 0)).toBe(0);
  });
});

function viewOf(): PerspectiveCamera {
  // fov 90 at a 1000 px tall view: 500 px per unit at one unit of depth.
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateMatrixWorld();
  return camera;
}

/** An equilateral triangle facing the camera at depth 10, every edge at `factor` (off an integer: float32). */
function facing(factor: number): Scene {
  // Edge factor = side / 10 * 500 / 2, so side = factor / 25.
  const side = factor / 25;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([0, 0, -10, side, 0, -10, side / 2, (side * Math.sqrt(3)) / 2, -10]),
      3,
    ),
  );
  const scene = new Scene();
  scene.add(new Mesh(geometry, new MeshBasicMaterial()));
  return scene;
}

describe("dicing one patch", () => {
  it("dices a factor of 14 or less as one patch", () => {
    const price = priceDisplacedSurface(facing(9.5), viewOf(), 1000);
    expect(price.patches).toBe(1);
    expect(price.microTriangles).toBe(100);
    expect(price.addedMicroTriangles).toBe(99);
  });

  it("splits a larger factor into sub-patches that each fit the table", () => {
    const price = priceDisplacedSurface(facing(27.5), viewOf(), 1000);
    expect(price.patches).toBe(4);
    expect(price.microTriangles).toBe(784);
  });

  it("caps one split level at a factor of 8 and recurses", () => {
    // 199 / 14 caps at 8: 64 children of factor 24.9, each split by 2 into 4 of factor 12.4 -> 13.
    const price = priceDisplacedSurface(facing(199), viewOf(), 1000);
    expect(price.patches).toBe(256);
    expect(price.microTriangles).toBe(64 * 4 * 169);
  });

  it("drops the split children the view does not hold", () => {
    // Shifted so the left half of the triangle sits past the right frustum edge at x = 10.
    const scene = facing(199);
    scene.position.x = 10 - 4;
    const price = priceDisplacedSurface(scene, viewOf(), 1000);
    expect(price.visibleTriangles).toBe(1);
    expect(price.patches).toBeGreaterThan(0);
    expect(price.patches).toBeLessThan(256);
  });
});

describe("pricing a scene", () => {
  it("prices each submitted triangle from its own edges and depth", () => {
    const scene = new Scene();
    const plane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial());
    plane.position.z = -10;
    scene.add(plane);

    const price = priceDisplacedSurface(scene, viewOf(), 1000);

    // Each half of the quad has two 2 m sides (factor 50) and a diagonal (70.7) at depth 10. The
    // largest needs 70.7 / 14 -> 6 splits, so each half is 36 children at a sixth of each factor.
    const side = (2 / 10) * (500 / 2);
    const child = patternTriangles(side / 6, side / 6, (Math.SQRT2 * side) / 6);
    expect(price.triangles).toBe(2);
    expect(price.visibleTriangles).toBe(2);
    expect(price.dicedTriangles).toBe(2);
    expect(price.patches).toBe(72);
    expect(price.microTriangles).toBe(72 * child);
    expect(price.addedMicroTriangles).toBe(72 * child - 2);
  });

  it("adds nothing for triangles already under the dice rate", () => {
    const scene = new Scene();
    const plane = new Mesh(new PlaneGeometry(0.001, 0.001), new MeshBasicMaterial());
    plane.position.z = -10;
    scene.add(plane);

    const price = priceDisplacedSurface(scene, viewOf(), 1000);

    expect(price.visibleTriangles).toBe(2);
    expect(price.dicedTriangles).toBe(0);
    expect(price.addedMicroTriangles).toBe(0);
  });

  it("counts the triangles behind the camera as submitted but never dices them", () => {
    const scene = new Scene();
    const plane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial());
    plane.position.z = 10;
    scene.add(plane);

    const price = priceDisplacedSurface(scene, viewOf(), 1000);

    expect(price.triangles).toBe(2);
    expect(price.visibleTriangles).toBe(0);
    expect(price.microTriangles).toBe(0);
  });

  it("reads only the draw range the cut left, once per drawn copy", () => {
    const scene = new Scene();
    const geometry = new PlaneGeometry(2, 2);
    geometry.setDrawRange(0, 3);
    const copies = new InstancedMesh(geometry, new MeshBasicMaterial(), 3);
    copies.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -10));
    copies.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -20));
    copies.setMatrixAt(2, new Matrix4().makeTranslation(0, 0, 30));
    copies.count = 2;
    scene.add(copies);

    const price = priceDisplacedSurface(scene, viewOf(), 1000);

    expect(price.triangles).toBe(2);
    expect(price.visibleTriangles).toBe(2);
  });

  it("lowers the dice past the fade distance when the fade is on", () => {
    const scene = new Scene();
    const plane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial());
    plane.position.z = -30;
    scene.add(plane);

    const stock = priceDisplacedSurface(scene, viewOf(), 1000);
    const faded = priceDisplacedSurface(scene, viewOf(), 1000, { fadeOutPixels: 1 });

    expect(stock.fadeDistance).toBe(0);
    expect(faded.fadeDistance).toBeCloseTo(10, 9);
    expect(faded.microTriangles).toBeLessThan(stock.microTriangles);
  });

  it("hides a patch behind a nearer occluder and never hides a patch behind itself", () => {
    const camera = viewOf();
    const scene = new Scene();
    const back = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial());
    back.position.z = -10;
    scene.add(back);
    const alone = priceDisplacedSurface(scene, camera, 1000, {
      occlusion: occlusionBuffer(scene, camera, 250, 250),
    });
    expect(alone.microTriangles).toBe(priceDisplacedSurface(scene, camera, 1000).microTriangles);

    const front = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial());
    front.position.z = -5;
    scene.add(front);
    const hidden = priceDisplacedSurface(back, camera, 1000, {
      occlusion: occlusionBuffer(scene, camera, 250, 250),
    });
    expect(hidden.visibleTriangles).toBe(2);
    expect(hidden.dicedTriangles).toBe(0);
    expect(hidden.microTriangles).toBe(0);
  });
});
