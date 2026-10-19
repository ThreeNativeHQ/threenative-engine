// Inspect real retained reports AND decoded screenshot pixels; expected negatives are named gates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PNG } from "pngjs";
import { inspectFrame } from "../../../../playtest/dist/capture.js";
import { assertEnvironmentMarker } from "./report-proof.ts";
const base = resolve(process.argv[2] ?? "artifacts/backlight-defaults");
const crops = JSON.parse(await readFile(new URL("./proof-crops.json", import.meta.url), "utf8"));
async function json(path) {
  let bytes;
  try {
    if ((await stat(path)).size > 1048576) throw new Error("Proof JSON exceeds 1 MiB.");
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = gunzipSync(await readFile(`${path}.gz`), { maxOutputLength: 1048576 });
  }
  if (bytes.length > 1048576) throw new Error("Expanded proof exceeds 1 MiB.");
  return JSON.parse(bytes.toString("utf8"));
}
let aliases;
try {
  aliases = await json(resolve(base, "source-aliases.json"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
function cropMetrics(image, region) {
  assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
  assert.ok(region.x + region.width <= image.width && region.y + region.height <= image.height);
  const crop = new PNG({ width: region.width, height: region.height });
  PNG.bitblt(image, crop, region.x, region.y, region.width, region.height, 0, 0);
  return inspectFrame(PNG.sync.write(crop)).tone;
}
const cases = [];
for (const name of ["edge-enabled", "edge-rim-zero", "fill-enabled", "fill-fill-black"]) {
  const directory = resolve(base, `${name}-acceptance1`);
  const report = await json(resolve(directory, "report.json"));
  const edge = name.startsWith("edge");
  const negative = name !== "edge-enabled" && name !== "fill-enabled";
  const failures = negative
    ? edge
      ? ["tone.0.compare", "tone.1.compare"]
      : ["tone.0.p99", "tone.1.p99"]
    : [];
  assert.equal(report.pass, !negative);
  assert.deepEqual(
    report.assertionResults
      .filter((row) => !row.pass)
      .map((row) => row.id)
      .sort(),
    failures,
  );
  assert.equal(report.diagnostics.length, failures.length);
  assert.ok(report.diagnostics.every((row) => row.code === "TN_PLAYTEST_TONE_ASSERTION_FAILED"));
  assert.equal(report.capture.rendererKind, "webgpu");
  assert.equal(report.capture.target, "web");
  assert.equal(report.capture.adapter.vendor, "nvidia");
  assert.equal(report.capture.adapter.architecture, "turing");
  assert.deepEqual(report.capture.viewport, { width: 1280, height: 720 });
  const marker = assertEnvironmentMarker(report.observations.console, {
    environmentState: "dark",
    rimGain: name === "edge-rim-zero" ? 0 : 0.12,
    fillEnabled: !edge,
    blackFill: name === "fill-fill-black",
  });
  const rows = [];
  for (const [index, pose] of ["pose-end", "pose-rest"].entries()) {
    const alias = aliases?.[name]?.[pose];
    const image = PNG.sync.read(
      await readFile(alias ? resolve(base, alias.file) : resolve(directory, `${pose}.png`)),
    );
    if (alias)
      assert.equal(createHash("sha256").update(image.data).digest("hex"), alias.decodedRGBA);

    assert.equal(image.width, 1280);
    assert.equal(image.height, 720);
    const row = report.observations.tone.find(
      (row) =>
        row.assertionIndex === index &&
        row.atStep === (index === 0 ? "fixed-pose-end" : "fixed-pose-rest"),
    );
    assert.ok(row);
    assert.deepEqual(row.region, edge ? crops.edge : crops.body);
    const actual = cropMetrics(image, row.region);
    for (const [key, value] of Object.entries(actual))
      assert.equal(row[key], value, `Report must match actual decoded PNG ${key}`);
    if (edge) {
      assert.deepEqual(row.reference.region, crops.body);
      assert.deepEqual(row.reference.metrics, cropMetrics(image, crops.body));
      assert.equal(actual.p99 - row.reference.metrics.p99 >= crops.edgeMargin, !negative);
    } else {
      assert.ok(actual.p1 <= crops.fillP1Max);
      assert.equal(actual.p99 >= crops.fillP99Min, !negative);
    }
    rows.push({ pose, metrics: actual, reference: row.reference?.metrics });
  }
  cases.push({
    name,
    pass: report.pass,
    expectedFailures: failures,
    marker,
    rows,
    provenance: report.observations.components.qualification,
  });
}
const positive = await json(resolve(base, "marker-positive-proof1/report.json"));
const omitted = await json(resolve(base, "marker-omitted-proof1/report.json"));
for (const report of [positive, omitted]) {
  assert.equal(report.pass, true);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.capture.adapter.vendor, "nvidia");
}
const expected = { environmentState: "dark", rimGain: 0.12, fillEnabled: true, blackFill: false };
assertEnvironmentMarker(positive.observations.console, expected);
assert.throws(
  () => assertEnvironmentMarker(omitted.observations.console, expected),
  /TN_ENVIRONMENT_MARKER_MISSING_OR_DUPLICATE/,
);
// A precise paired-pixel contribution remains measured even for the zero-override arm.
// This is a bounded fixture report, not a claimed runtime BRDF/IBL energy measurement.
const rimOn = cases.find((row) => row.name === "edge-enabled");
const rimOff = cases.find((row) => row.name === "edge-rim-zero");
for (const [candidate, arm] of [
  [rimOn, "enabled"],
  [rimOff, "rim-zero"],
]) {
  const evidence = candidate.provenance;
  assert.ok(evidence, "Retained scene provenance is required.");
  assert.deepEqual(evidence.arm, { before: arm, after: arm });
  assert.deepEqual(evidence.shot, { before: "backlit-black-ibl", after: "backlit-black-ibl" });
  assert.deepEqual(evidence.cameraPosition, { before: [0, 1.35, 6], after: [0, 1.35, 6] });
  assert.deepEqual(evidence.animationTicks, { before: 0, after: 90 });
  assert.deepEqual(evidence.animationSeconds, { before: 0, after: 1.5 });
  for (const key of [
    "convertedMaterials",
    "excluded",
    "environmentState",
    "bufferWidth",
    "bufferHeight",
  ])
    assert.deepEqual(
      evidence[key],
      rimOn.provenance[key],
      `Paired scene provenance must match: ${key}`,
    );
}
const rimMeasurements = rimOn.rows.map((row, index) => {
  const off = rimOff.rows[index];
  const edgeDelta = row.metrics.p99 - off.metrics.p99;
  const bodyDelta = row.reference.p99 - off.reference.p99;
  assert.ok(edgeDelta > 0);
  return {
    pose: row.pose,
    measured: true,
    method:
      "paired actual decoded PNG p99 edge/body difference; fixed scene/camera/pose; only rimGain differs",
    availableEdgeP99Delta: edgeDelta,
    availableBodyP99Delta: bodyDelta,
    availableMarginDelta: edgeDelta - bodyDelta,
    enabled: { edgeP99: row.metrics.p99, bodyP99: row.reference.p99 },
    zeroOverride: { edgeP99: off.metrics.p99, bodyP99: off.reference.p99 },
  };
});
for (const candidate of [rimOn, rimOff]) {
  const measurement = {
    arm: candidate.name,
    applied: candidate.name === "edge-enabled",
    rimGain: candidate.marker.rimGain,
    measurements: rimMeasurements,
  };
  console.log(`TN_RIM_CONTRIBUTION:${JSON.stringify(measurement)}`);
}
const result = {
  pass: true,
  rimMeasurements,
  scope:
    "isolated actual starter character/material fixture; no shipped defaults or per-template/native admission",
  crops,
  cases,
  markerMutation: "TN_ENVIRONMENT_MARKER_MISSING_OR_DUPLICATE",
  limitations: [
    "photographed environment remains unknown on current CPU measurement path",
    "native regional capture unimplemented and fails closed",
    "all-template/default integration and clean generated starter gates pending",
    "timing uses sparse real engine timestamps; private-display FPS and compilation completion unqualified",
  ],
};
await writeFile(resolve(base, "qualification.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(
  "PASS actual PNG crop/report agreement, edge margin and zero-rim failure, no-sun range and black-fill failure, measured report survives zero override and missing-marker fails.",
);
