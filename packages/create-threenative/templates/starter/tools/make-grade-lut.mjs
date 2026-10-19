#!/usr/bin/env node
// Writes this game's colour table to `public/grade.cube`.
//
// `src/render/grade.ts` loads whatever is in that file and looks it up; nothing else in the game
// knows what the grade is. Swap that file for a `.cube` exported from any grading tool and the
// stage reads that instead — this script exists so the shipped table is reproducible and its few
// numbers sit in one readable place, not because a `.cube` needs generating.
//
//   node tools/make-grade-lut.mjs                  the shipped grade
//   node tools/make-grade-lut.mjs --identity       a table that changes nothing, for checking the
//                                                  round trip through grade.ts
//   node tools/make-grade-lut.mjs --out other.cube
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Table edge length. 9 keeps the shipped table a readable 729 lines, and the cost of a coarse grid
 * is measured rather than assumed: the hardware's trilinear interpolation of this grade departs
 * from the curve it was written from by at most 7.5 of 255 steps, all of it in the top interval of
 * a channel whose gain above one has to clip (`__tests__/grade.spec.ts` measures both numbers, and
 * re-reads the constants below from this file, so raising SIZE cannot pass unnoticed). A grade that
 * needs its top of the range followed exactly wants 17 or 33; a gentler curve wants neither.
 */
const SIZE = 9;

/** The grade itself, in display-referred [0, 1] — which is what a `.cube` is written against. */
const CONTRAST = 1.06;

/**
 * The pivot is mid-grey, and that is most of what makes this a default rather than a look. A pivot
 * at 0.18 — where this table started — leaves everything above it brighter, because a contrast
 * curve anchored low down lifts the whole middle of the range: measured on the frame, it moved
 * mid-grey up 8 of 255 steps and the sky up 12, which is what "washed toward cream" and "muddy"
 * read like on screen. Anchored at 0.5 it darkens below the middle, brightens above it, and keeps
 * the blacks where they were.
 */
const PIVOT = 0.5;

/**
 * The channel mixer, and deliberately the smallest one that is still a grade.
 *
 * This started at `{ b: 0.94, g: 1, r: 1.07 }` — a 13% warm spread. A blind judge compared the
 * starter with that table against the starter without one and preferred **no table**: grey
 * concrete read as sandstone, the sky as cream, and the whole frame as mud. A default that makes
 * the picture worse is not a default, so the spread is now about 1/26 of that — one 8-bit step or
 * less on concrete and on sky alike, which is what `__tests__/grade.spec.ts` pins. A game that
 * wants the warm look names its own gain here.
 */
const GAIN = { b: 0.9975, g: 1, r: 1.0025 };

/**
 * Contrast about a pivot: a power function that leaves the pivot alone and darkens below it. This
 * is the one operation a grading tool would call a curve; the gain above is its channel mixer, and
 * it is why the top of the warm channel clips — a gain above one cannot brighten a pixel that is
 * already white, which is what the table above says about highlights.
 */
const grade = (value, channel) =>
  Math.min(1, PIVOT ** (1 - CONTRAST) * value ** CONTRAST * GAIN[channel]);

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const identity = flag("identity");
const target = option(
  "out",
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "grade.cube"),
);

const lines = [
  "# Written by tools/make-grade-lut.mjs — edit that, not this file.",
  `# ${identity ? "Identity table: this game ungraded, to check the round trip." : "This game's grade."}`,
  "# Red varies fastest, which is the Cube LUT order and the x axis of the uploaded 3D texture.",
  `TITLE "starter ${identity ? "identity" : "neutral-warm"}"`,
  `LUT_3D_SIZE ${SIZE}`,
  "",
];

// `LUTCubeLoader` copies each line's three numbers into x, y then z, so the loop below walks x
// fastest and an identity table is a straight ramp along every axis.
for (let texel = 0; texel < SIZE ** 3; texel += 1) {
  const r = (texel % SIZE) / (SIZE - 1);
  const g = (Math.floor(texel / SIZE) % SIZE) / (SIZE - 1);
  const b = (Math.floor(texel / SIZE ** 2) % SIZE) / (SIZE - 1);
  const graded = [
    identity ? r : grade(r, "r"),
    identity ? g : grade(g, "g"),
    identity ? b : grade(b, "b"),
  ];
  lines.push(graded.map((value) => value.toFixed(6)).join(" "));
}

mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`wrote ${target} (${SIZE}^3, red varies fastest)\n`);
