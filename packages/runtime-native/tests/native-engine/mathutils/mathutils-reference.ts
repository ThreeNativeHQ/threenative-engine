/**
 * Records what the pinned `three`'s `MathUtils` returns for the functions the minimal template
 * reaches, and the values of the constants it imports, as the binary64 bit patterns the native
 * MathUtils binding test replays (PRD-531). One table, two drivers: the reference here, the native
 * registry in `mathutils_test.cpp`.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/mathutils/mathutils-reference.ts
 *   ... -- --check   (fails when the committed table is not what the pinned three produces today)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as three from "three";
import { numberBits, pinnedThreeVersion } from "../../../../three-native/src/fixture-format.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "mathutils_reference.json");

interface ICase {
  readonly args: readonly string[];
  readonly expected: string;
}

interface IFunctionTable {
  readonly name: string;
  readonly cases: readonly ICase[];
}

function cases(fn: (...args: number[]) => number, inputs: readonly (readonly number[])[]): ICase[] {
  return inputs.map((args) => ({
    args: args.map((value) => numberBits(value)),
    expected: numberBits(fn(...args)),
  }));
}

const FUNCTIONS: readonly IFunctionTable[] = [
  {
    name: "clamp",
    cases: cases(
      (value, min, max) => three.MathUtils.clamp(value, min, max),
      [
        [3.5, 0, 2],
        [-5, 0, 2],
        [1, 0, 2],
        [Number.NaN, 0, 2],
        [0, -0, 2],
        [Number.POSITIVE_INFINITY, 0, 2],
        [1, 2, 0],
        [-0, 0, 1],
      ],
    ),
  },
  {
    name: "lerp",
    cases: cases(
      (x, y, t) => three.MathUtils.lerp(x, y, t),
      [
        [0.1, 0.2, 0.3],
        [1, 2, 1],
        [1, 2, 0],
        [1e308, -1e308, 0.5],
        [0.1, 0.2, 1 / 3],
        [Number.NaN, 1, 0.5],
      ],
    ),
  },
  {
    name: "degToRad",
    cases: cases(
      (degrees) => three.MathUtils.degToRad(degrees),
      [[180], [90], [-45], [1], [0], [360], [-0]],
    ),
  },
  {
    name: "euclideanModulo",
    cases: cases(
      (n, m) => three.MathUtils.euclideanModulo(n, m),
      [
        [-1, 3],
        [1, 3],
        [-0, 3],
        [5, 0],
        [7.5, 2.5],
        [-7.5, 2.5],
        [Number.NaN, 3],
      ],
    ),
  },
];

interface IConstant {
  readonly name: string;
  readonly kind: "number" | "string";
  readonly value: string;
}

const CONSTANTS: readonly IConstant[] = [
  { name: "ACESFilmicToneMapping", kind: "number", value: numberBits(three.ACESFilmicToneMapping) },
  { name: "AgXToneMapping", kind: "number", value: numberBits(three.AgXToneMapping) },
  { name: "NeutralToneMapping", kind: "number", value: numberBits(three.NeutralToneMapping) },
  { name: "PCFSoftShadowMap", kind: "number", value: numberBits(three.PCFSoftShadowMap) },
  { name: "NoColorSpace", kind: "string", value: three.NoColorSpace },
  { name: "LinearSRGBColorSpace", kind: "string", value: three.LinearSRGBColorSpace },
];

const table = {
  three: pinnedThreeVersion(),
  functions: FUNCTIONS,
  constants: CONSTANTS,
};
const text = `${JSON.stringify(table, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      `TN_MATHUTILS_REFERENCE_STALE: ${OUT} is not what the pinned three produces today`,
    );
    process.exit(1);
  }
  console.log(
    `MathUtils reference current: ${FUNCTIONS.length} functions, ${CONSTANTS.length} constants`,
  );
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${FUNCTIONS.length} functions and ${CONSTANTS.length} constants to ${OUT}`);
}
