import { describe, expect, it, vi } from "vitest";
import {
  measureProxyPenetration,
  measureSailPositions,
  riggingPositions,
} from "../src/physics/measure.js";
import type { IRiggingModel } from "../src/physics/model.js";
import { buildRiggingTopology, referenceRigging } from "../src/physics/topology.js";

function fixture() {
  const a = {
    positionLin: new Float64Array(3),
    positionAng: new Float64Array([0, 0, 0, 1]),
    size: new Float64Array([1, 1, 1]),
  };
  const b = {
    positionLin: new Float64Array([0, 0, 0.75]),
    positionAng: new Float64Array([0, 0, 0, 1]),
    size: new Float64Array([1, 1, 1]),
  };
  const model = {
    solver: { bodies: [a, b] },
    bodyIndices: new Uint32Array([0]),
    localPositions: new Float32Array(3),
    secondaryCount: 1,
    proxies: [{ index: 1, body: b, name: "wall" }],
  } as unknown as IRiggingModel;
  const data = new Float32Array(80);
  data[7] = 1;
  data[42] = 0.75;
  data[47] = 1;
  return { model, data };
}

describe("actual box/box proxy observations", () => {
  it("measures contact separation on the simulated boxes", () => {
    const f = fixture();
    expect(measureProxyPenetration(f.model, f.data)).toBeCloseTo(0.25, 6);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a nonfinite proxy pose instead of reporting zero penetration (%s)",
    (value) => {
      const f = fixture();
      f.data[40] = value;
      f.data[41] = value;
      f.data[42] = value;
      expect(() => measureProxyPenetration(f.model, f.data)).toThrow(/TN_AVBD_MEASUREMENT/);
    },
  );
  it("rejects a malformed sampled body array by name", () => {
    const f = fixture();
    expect(() => riggingPositions(f.model, null as unknown as Float32Array)).toThrow(
      /TN_AVBD_MEASUREMENT/,
    );
  });
});

describe("common candidate/baseline sail observations", () => {
  it("uses the same authored edge error for a known ten percent elongation", () => {
    const topology = buildRiggingTopology(referenceRigging());
    const sail = topology.ranges.find((range) => range.name === "sail");
    if (sail === undefined) throw new Error("test sail missing");
    const positions = topology.positions.slice(sail.offset * 3, (sail.offset + sail.count) * 3);
    for (let vertex = 0; vertex < sail.count; vertex++) {
      const x = positions[vertex * 3];
      const y = positions[vertex * 3 + 1];
      if (x === undefined || y === undefined) throw new Error("test vertex missing");
      positions[vertex * 3] = x * 1.1;
      positions[vertex * 3 + 1] = y * 1.1;
    }
    const measured = measureSailPositions(topology, positions);
    expect(measured.sailStretchP95).toBeCloseTo(0.1, 5);
    expect(measured.sailEdgeErrorP95).toBeCloseTo(0.1, 5);
  });
  it("rejects missing/nonfinite sail samples instead of assigning rest rope positions", () => {
    const topology = buildRiggingTopology(referenceRigging());
    expect(() => measureSailPositions(topology, new Float32Array(3))).toThrow(
      /TN_RIGGING_MEASUREMENT/,
    );
    const data = new Float32Array(32 * 32 * 3);
    data[0] = Number.NaN;
    expect(() => measureSailPositions(topology, data)).toThrow(/TN_RIGGING_MEASUREMENT/);
  });
});

describe("bounded penetration peak witness", () => {
  it("copies the winning contact and exact packed words without changing the numeric metric", () => {
    const f = fixture();
    new Uint32Array(f.data.buffer)[39] = 0x7fc12345;
    const capture = vi.fn();
    expect(measureProxyPenetration(f.model, f.data, { previousMaximum: 0, capture })).toBeCloseTo(
      0.25,
      6,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    const witness = capture.mock.calls[0]?.[0];
    expect(witness).toMatchObject({
      contactSource: "pinned CPU box SAT reconstructed on sampled GPU poses",
      bodyIndex: 0,
      proxyIndex: 1,
      proxyName: "wall",
      topologyVertexIndices: [0],
      separation: -0.25,
      penetration: 0.25,
      contactKind: "edge",
      clipVertexIndex: null,
      featureAxes: { body: 0, proxy: 1 },
      signedDistances: { worldAOnBody: 0, worldAOnProxy: 0, worldBOnBody: 0, worldBOnProxy: 0 },
    });
    expect(witness.body.words).toHaveLength(40);
    expect(witness.proxy.words).toHaveLength(40);
    expect(witness.body.words[39]).toBe(0x7fc12345);
    expect(witness.authoredWorldA).toEqual([
      witness.worldA[0],
      witness.worldA[2],
      -witness.worldA[1],
    ]);
    expect(witness.authoredWorldB).toEqual([
      witness.worldB[0],
      witness.worldB[2],
      -witness.worldB[1],
    ]);
    const copy = JSON.stringify(witness);
    f.data.fill(0);
    f.model.solver.bodies[0]?.positionLin.fill(99);
    expect(JSON.stringify(witness)).toBe(copy);
  });
  it("does not allocate a new receipt for an equal or lower cumulative maximum", () => {
    const f = fixture();
    const capture = vi.fn();
    expect(
      measureProxyPenetration(f.model, f.data, { previousMaximum: 0.25, capture }),
    ).toBeCloseTo(0.25, 6);
    expect(capture).not.toHaveBeenCalled();
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid previous peak (%s)",
    (previousMaximum) => {
      const f = fixture();
      expect(() =>
        measureProxyPenetration(f.model, f.data, { previousMaximum, capture: vi.fn() }),
      ).toThrow(/TN_AVBD_MEASUREMENT/);
    },
  );
  it("keeps point SDF separate from contact-normal depth in the sampled rotated frame", () => {
    const f = fixture();
    const angle = Math.PI / 4;
    for (const offset of [0, 40]) {
      f.data[offset + 4] = Math.sin(angle / 2);
      f.data[offset + 7] = Math.cos(angle / 2);
    }
    f.data[41] = -0.9 * Math.sin(angle);
    f.data[42] = 0.9 * Math.cos(angle);
    const capture = vi.fn();
    expect(measureProxyPenetration(f.model, f.data, { previousMaximum: 0, capture })).toBeCloseTo(
      0.1,
      5,
    );
    const witness = capture.mock.calls[0]?.[0];
    expect(witness.signedDistances.worldAOnProxy).toBeCloseTo(0, 5);
    expect(witness.signedDistances.worldBOnBody).toBeCloseTo(0, 5);
    expect(witness.signedDistances.worldAOnBody).toBeCloseTo(0, 5);
    expect(witness.signedDistances.worldBOnProxy).toBeCloseTo(0, 5);
  });
});

it("preserves sampled buffer offsets and multiple authored vertices mapped to one body", () => {
  const f = fixture();
  const model = { ...f.model, bodyIndices: new Uint32Array([0, 0]) };
  const view = new Float32Array(new ArrayBuffer(384), 32, 80);
  view.set(f.data);
  new Uint32Array(view.buffer, view.byteOffset, view.length)[39] = 0x7fc43210;
  const capture = vi.fn();
  expect(measureProxyPenetration(model, view, { previousMaximum: 0, capture })).toBeCloseTo(
    0.25,
    6,
  );
  expect(capture.mock.calls[0]?.[0].body.words[39]).toBe(0x7fc43210);
  expect(capture.mock.calls[0]?.[0].topologyVertexIndices).toEqual([0, 1]);
});

it("records face features and both nonuniform extent sources without rounding the CPU metric", () => {
  const f = fixture();
  f.model.solver.bodies[0]?.size.set([1.00000001, 2, 1]);
  f.model.solver.bodies[1]?.size.set([1.00000001, 2, 1]);
  f.data.set([1.00000001, 2, 1], 16);
  f.data.set([1.00000001, 2, 1], 56);
  f.data[42] = 0.99;
  const capture = vi.fn();
  const plain = measureProxyPenetration(f.model, f.data);
  expect(measureProxyPenetration(f.model, f.data, { previousMaximum: 0, capture })).toBe(plain);
  const witness = capture.mock.calls[0]?.[0];
  expect(witness.contactKind).toBe("faceA");
  expect(witness.featureAxes).toEqual({ reference: 2, incident: 2 });
  expect(witness.clipVertexIndex).toBe(witness.feature & 255);
  expect(witness.body.fullSize).toEqual([1.00000001, 2, 1]);
  expect(witness.body.sampledFullSize).toEqual([1, 2, 1]);
});
