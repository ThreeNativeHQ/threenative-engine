import assert from "node:assert/strict";
import { test } from "vitest";
import { assertWorldCellsProxyProof } from "../conformance/scenes/shared/world-cells-proxy-stream.js";

test("WorldCells conformance requires two admitted cells, observed proxy swaps and validation", () => {
  const observations = [0, 2].map((x) => ({
    residentKeys: [`${x}:0`], loadedCells: 1, instances: 1, failures: 0, evictions: x,
    hlod: { compiled: 1, observed: 1, active: 1, failures: 0 },
  }));
  assert.doesNotThrow(() => assertWorldCellsProxyProof(observations, null));
  assert.throws(() => assertWorldCellsProxyProof([], null), /two streamed/u);
  assert.throws(() => assertWorldCellsProxyProof(undefined, null), /two streamed/u);
  assert.throws(() => assertWorldCellsProxyProof(observations, undefined), /validation/u);
  assert.throws(() => assertWorldCellsProxyProof(observations, { message: "GPU error" }), /validation/u);
  for (const field of ["compiled", "observed", "active"]) {
    const missing = structuredClone(observations);
    missing[0].hlod[field] = 0;
    assert.throws(() => assertWorldCellsProxyProof(missing, null), /proxy must/u);
  }
  const missingCell = structuredClone(observations);
  missingCell[1].residentKeys = [];
  assert.throws(() => assertWorldCellsProxyProof(missingCell, null), /cell missing/u);
});
