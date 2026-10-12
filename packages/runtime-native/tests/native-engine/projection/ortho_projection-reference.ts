/**
 * Records what the pinned `three`'s `OrthographicCamera` builds for the projection matrix and its
 * inverse, as the binary64 bit patterns the native orthographic camera test replays (the native
 * camera ports `updateProjectionMatrix` and `Matrix4.makeOrthographic`). The cases cover zoom != 1,
 * asymmetric frusta, view offsets, both coordinate systems a renderer uses and reversed depth. One
 * table, two drivers: the reference here, the native camera in `ortho_projection_test.cpp`.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/projection/ortho_projection-reference.ts
 *   ... -- --check   (fails when the committed table is not what the pinned three produces today)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as three from "three";
import { numberBits, pinnedThreeVersion } from "../../../../three-native/src/fixture-format.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "ortho_projection_reference.json");

interface IViewOffset {
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ICase {
  readonly name: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
  readonly zoom: number;
  /** "webgl" (2000) or "webgpu" (2001). */
  readonly coordinateSystem: "webgl" | "webgpu";
  readonly reversedDepth: boolean;
  readonly viewOffset?: IViewOffset;
  /** When set, a `clearViewOffset()` follows the `setViewOffset` before the matrix is read. */
  readonly clearViewOffset?: boolean;
}

const CASES: readonly ICase[] = [
  {
    name: "default",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 1,
    coordinateSystem: "webgl",
    reversedDepth: false,
  },
  {
    name: "zoom-two",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 2,
    coordinateSystem: "webgl",
    reversedDepth: false,
  },
  {
    name: "zoom-half",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 0.5,
    coordinateSystem: "webgl",
    reversedDepth: false,
  },
  {
    name: "asymmetric",
    left: -2.5,
    right: 1.25,
    top: 0.75,
    bottom: -3.5,
    near: 0.05,
    far: 500,
    zoom: 1,
    coordinateSystem: "webgl",
    reversedDepth: false,
  },
  {
    name: "asymmetric-zoom",
    left: -2.5,
    right: 1.25,
    top: 0.75,
    bottom: -3.5,
    near: 0.05,
    far: 500,
    zoom: 1.5,
    coordinateSystem: "webgl",
    reversedDepth: false,
  },
  {
    name: "view-offset",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 1,
    coordinateSystem: "webgl",
    reversedDepth: false,
    viewOffset: { fullWidth: 1920, fullHeight: 1080, x: 100, y: 50, width: 960, height: 540 },
  },
  {
    name: "view-offset-zoom",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 1.25,
    coordinateSystem: "webgl",
    reversedDepth: false,
    viewOffset: { fullWidth: 1920, fullHeight: 1080, x: 100, y: 50, width: 960, height: 540 },
  },
  {
    name: "view-offset-fractional",
    left: -3,
    right: 3,
    top: 2,
    bottom: -2,
    near: 0.25,
    far: 750,
    zoom: 0.75,
    coordinateSystem: "webgl",
    reversedDepth: false,
    viewOffset: { fullWidth: 800, fullHeight: 600, x: 3, y: 7, width: 100.5, height: 200.25 },
  },
  {
    name: "webgpu",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 1,
    coordinateSystem: "webgpu",
    reversedDepth: false,
  },
  {
    name: "webgpu-asymmetric-near-zero",
    left: -2.5,
    right: 1.25,
    top: 0.75,
    bottom: -3.5,
    near: 0,
    far: 500,
    zoom: 1.3333333333333333,
    coordinateSystem: "webgpu",
    reversedDepth: false,
  },
  {
    name: "reversed",
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 2000,
    zoom: 1,
    coordinateSystem: "webgl",
    reversedDepth: true,
  },
  {
    name: "reversed-webgpu-asymmetric",
    left: -2.5,
    right: 1.25,
    top: 0.75,
    bottom: -3.5,
    near: 0,
    far: 500,
    zoom: 1.5,
    coordinateSystem: "webgpu",
    reversedDepth: true,
    viewOffset: { fullWidth: 640, fullHeight: 480, x: 12, y: 9, width: 301, height: 207 },
  },
  {
    name: "view-offset-cleared",
    left: -1,
    right: 3,
    top: 2,
    bottom: -2,
    near: 0.5,
    far: 50,
    zoom: 2,
    coordinateSystem: "webgl",
    reversedDepth: false,
    viewOffset: { fullWidth: 1920, fullHeight: 1080, x: 480, y: 270, width: 960, height: 540 },
    clearViewOffset: true,
  },
];

function bitsOfMatrix(matrix: three.Matrix4): string[] {
  return matrix.elements.map((value: number) => numberBits(value));
}

function record(testCase: ICase): Record<string, unknown> {
  const camera = new three.OrthographicCamera(
    testCase.left,
    testCase.right,
    testCase.top,
    testCase.bottom,
    testCase.near,
    testCase.far,
  );
  camera.zoom = testCase.zoom;
  camera.coordinateSystem =
    testCase.coordinateSystem === "webgpu"
      ? three.WebGPUCoordinateSystem
      : three.WebGLCoordinateSystem;
  camera._reversedDepth = testCase.reversedDepth;
  if (testCase.viewOffset) {
    const v = testCase.viewOffset;
    camera.setViewOffset(v.fullWidth, v.fullHeight, v.x, v.y, v.width, v.height);
    if (testCase.clearViewOffset) camera.clearViewOffset();
    else camera.updateProjectionMatrix();
  } else {
    camera.updateProjectionMatrix();
  }
  return {
    ...testCase,
    projectionMatrix: bitsOfMatrix(camera.projectionMatrix),
    projectionMatrixInverse: bitsOfMatrix(camera.projectionMatrixInverse),
  };
}

const table = {
  three: pinnedThreeVersion(),
  cases: CASES.map(record),
};
const text = `${JSON.stringify(table, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      `TN_ORTHO_PROJECTION_REFERENCE_STALE: ${OUT} is not what the pinned three produces today`,
    );
    process.exit(1);
  }
  console.log(`orthographic projection reference current: ${CASES.length} cameras`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${CASES.length} orthographic cameras to ${OUT}`);
}
