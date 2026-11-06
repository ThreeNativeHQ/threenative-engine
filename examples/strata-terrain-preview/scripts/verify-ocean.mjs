import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectCapture } from "../../../packages/runtime-native/conformance/metrics.mjs";

assert(process.argv[2], "Pass the target's capture directory");
const directory = resolve(process.argv[2]);
// `--proof=water` claims the sheltered shader gate holds; `--proof=foam` claims the forced-opaque
// control fails it. Absent/`off` keeps the original lane (native has no URL to opt proof in) on the
// original capture checks, including the sheltered blue proxy, which stays the native acceptance.
const proofArgument = process.argv.find((value) => value.startsWith("--proof="));
const proofMode = proofArgument === undefined ? "off" : proofArgument.slice("--proof=".length);
assert(["off", "water", "foam"].includes(proofMode), `Unknown --proof mode: ${proofMode}`);
// The shared wave/sun comparison cannot run on the all-white forced-foam control, which fills the
// pool with real opaque foam; the control skips it and proves its own arm numerically below.
const oceanComparisons =
  proofMode === "foam"
    ? []
    : [
        ["coastal-ocean-early", "coastal-ocean", "waves"],
        ["coastal-ocean", "coastal-sun-alt", "sun"],
      ];
for (const [left, right, label] of oceanComparisons) {
  const a = inspectCapture(readFileSync(resolve(directory, `${left}.png`)));
  const b = inspectCapture(readFileSync(resolve(directory, `${right}.png`)));
  assert(
    a.width * 9 === a.height * 16 && b.width === a.width && b.height === a.height,
    "Shared scenario captures must be one 16:9 size",
  );
  const scale = a.width / 1280;
  let waterPixels = 0;
  let changed = 0;
  // Camera-matched water region in the shared 16:9 coastal view, authored at 1280 wide and scaled; exclude white foam.
  for (let y = Math.round(468 * scale); y < Math.round(700 * scale); y++)
    for (let x = Math.round(900 * scale); x < Math.round(1260 * scale); x++) {
      const i = (y * a.width + x) * 4;
      if (a.png.data[i + 2] <= a.png.data[i] + 15 || b.png.data[i + 2] <= b.png.data[i] + 15)
        continue;
      waterPixels++;
      const difference = [0, 1, 2].reduce(
        (sum, c) => sum + Math.abs(a.png.data[i + c] - b.png.data[i + c]),
        0,
      );
      if (difference > 12) changed++;
    }
  assert(waterPixels > 10000 * scale * scale, `${label}: water region was not observed`);
  assert(
    changed / waterPixels > 0.01,
    `${label}: water did not visibly change (${changed}/${waterPixels})`,
  );
  console.log(
    JSON.stringify({ oceanVisual: label, waterPixels, changedRatio: changed / waterPixels }),
  );
}

// The step whose screenshot is `coastal-horizon-sea`; the runner labels each sample with its
// scenario step and the probe echoes it, so no other step's readback can stand in. Declared before
// the `verifyWaterProof` call so the call never touches the binding in its temporal dead zone.
const WATER_PROOF_STEP = "horizon-sea";
const WATER_PROOF_ROI = { x: 940, y: 600, width: 280, height: 100, referenceWidth: 1280 };

if (proofMode === "off") {
  // The sheltered pool was filled with opaque white foam in round 8. Observe its water, not the sky.
  const lagoon = inspectCapture(readFileSync(resolve(directory, "coastal-horizon-sea.png")));
  const lagoonScale = lagoon.width / 1280;
  let lagoonPixels = 0;
  let bluePixels = 0;
  for (let y = Math.round(600 * lagoonScale); y < Math.round(700 * lagoonScale); y++)
    for (let x = Math.round(940 * lagoonScale); x < Math.round(1220 * lagoonScale); x++) {
      const i = (y * lagoon.width + x) * 4;
      const [r, g, b] = lagoon.png.data.subarray(i, i + 3);
      lagoonPixels++;
      if (b > r + 20 && g > r + 12) bluePixels++;
    }
  assert(lagoonPixels > 10000 * lagoonScale * lagoonScale, "lagoon: water region was not observed");
  assert(
    bluePixels / lagoonPixels > 0.7,
    `lagoon: opaque foam obscures sheltered water (${bluePixels}/${lagoonPixels})`,
  );
  console.log(
    JSON.stringify({ oceanVisual: "sheltered-water", blueRatio: bluePixels / lagoonPixels }),
  );
} else {
  verifyWaterProof(directory, proofMode);
}

