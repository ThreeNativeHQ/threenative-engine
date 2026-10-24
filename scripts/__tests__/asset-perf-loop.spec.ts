import { describe, expect, it } from "vitest";
const { appendIteration, kindOf, renderHtml, summarize } = await import(
  new URL("../asset-perf-loop.mjs", import.meta.url).href
);
const { emptyLedger } = await import(new URL("../ci-speed-loop.mjs", import.meta.url).href);

const sources = [
  { path: "shared/hero.glb", bytes: 1000 },
  { path: "rain/thunder.wav", bytes: 4000 },
  { path: "shared/sky.jpg", bytes: 500 },
];
const receipt = {
  pipelineVersion: 1,
  outputs: [
    { path: "shared/hero.abc.glb", bytes: 400, producer: "model", source: "shared/hero.glb" },
    { path: "rain/thunder.abc.ogg", bytes: 200, producer: "audio", source: "rain/thunder.wav" },
    { path: "basis/basis_transcoder.wasm", bytes: 300, producer: "transcoder", source: null },
  ],
};

describe("asset perf loop", () => {
  it("counts a source the receipt does not name as shipped as authored", () => {
    const summary = summarize(sources, receipt);
    expect(summary.sourceBytes).toBe(5500);
    // 400 model + 200 audio + 500 untouched jpg + 300 transcoder.
    expect(summary.shippedBytes).toBe(1400);
    expect(summary.metrics.shippedPctOfSource).toBe(25.5);
    expect(summary.kinds.texture).toEqual({ sourceBytes: 500, shippedBytes: 500, files: 1 });
    expect(summary.kinds.runtime).toEqual({ sourceBytes: 0, shippedBytes: 300, files: 1 });
    expect(summary.files[0].path).toBe("shared/sky.jpg");
  });

  it("classifies by source extension and leaves preload pending", () => {
    expect([
      kindOf("a.GLB"),
      kindOf("b.png"),
      kindOf("c.wav"),
      kindOf(null),
      kindOf("d.bin"),
    ]).toEqual(["model", "texture", "audio", "runtime", "other"]);
    expect(summarize(sources, receipt).metrics.preloadLocalMs).toBeNull();
  });

  it("keeps a control arm out of the baseline and the trend", () => {
    const measurement = { ...summarize(sources, receipt), compileMs: 10 };
    let ledger = appendIteration(emptyLedger(), {
      measurement,
      label: "cooked",
      arm: "default",
      config: {},
    });
    ledger = appendIteration(ledger, {
      measurement: { ...measurement, metrics: { ...measurement.metrics, shippedMiB: 99 } },
      label: "uncooked",
      arm: "none",
      config: {},
      decision: "control",
    });
    expect(ledger.iterations.map((item: { decision: string }) => item.decision)).toEqual([
      "baseline",
      "control",
    ]);
    const html = renderHtml(ledger, new Date(0));
    expect(html).toContain("Latest iteration #1 of 2: cooked.");
    expect(html).toContain("pending");
    expect(html).not.toContain("#2: 99");
    expect(html).not.toContain("/state");
    expect(renderHtml(ledger, new Date(0), { serving: true })).toContain('fetch("/state"');
    expect(() =>
      appendIteration(ledger, {
        measurement,
        label: "x",
        arm: "default",
        config: {},
        decision: "maybe",
      }),
    ).toThrow(/decision must be one of/u);
  });
});
