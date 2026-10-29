import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
const { appendIteration, decideIteration, kindOf, renderHtml, summarize } = await import(
  new URL("../asset-perf-loop.mjs", import.meta.url).href
);
const { emptyLedger } = await import(new URL("../ci-speed-loop.mjs", import.meta.url).href);
const { serveStatic } = await import(new URL("../asset-preload-probe.mjs", import.meta.url).href);

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
    expect(html).not.toContain("/api/asset-perf");
    expect(renderHtml(ledger, new Date(0), { serving: true })).toContain('fetch("/api/asset-perf"');
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

  it("records a verdict on a measured iteration and refuses an unknown one", () => {
    const measurement = { ...summarize(sources, receipt), compileMs: 10 };
    const ledger = appendIteration(emptyLedger(), {
      measurement,
      label: "lever",
      arm: "default",
      config: {},
    });
    const rejected = decideIteration(ledger, 1, "reject", "rotation error 0.71 degrees");
    expect(rejected.iterations[0]).toMatchObject({
      decision: "reject",
      notes: "rotation error 0.71 degrees",
    });
    expect(() => decideIteration(ledger, 9, "keep")).toThrow(/no iteration 9/u);
    expect(() => decideIteration(ledger, 1, "maybe")).toThrow(/decision must be one of/u);
  });

  it("does not serve a file outside its root through traversal or symlinks", async () => {
    const base = await makeTempDir("asset-static-root-");
    const root = join(base, "public");
    await mkdir(root);
    await writeFile(join(base, "secret.txt"), "secret");
    await symlink(join(base, "secret.txt"), join(root, "secret-link.txt"));
    const { server, port } = await serveStatic([root]);
    try {
      for (const path of ["/%2e%2e%2fsecret.txt", "/secret-link.txt"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(response.status).toBe(404);
      }
    } finally {
      await new Promise<void>((done) => server.close(done));
      await rm(base, { force: true, recursive: true });
    }
  });
});
