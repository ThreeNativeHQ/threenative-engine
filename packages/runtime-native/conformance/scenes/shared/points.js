import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

// PRD-871: `THREE.Points` with a `PointsMaterial`. A Points object is a WebGPU point-list primitive in
// upstream three (WebGPUUtils.getPrimitiveTopology: `object.isPoints` -> PointList), and a WebGPU point
// rasterizes one pixel whatever `size` says (PointsNodeMaterial.js:21-33: "WebGPU only supports point
// primitives with a pixel size of 1"). So both clouds are one-pixel points whose colour is what the frame
// compares: cloud A takes the material's colour at a size and attenuation a game would author, cloud B
// takes a per-vertex `color` attribute. `size: 6` is asserted to read back on the engine and, as upstream's
// WebGPU backend, it moves no pixel — a sized point cloud is a Sprite upstream, not a Points.

const GRID = 24; // cloud A: 576 single-pixel points, one per grid cell
const RING = 480; // cloud B: 480 per-vertex-coloured points behind cloud A

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "points", ({ scene }) => {
    const gridPositions = [];
    for (let row = 0; row < GRID; row += 1) {
      for (let column = 0; column < GRID; column += 1) {
        gridPositions.push(
          (column / (GRID - 1) - 0.5) * 2.12,
          (row / (GRID - 1) - 0.5) * 1.24,
          0,
        );
      }
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gridPositions, 3));
    assertCondition(gridGeometry.getAttribute("position").count === GRID * GRID, "cloud A position count");

    const gridMaterial = new THREE.PointsMaterial({
      color: 0xffd479,
      size: 6,
      sizeAttenuation: true,
    });
    assertCondition(gridMaterial.isPointsMaterial === true, "cloud A holds a PointsMaterial");
    assertCondition(gridMaterial.size === 6, "PointsMaterial.size reads back");
    assertCondition(gridMaterial.sizeAttenuation === true, "PointsMaterial.sizeAttenuation reads back");
    const grid = new THREE.Points(gridGeometry, gridMaterial);
    assertCondition(grid.isPoints === true, "cloud A is a Points object");

    const ringPositions = [];
    const ringColors = [];
    for (let index = 0; index < RING; index += 1) {
      const turn = index / RING;
      const angle = turn * Math.PI * 2;
      const radius = 1.28 + 0.22 * Math.sin(angle * 5);
      ringPositions.push(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.72, -0.6);
      // A hue sweep, so a wrong vertex-colour read shows as a wrong hue and not only as a missing point.
      ringColors.push(0.5 + 0.5 * Math.sin(angle), 0.5 + 0.5 * Math.sin(angle + 2.09), 0.5 + 0.5 * Math.sin(angle + 4.19));
    }
    const ringGeometry = new THREE.BufferGeometry();
    ringGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ringPositions, 3));
    ringGeometry.setAttribute("color", new THREE.Float32BufferAttribute(ringColors, 3));

    const ringMaterial = new THREE.PointsMaterial({
      size: 3,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    });
    assertCondition(ringMaterial.vertexColors === true, "cloud B reads its color attribute");
    const ring = new THREE.Points(ringGeometry, ringMaterial);

    scene.add(grid, ring);
    return {
      detail: { points: GRID * GRID + RING, sized: 6, vertexColors: true },
      grid,
      ring,
    };
  });
}
