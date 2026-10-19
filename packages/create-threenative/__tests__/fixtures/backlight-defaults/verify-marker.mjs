import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { assertEnvironmentMarker } from "./report-proof.ts";
const [positive, omitted] = process.argv.slice(2);
if (!positive || !omitted)
  throw new Error("Expected actual positive and omitted console.json paths.");
async function records(path) {
  if ((await stat(path)).size > 1048576) throw new Error("Console proof exceeds 1 MiB.");
  return JSON.parse(await readFile(path, "utf8"));
}
const expected = { environmentState: "dark", rimGain: 0.12, fillEnabled: true, blackFill: false };
const report = assertEnvironmentMarker(await records(positive), expected);
const omittedRecords = await records(omitted);
assert.throws(
  () => assertEnvironmentMarker(omittedRecords, expected),
  /TN_ENVIRONMENT_MARKER_MISSING_OR_DUPLICATE/,
);
console.log(
  JSON.stringify({
    positive,
    omitted,
    pass: true,
    actualReport: report,
    negativeFailure: "TN_ENVIRONMENT_MARKER_MISSING_OR_DUPLICATE",
  }),
);
