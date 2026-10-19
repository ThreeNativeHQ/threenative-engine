import assert from "node:assert/strict";
import { Color, Scene } from "three";
import { reportEnvironmentContribution } from "./environment.ts";
import { assertEnvironmentMarker } from "./report-proof.ts";
const records = [];
const original = console.info;
try {
  console.info = (...args) => records.push({ text: args.join(" ") });
  reportEnvironmentContribution(new Scene(), {
    darkThreshold: 0.001,
    rimGain: 0,
    fillGain: 1,
    fillAdmitted: true,
    fillColor: new Color(0.1, 0.2, 0.3),
    maxSourceTexels: 16,
  });
} finally {
  console.info = original;
}
const expected = { environmentState: "missing", rimGain: 0, fillEnabled: true, blackFill: false };
assert.throws(
  () => assertEnvironmentMarker(records, { ...expected, environmentState: "dark" }),
  /INVALID/,
);
assertEnvironmentMarker(records, expected);
assert.throws(() => assertEnvironmentMarker([], expected), /MISSING/);
assert.throws(() => assertEnvironmentMarker([...records, ...records], expected), /DUPLICATE/);
assert.throws(
  () => assertEnvironmentMarker([{ text: "TN_ENVIRONMENT_CONTRIBUTION:{}" }], expected),
  /INVALID/,
);
const corrupt = JSON.parse(records[0].text.split(":").slice(1).join(":"));
corrupt.meanRadiance = 1;
assert.throws(
  () =>
    assertEnvironmentMarker(
      [{ text: `TN_ENVIRONMENT_CONTRIBUTION:${JSON.stringify(corrupt)}` }],
      expected,
    ),
  /INVALID/,
);
console.log(
  "PASS structured measured marker, zero override, missing/duplicate/invalid and forged-dark controls; CPU only.",
);