function readWaterProofObservations(artifactDirectory) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(resolve(artifactDirectory, "console.json"), "utf8"));
  } catch (error) {
    throw new Error(`TN_WATER_PROOF_OBSERVATION: console.json is unavailable (${error.message})`);
  }
  assert(Array.isArray(entries), "TN_WATER_PROOF_OBSERVATION: console.json is not an array");
  const marker = "TN_WATER_PROOF:";
  const observations = [];
  for (const entry of entries) {
    const text = typeof entry?.text === "string" ? entry.text : "";
    const index = text.indexOf(marker);
    if (index < 0) continue;
    observations.push(JSON.parse(text.slice(index + marker.length)));
  }
  return observations;
}

function verifyWaterProof(artifactDirectory, mode) {
  const observations = readWaterProofObservations(artifactDirectory);
  // Bind to the exact step the sheltered capture rides on: a missing, superseded or wrongly posed
  // observation is a failure, never an old readback standing in for the current pose.
  const atStep = observations.filter(
    (observation) => observation?.available === true && observation.label === WATER_PROOF_STEP,
  );
  assert.equal(
    atStep.length,
    1,
    `sheltered-water: expected exactly one observation at the '${WATER_PROOF_STEP}' step, found ${atStep.length}`,
  );
  const observation = atStep[0];
  assert.equal(
    observation.mode,
    mode,
    `sheltered-water: the observation ran in '${observation.mode}' mode, not '${mode}'`,
  );
  assert.equal(
    observation.world,
    "coastal",
    "sheltered-water: the observation is not the coastal world",
  );
  assert.equal(
    observation.frozen,
    true,
    "sheltered-water: the observation was not frozen after readback",
  );
  assert(
    Number.isSafeInteger(observation.requestId) && observation.requestId > 0,
    "sheltered-water: the observation has no request id",
  );
  assert(
    Number.isSafeInteger(observation.frame) && observation.frame > 0,
    "sheltered-water: the observation has no frame",
  );
  // Pose witness: the sample ran inside the labelled step, so the camera it carries is that step's
  // pose. It must be finite and self-consistent, not merely a 16-element array.
  const pose = observation.camera;
  assert(
    Array.isArray(pose?.matrixWorld) &&
      pose.matrixWorld.length === 16 &&
      pose.matrixWorld.every(Number.isFinite),
    "sheltered-water: the observation captured no finite camera matrix",
  );
  assert(
    Array.isArray(pose.position) &&
      pose.position.length === 3 &&
      pose.position.every(Number.isFinite),
    "sheltered-water: the observation captured no finite camera position",
  );
  assert.equal(
    pose.position[0],
    pose.matrixWorld[12],
    "sheltered-water: the camera position disagrees with its matrix",
  );
  assert.equal(
    pose.position[1],
    pose.matrixWorld[13],
    "sheltered-water: the camera position disagrees with its matrix",
  );
  assert.equal(
    pose.position[2],
    pose.matrixWorld[14],
    "sheltered-water: the camera position disagrees with its matrix",
  );
  const format = observation.format;
  assert.equal(
    format?.color,
    "RGBA16F",
    "sheltered-water: the diagnostic attachment is not RGBA16F",
  );
  assert.equal(
    format.samples,
    4,
    "sheltered-water: the proof did not run on the 4x-MSAA coastal pass",
  );
  assert.equal(
    format.attachments,
    3,
    "sheltered-water: the MRT is not the expected three-attachment layout",
  );
  const dimensions = observation.dimensions;
  assert(
    Number.isSafeInteger(dimensions?.width) &&
      dimensions.width > 0 &&
      Number.isSafeInteger(dimensions.height) &&
      dimensions.height > 0,
    "sheltered-water: the observation has no render-target dimensions",
  );
  // Auto scaling rounds each dimension independently by at most half a pixel.
  assert(
    Math.abs(dimensions.width * 9 - dimensions.height * 16) <= (9 + 16) / 2,
    "sheltered-water: the world pass is not the shared 16:9 frame",
  );
  const limits = observation.limits;
  assert(
    Number.isSafeInteger(limits?.maxColorAttachments) &&
      limits.maxColorAttachments >= format.attachments,
    "sheltered-water: the device cannot hold the MRT color attachments",
  );
  assert(
    Number.isSafeInteger(limits?.maxColorAttachmentBytesPerSample) &&
      limits.maxColorAttachmentBytesPerSample >= 8 * format.attachments,
    "sheltered-water: the device cannot hold the MRT bytes per sample",
  );
  const roi = observation.roi;
  assert.equal(
    roi?.referenceWidth,
    WATER_PROOF_ROI.referenceWidth,
    "sheltered-water: the ROI is not the 1280-scaled sheltered region",
  );
  const scale = dimensions.width / WATER_PROOF_ROI.referenceWidth;
  assert.equal(
    roi.x,
    Math.round(WATER_PROOF_ROI.x * scale),
    "sheltered-water: the ROI x does not match the sheltered region",
  );
  assert.equal(
    roi.y,
    Math.round(WATER_PROOF_ROI.y * scale),
    "sheltered-water: the ROI y does not match the sheltered region",
  );
  assert.equal(
    roi.width,
    Math.round((WATER_PROOF_ROI.x + WATER_PROOF_ROI.width) * scale) - roi.x,
    "sheltered-water: the ROI width does not match the sheltered region",
  );
  assert.equal(
    roi.height,
    Math.round((WATER_PROOF_ROI.y + WATER_PROOF_ROI.height) * scale) - roi.y,
    "sheltered-water: the ROI height does not match the sheltered region",
  );
  assert(
    roi.x >= 0 &&
      roi.y >= 0 &&
      roi.x + roi.width <= dimensions.width &&
      roi.y + roi.height <= dimensions.height,
    "sheltered-water: the ROI leaves the render target",
  );
  const statistics = observation.statistics;
  assert(
    statistics && typeof statistics === "object",
    "sheltered-water: the observation has no statistics",
  );
  assert.equal(statistics.threshold, 0.5, "sheltered-water: the coverage threshold is not 0.5");
  assert.equal(statistics.minFraction, 0.7, "sheltered-water: the minimum fraction is not 0.7");
  assert(
    Number.isFinite(statistics.area) && statistics.area > 0,
    "sheltered-water: the region holds no positive finite water area",
  );
  assert(
    Number.isSafeInteger(statistics.considered) && statistics.considered > 0,
    "sheltered-water: the ROI contained no water pixels",
  );
  assert(
    Number.isFinite(statistics.fraction) && statistics.fraction >= 0 && statistics.fraction <= 1,
    "sheltered-water: the diagnostic fraction is not finite in [0, 1]",
  );
  assert(
    Number.isFinite(statistics.qualifying) && statistics.qualifying >= 0,
    "sheltered-water: the qualifying weight is not finite",
  );
  assert(
    statistics.considered <= roi.width * roi.height && statistics.area <= statistics.considered,
    "sheltered-water: water area exceeds the considered pixels",
  );
  assert(
    statistics.qualifying <= statistics.area,
    "sheltered-water: qualifying weight exceeds the water area",
  );
  assert.equal(
    statistics.fraction,
    statistics.qualifying / statistics.area,
    "sheltered-water: the fraction does not match the measured weights",
  );
  assert.equal(
    statistics.passes,
    statistics.fraction >= statistics.minFraction,
    "sheltered-water: the reported pass does not match the gate",
  );
  const passed = statistics.fraction >= statistics.minFraction;
  if (mode === "water") {
    assert(
      passed,
      `sheltered-water: water contribution ${statistics.fraction} is below ${statistics.minFraction} (${statistics.qualifying}/${statistics.area})`,
    );
    console.log(
      JSON.stringify({
        oceanVisual: "sheltered-water",
        area: statistics.area,
        fraction: statistics.fraction,
        requestId: observation.requestId,
      }),
    );
    return;
  }
  // Forced opaque foam must fail the exact same gate the positive arm passes.
  assert(
    !passed,
    `forced-foam control passed the water gate it must fail (${statistics.fraction} >= ${statistics.minFraction})`,
  );
  console.log(
    JSON.stringify({
      oceanVisual: "forced-foam-control",
      mode: observation.mode,
      fraction: statistics.fraction,
      observations: atStep.length,
    }),
  );
}
