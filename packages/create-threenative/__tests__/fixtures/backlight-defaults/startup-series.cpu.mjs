import assert from "node:assert/strict";
import { launchOrder, statistics, validateSample } from "./startup-series.mjs";
const order = launchOrder();
assert.equal(order.length, 80);
assert.equal(order.filter((a) => a === "before").length, 40);
assert.deepEqual(order.slice(0, 8), [
  "before",
  "after",
  "after",
  "before",
  "before",
  "after",
  "after",
  "before",
]);
assert.equal(statistics(Array.from({ length: 40 }, (_, i) => 40 - i)).p95, 38);
assert.equal(statistics([1, 2, 3, 4]).median, 2.5);
assert.throws(() => statistics([Number.NaN]));
assert.throws(() => launchOrder(3));
const provenance = {
  rendererKind: "webgpu",
  target: "web",
  adapter: { vendor: "nvidia", architecture: "turing" },
  viewport: { width: 1280, height: 720 },
};
const ready = {
  rule: "sustained-frames",
  startup: { phase: "ready", timeline: { readyMs: 900, loadStartedMs: 600 } },
};
const observed = { backendWebGL: false, width: 1280, height: 720, samples: 4 };
assert.deepEqual(validateSample(provenance, ready, observed), {
  navigationReadyMs: 900,
  sceneLoadToReadyMs: 300,
});
assert.throws(() => validateSample(provenance, ready, { ...observed, backendWebGL: true }));
assert.throws(() =>
  validateSample(
    provenance,
    { ...ready, startup: { ...ready.startup, timeline: { readyMs: 500, loadStartedMs: 600 } } },
    observed,
  ),
);
console.log(
  "PASS balanced 40/arm launch order, nearest-rank p95, median, invalid statistics, readiness clock and backend controls; no GPU execution.",
);
