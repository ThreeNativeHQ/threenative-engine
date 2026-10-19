import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { buildWorldVisualBundle, runCli, scoreWorldVisualBundle } from "../world-visual-gate.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
/** Cross-series absence: this series draws no band the other series draws at this walk index. */
const crossSeries = {
  element: "forest band beyond the road",
  kind: "missing",
  from: "frame-002",
  to: "frame-002",
  distanceMeters: 300,
  description: "The other series draws the band at this walk index; this series draws sky.",
};

async function fixture() {
  const root = await makeTempDir("world-visual-gate-");
  roots.push(root);
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i / 4) % 256;
    png.data[i + 1] = (i / 2) % 256;
    png.data[i + 2] = 255 - ((i / 4) % 256);
    png.data[i + 3] = 255;
  }
  const image = PNG.sync.write(png);
  const manifests = ["reference", "candidate"].map((build) => {
    const directory = path.join(root, build);
    mkdirSync(directory);
    write(path.join(directory, "capture.json"), {
      adapter: { vendor: "nvidia", architecture: "turing", description: "NVIDIA RTX 2080" },
      browserArgs: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
      captureMethod: "page.screenshot",
      rendererKind: "webgpu",
      target: "web",
      viewport: { width: 16, height: 16 },
    });
    const frame = (id: string, x = 0) => {
      writeFileSync(path.join(directory, `${id}.png`), image);
      return { id, image: `${id}.png`, position: [x, 2, 0], target: [x, 0, 10] };
    };
    const manifest = {
      schemaVersion: 1,
      world: "test-world",
      build,
      route: "fixed-leg",
      seed: "42",
      nearBandMeters: 25,
      capture: "capture.json",
      landmarks: [{ id: "pine-1", position: [0, 0, 8] }],
      samePose: [frame("forest"), frame("road"), frame("step-2", 2)],
      walk: [0, 1, 2].map((time) => ({ ...frame(`step-${time}`, time), timeMs: time * 100 })),
    };
    const file = path.join(directory, "world.json");
    write(file, manifest);
    return file;
  });
  return {
    root,
    before: manifests[0] as string,
    after: manifests[1] as string,
    out: path.join(root, "gate"),
  };
}

async function ready() {
  const f = await fixture();
  const built = buildWorldVisualBundle(f.before, f.after, f.out);
  return { ...f, built, bundle: read(path.join(built.bundle, "bundle.json")) };
}

/** Two or more runs per side, so the reference's own run-to-run spread can be measured. */
async function multiFixture(beforeRuns = 2, afterRuns = 2) {
  const root = await makeTempDir("world-visual-gate-multirun-");
  roots.push(root);
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i / 4) % 256;
    png.data[i + 1] = (i / 2) % 256;
    png.data[i + 2] = 255 - ((i / 4) % 256);
    png.data[i + 3] = 255;
  }
  const image = PNG.sync.write(png);
  const run = (side: "reference" | "candidate", index: number) => {
    const directory = path.join(root, `${side}-run-${index}`);
    mkdirSync(directory);
    write(path.join(directory, "capture.json"), {
      adapter: { vendor: "nvidia", architecture: "turing", description: "NVIDIA RTX 2080" },
      browserArgs: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
      captureMethod: "page.screenshot",
      rendererKind: "webgpu",
      target: "web",
      viewport: { width: 16, height: 16 },
    });
    const frame = (id: string, x = 0) => {
      writeFileSync(path.join(directory, `${id}.png`), image);
      return { id, image: `${id}.png`, position: [x, 2, 0], target: [x, 0, 10] };
    };
    const manifest = {
      schemaVersion: 1,
      world: "test-world",
      build: `${side}-${index}`,
      route: "fixed-leg",
      seed: "42",
      nearBandMeters: 25,
      capture: "capture.json",
      landmarks: [{ id: "pine-1", position: [0, 0, 8] }],
      samePose: [frame("forest"), frame("road"), frame("step-2", 2)],
      walk: [0, 1, 2].map((time) => ({ ...frame(`step-${time}`, time), timeMs: time * 100 })),
    };
    const file = path.join(directory, "world.json");
    write(file, manifest);
    return file;
  };
  const before = Array.from({ length: beforeRuns }, (_, index) => run("reference", index));
  const after = Array.from({ length: afterRuns }, (_, index) => run("candidate", index));
  return { root, before, after, out: path.join(root, "gate") };
}

async function multiReady(beforeRuns = 2, afterRuns = 2) {
  const f = await multiFixture(beforeRuns, afterRuns);
  const built = buildWorldVisualBundle(f.before, f.after, f.out);
  return { ...f, built, bundle: read(path.join(built.bundle, "bundle.json")) };
}

/** A near-band event injected into the anonymous series for one side. */
function poppingInto(
  v: { series: { label: string; transitions: { events: unknown[] }[] }[] },
  label: string,
  kind: "appear" | "disappear" | "lod-swap",
  distanceMeters: number,
) {
  const series = v.series.find((entry) => entry.label === label) as {
    transitions: { events: unknown[] }[];
  };
  series.transitions[0]?.events.push({
    element: "pine beside the road",
    kind,
    distanceMeters,
    description: "Abrupt change without occlusion or leaving the view.",
  });
}

interface IVerdictFixture {
  root: string;
  built: { bundle: string; bundleSha256: string };
  bundle: {
    promptSha256: string;
    samePose: { label: string }[];
    walk: { label: string; frames: { label: string }[] }[];
  };
}
// These are deliberately synthetic unit-test judgments, never real visual acceptance evidence.
function verdicts(f: IVerdictFixture) {
  return [1, 2, 3].map((critic) => {
    const file = path.join(f.root, `critic-${critic}.json`);
    write(file, {
      critic: `unit-test-${critic}`,
      bundleSha256: f.built.bundleSha256,
      promptSha256: f.bundle.promptSha256,
      samples: f.bundle.samePose.map(({ label }: { label: string }) => ({ label, visuals: 4 })),
      series: f.bundle.walk.map((series: { label: string; frames: { label: string }[] }) => ({
        label: series.label,
        transitions: series.frames.slice(1).map((frame, index) => ({
          from: series.frames[index]?.label,
          to: frame.label,
          events: [],
        })),
        missing: [],
      })),
    });
    return file;
  });
}

it("blinds both arms, keeps every walk chronological, and binds the rubric and images", async () => {
  const f = await ready();
  expect(f.bundle.samePose).toHaveLength(8);
  expect(f.bundle.walk).toHaveLength(2);
  expect(
    f.bundle.walk.map((s: { frames: { timeMs: number }[] }) =>
      s.frames.map((frame) => frame.timeMs),
    ),
  ).toEqual([
    [0, 100, 200],
    [0, 100, 200],
  ]);
  expect(f.built.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
  const publicManifest = JSON.stringify(f.bundle);
  for (const secret of ["reference", "candidate", "test-world", "forest", "road", "step-"])
    expect(publicManifest).not.toContain(secret);
  expect(scoreWorldVisualBundle(f.out, verdicts(f)).exitCode).toBe(0);
});

it("bundle-only is unjudged exit 2 and the score CLI distinguishes pass from regression", async () => {
  const f = await fixture();
  expect(runCli(["--before", f.before, "--after", f.after, "--out", f.out])).toBe(2);
  const bundle = read(path.join(f.out, "blind", "bundle.json"));
  const { createHash } = await import("node:crypto");
  const built = {
    bundle: path.join(f.out, "blind"),
    bundleSha256: createHash("sha256")
      .update(readFileSync(path.join(f.out, "blind", "bundle.json")))
      .digest("hex"),
  };
  const files = verdicts({ ...f, built, bundle });
  const args = ["--score", f.out, ...files.flatMap((file) => ["--verdict", file])];
  expect(runCli(args)).toBe(0);
  for (const file of files) {
    const value = read(file);
    for (const sample of value.samples) sample.visuals = 3;
    write(file, value);
  }
  expect(runCli(args)).toBe(1);
});

it("fails below the 4/5 candidate floor even when the paired delta is indeterminate", async () => {
  const f = await ready();
  const files = verdicts(f);
  for (const file of files) {
    const v = read(file);
    for (const sample of v.samples) sample.visuals = 3;
    write(file, v);
  }
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.samePose.rows.every((row) => row.classification === "INDETERMINATE")).toBe(true);
  expect(result.exitCode).toBe(1);
});

it("fails a measured same-pose LOSS even if the candidate still meets the floor", async () => {
  const f = await ready();
  const files = verdicts(f);
  const reveal = read(path.join(f.out, "poses", "reveal.json"));
  const baselineLabels = new Set(
    reveal
      .filter((entry: { arm: string }) => entry.arm.includes("::before"))
      .map((entry: { label: string }) => entry.label),
  );
  for (const file of files) {
    const v = read(file);
    for (const sample of v.samples) if (baselineLabels.has(sample.label)) sample.visuals = 5;
    write(file, v);
  }
  expect(
    scoreWorldVisualBundle(f.out, files).samePose.rows.every(
      (row) => row.classification === "LOSS",
    ),
  ).toBe(true);
  expect(scoreWorldVisualBundle(f.out, files).exitCode).toBe(1);
});

it.each(["appear", "disappear", "lod-swap"])(
  "fails a candidate near-band %s reported by even one critic",
  async (kind) => {
    const f = await ready();
    const files = verdicts(f);
    const v = read(files[0] as string);
    // Both anonymous arms get an event, so this assertion does not need to unblind them.
    for (const series of v.series)
      series.transitions[0].events.push({
        element: "pine beside the road",
        kind,
        distanceMeters: 25,
        description: "Abrupt change without occlusion or leaving the view.",
      });
    write(files[0] as string, v);
    const result = scoreWorldVisualBundle(f.out, files);
    expect(result.exitCode).toBe(1);
    expect(result.popping.some((event) => event.element === "pine beside the road")).toBe(true);
  },
);

it("reports far-band events without treating them as near-band failure", async () => {
  const f = await ready();
  const files = verdicts(f);
  const v = read(files[0] as string);
  for (const series of v.series)
    series.transitions[0].events.push({
      element: "distant pine",
      kind: "lod-swap",
      distanceMeters: 26,
      description: "Coarse silhouette changes.",
    });
  write(files[0] as string, v);
  expect(scoreWorldVisualBundle(f.out, files).exitCode).toBe(0);
});

it("accepts two capture runs per side and blinds every series", async () => {
  const f = await multiReady();
  expect(f.bundle.walk).toHaveLength(4);
  const seal = read(path.join(f.out, "seal.json"));
  expect(seal.series).toHaveLength(4);
  expect(seriesFor(f, "before")).toHaveLength(2);
  expect(seriesFor(f, "after")).toHaveLength(2);
  expect(new Set(seal.series.map((entry: { run: number }) => entry.run))).toEqual(new Set([0, 1]));
  const publicManifest = JSON.stringify(f.bundle);
  for (const secret of ["reference", "candidate", "before", "after", "test-world"])
    expect(publicManifest).not.toContain(secret);
  expect(scoreWorldVisualBundle(f.out, verdicts(f)).exitCode).toBe(0);
});

it("does not reject a bundle whose runs are not identical to each other", async () => {
  const f = await multiReady(1, 1);
  expect(f.bundle.walk).toHaveLength(2);
  expect(scoreWorldVisualBundle(f.out, verdicts(f)).exitCode).toBe(0);
});

it("fails a candidate event in every candidate run and no reference run", async () => {
  const f = await multiReady();
  const files = verdicts(f);
  const v = read(files[0] as string);
  for (const label of seriesFor(f, "after")) poppingInto(v, label, "disappear", 20);
  write(files[0] as string, v);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.exitCode).toBe(1);
  expect(result.popping.some((event) => event.disallowed && event.candidate)).toBe(true);
  expect(result.intermittent).toEqual([]);
});

it("does not fail when a reference run shows the same event", async () => {
  const f = await multiReady();
  const files = verdicts(f);
  const v = read(files[0] as string);
  for (const label of [...seriesFor(f, "after"), seriesFor(f, "before")[0] as string])
    poppingInto(v, label, "disappear", 20);
  write(files[0] as string, v);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.exitCode).toBe(0);
  expect(result.popping.some((event) => event.disallowed)).toBe(false);
  expect(result.intermittent).toEqual([]);
});

it.each([
  ["appear", 25],
  ["lod-swap", 20],
  ["disappear", 300],
  ["missing", 300],
] as const)(
  "needs more runs for intermittent candidate-only %s at %s meters",
  async (kind, distance) => {
    const f = await multiReady();
    const files = verdicts(f);
    const v = read(files[0] as string);
    const series = seriesFor(f, "after")[0] as string;
    if (kind === "missing") missingInto(v, series);
    else poppingInto(v, series, kind, distance);
    write(files[0] as string, v);
    const result = scoreWorldVisualBundle(f.out, files);
    expect(result).toMatchObject({
      exitCode: 2,
      verdict: "inconclusive",
      reason: "needs more runs",
    });
    expect(result.intermittent).toEqual([
      {
        critic: "unit-test-1",
        series,
        kind,
        distanceMeters: distance,
        candidateRuns: 1,
        referenceRuns: 0,
      },
    ]);
    expect(result.popping.every((event) => !event.disallowed)).toBe(true);
  },
);

it.each(["appear", "lod-swap"] as const)(
  "reports far intermittent %s without blocking a pass",
  async (kind) => {
    const f = await multiReady();
    const files = verdicts(f);
    const v = read(files[0] as string);
    poppingInto(v, seriesFor(f, "after")[0] as string, kind, 26);
    write(files[0] as string, v);
    const result = scoreWorldVisualBundle(f.out, files);
    expect(result.exitCode).toBe(0);
    expect(result.intermittent).toHaveLength(1);
  },
);

it("counts distinct runs per critic and suppresses intermittency only for that critic's reference", async () => {
  const f = await multiReady(2, 3);
  const files = verdicts(f);
  const v = read(files[0] as string);
  const other = read(files[1] as string);
  const reference = seriesFor(f, "before")[0] as string;
  for (let i = 0; i < 2; i += 1)
    poppingInto(v, seriesFor(f, "after")[0] as string, "disappear", 20);
  poppingInto(other, reference, "disappear", 20);
  write(files[0] as string, v);
  write(files[1] as string, other);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.exitCode).toBe(2);
  expect(
    result.intermittent.every((event) => event.candidateRuns === 1 && event.referenceRuns === 0),
  ).toBe(true);
  poppingInto(v, reference, "disappear", 20);
  write(files[0] as string, v);
  expect(scoreWorldVisualBundle(f.out, files)).toMatchObject({ exitCode: 0, intermittent: [] });
});

it("scores intermittent events through the CLI and allows an explicit pass override", async () => {
  const f = await multiReady();
  const files = verdicts(f);
  const v = read(files[0] as string);
  poppingInto(v, seriesFor(f, "after")[0] as string, "disappear", 20);
  write(files[0] as string, v);
  const args = ["--score", f.out, ...files.flatMap((file) => ["--verdict", file])];
  expect(runCli(args)).toBe(2);
  expect(read(path.join(f.out, "score.json"))).toMatchObject({
    verdict: "inconclusive",
    reason: "needs more runs",
    intermittent: [{ candidateRuns: 1 }],
  });
  expect(runCli([...args, "--allow-intermittent"])).toBe(0);
  expect(read(path.join(f.out, "score.json"))).toMatchObject({
    verdict: "pass",
    intermittent: [{ candidateRuns: 1 }],
  });
  for (const label of seriesFor(f, "after")) poppingInto(v, label, "appear", 20);
  write(files[0] as string, v);
  expect(runCli(args)).toBe(1);
  expect(runCli([...args, "--allow-intermittent"])).toBe(1);
});

it("fails a candidate missing event present in every candidate run only", async () => {
  const f = await multiReady();
  const files = verdicts(f);
  const v = read(files[0] as string);
  for (const label of seriesFor(f, "after")) missingInto(v, label);
  write(files[0] as string, v);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.exitCode).toBe(1);
  expect(result.popping.some((event) => event.kind === "missing" && event.disallowed)).toBe(true);
});

/** The private seal is the instrument's own answer; the specs use it to aim an anonymous event. */
const seriesFor = (f: { out: string }, side: "before" | "after"): string[] =>
  (read(path.join(f.out, "seal.json")).series as { label: string; arm: string }[])
    .filter((entry) => entry.arm === side)
    .map((entry) => entry.label);
const arm = (f: { out: string }) => seriesFor(f, "after")[0] as string;
const missingInto = (v: { series: { label: string; missing: unknown[] }[] }, label: string) =>
  (v.series.find((entry) => entry.label === label) as { missing: unknown[] }).missing.push(
    crossSeries,
  );

it("fails a candidate that never draws what the other series draws, at any distance", async () => {
  const f = await ready();
  const files = verdicts(f);
  const v = read(files[0] as string);
  missingInto(v, arm(f));
  write(files[0] as string, v);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.exitCode).toBe(1);
  expect(result.popping).toContainEqual(
    expect.objectContaining({ kind: "missing", candidate: true, disallowed: true }),
  );
});

it("reports a reference-side missing event without failing the candidate", async () => {
  const f = await ready();
  const files = verdicts(f);
  const v = read(files[0] as string);
  missingInto(v, f.bundle.walk.find((s: { label: string }) => s.label !== arm(f)).label);
  write(files[0] as string, v);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.exitCode).toBe(0);
  expect(result.popping).toContainEqual(
    expect.objectContaining({ kind: "missing", candidate: false, disallowed: false }),
  );
});

it.each(["from", "to"])("rejects a missing event without its %s frame id", async (id) => {
  const f = await ready();
  const files = verdicts(f);
  const v = read(files[0] as string);
  const event: Record<string, unknown> = { ...crossSeries };
  delete event[id];
  (v.series[0].missing as unknown[]).push(event);
  write(files[0] as string, v);
  expect(() => scoreWorldVisualBundle(f.out, files)).toThrow();
});

it.each([
  "missing pose",
  "extra pose",
  "wrong pose",
  "wrong seed",
  "wrong route",
  "wrong near band",
  "reversed time",
  "stationary walk",
  "missing image",
  "blank image",
  "wrong viewport",
  "software adapter",
  "unnamed adapter",
  "missing capture",
  "invalid capture",
])("rejects %s before building", async (kind) => {
  const f = await fixture();
  const m = read(f.after);
  const captureFile = path.join(path.dirname(f.after), "capture.json");
  const capture = read(captureFile);
  const mutations: Record<string, () => void> = {
    "missing pose": () => m.samePose.pop(),
    "extra pose": () => m.samePose.push({ ...m.samePose[0], id: "extra" }),
    "wrong pose": () => {
      m.samePose[0].position[0] = 10;
    },
    "wrong seed": () => {
      m.seed = "other";
    },
    "wrong route": () => {
      m.route = "other";
    },
    "wrong near band": () => {
      m.nearBandMeters = 50;
    },
    "reversed time": () => m.walk.reverse(),
    "stationary walk": () => {
      for (const frame of m.walk) frame.position = [0, 2, 0];
    },
    "missing image": () => rmSync(path.join(path.dirname(f.after), m.walk[0].image)),
    "blank image": () =>
      writeFileSync(
        path.join(path.dirname(f.after), m.walk[0].image),
        PNG.sync.write(new PNG({ width: 16, height: 16 })),
      ),
    "wrong viewport": () => {
      capture.viewport.width = 20;
    },
    "software adapter": () => {
      capture.adapter.architecture = "swiftshader";
    },
    "unnamed adapter": () => {
      capture.adapter = {};
    },
    "invalid capture": () => {
      capture.rendererKind = "webgl";
    },
  };
  mutations[kind]?.();
  write(f.after, m);
  write(captureFile, capture);
  if (kind === "missing capture") rmSync(captureFile);
  expect(() => buildWorldVisualBundle(f.before, f.after, f.out)).toThrow();
});

it.each([
  "missing score",
  "extra score",
  "duplicate score",
  "missing transition",
  "extra transition",
  "duplicate transition",
  "reversed transition",
  "missing series",
  "invalid event",
  "stale hash",
  "stale rubric",
  "duplicate critic",
])("rejects %s instead of reporting a pass", async (kind) => {
  const f = await ready();
  const files = verdicts(f);
  const v = read(files[0] as string);
  if (kind === "missing score") v.samples.pop();
  if (kind === "extra score") v.samples.push({ label: "extra", visuals: 4 });
  if (kind === "duplicate score") v.samples.push(v.samples[0]);
  if (kind === "missing transition") v.series[0].transitions.pop();
  if (kind === "extra transition")
    v.series[0].transitions.push({ from: "other", to: "nope", events: [] });
  if (kind === "duplicate transition") v.series[0].transitions.push(v.series[0].transitions[0]);
  if (kind === "reversed transition") v.series[0].transitions.reverse();
  if (kind === "missing series") v.series.pop();
  if (kind === "invalid event")
    v.series[0].transitions[0].events.push({ element: "tree", kind: "maybe", distanceMeters: -1 });
  if (kind === "stale hash") v.bundleSha256 = "a".repeat(64);
  if (kind === "stale rubric") v.promptSha256 = "b".repeat(64);
  if (kind === "duplicate critic") v.critic = "unit-test-2";
  write(files[0] as string, v);
  expect(() => scoreWorldVisualBundle(f.out, files)).toThrow();
});

it("requires exactly three independent critic files, including realpath aliases", async () => {
  const f = await ready();
  const files = verdicts(f);
  expect(() => scoreWorldVisualBundle(f.out, files.slice(1))).toThrow();
  expect(() =>
    scoreWorldVisualBundle(f.out, [files[0] as string, files[0] as string, files[2] as string]),
  ).toThrow();
  const alias = path.join(f.root, "alias.json");
  symlinkSync(files[0] as string, alias);
  expect(() =>
    scoreWorldVisualBundle(f.out, [files[0] as string, alias, files[2] as string]),
  ).toThrow();
});

it.each(["source image", "source metadata", "blind image", "private reveal", "rubric"])(
  "rejects mutated %s after bundling",
  async (kind) => {
    const f = await ready();
    const files = verdicts(f);
    const file =
      kind === "source image"
        ? path.join(path.dirname(f.after), "forest.png")
        : kind === "source metadata"
          ? f.after
          : kind === "private reveal"
            ? path.join(f.out, "poses", "reveal.json")
            : kind === "rubric"
              ? path.join(f.built.bundle, "rubric.md")
              : path.join(f.built.bundle, f.bundle.samePose[0].image);
    writeFileSync(file, "changed");
    expect(() => scoreWorldVisualBundle(f.out, files)).toThrow();
  },
);

it("does not silently reuse a populated bundle directory", async () => {
  const f = await ready();
  expect(() => buildWorldVisualBundle(f.before, f.after, f.out)).toThrow();
});

it("maps scored pose rows back to the source IDs only after judging", async () => {
  const f = await ready();
  const result = scoreWorldVisualBundle(f.out, verdicts(f));
  // The walk's own last pose is scored too: content that only appears at the end never pops.
  expect(result.samePose.rows.map(({ template }) => template).sort()).toEqual([
    "forest",
    "road",
    "step-2",
  ]);
});

it("binds the external verdict files in the final score", async () => {
  const f = await ready();
  const files = verdicts(f);
  const result = scoreWorldVisualBundle(f.out, files);
  expect(result.verdicts).toHaveLength(3);
  expect(result.verdicts.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256))).toBe(true);
});

it("removes a stale success report when subsequent scoring becomes invalid", async () => {
  const f = await ready();
  const files = verdicts(f);
  const args = ["--score", f.out, ...files.flatMap((file) => ["--verdict", file])];
  expect(runCli(args)).toBe(0);
  const scoreFile = path.join(f.out, "score.json");
  expect(read(scoreFile).verdict).toBe("pass");
  writeFileSync(files[0] as string, "invalid");
  expect(runCli(args)).toBe(2);
  expect(() => readFileSync(scoreFile)).toThrow();
});

it.each([
  {
    vendor: " unknown ",
    architecture: "",
    device: "unavailable",
    description: "none",
    features: "float32-filterable",
    "limit.maxBindGroups": "4",
  },
  { features: "float32-filterable", "limit.maxBindGroups": "4" },
])("does not mistake adapter feature/limit metadata for a hardware name", async (adapter) => {
  const f = await fixture();
  const captureFile = path.join(path.dirname(f.after), "capture.json");
  const capture = read(captureFile);
  capture.adapter = adapter;
  write(captureFile, capture);
  expect(() => buildWorldVisualBundle(f.before, f.after, f.out)).toThrow(/named hardware adapter/);
});

it.each(["near band", "walk coverage", "pose pixels"])(
  "rejects changed public %s even if critics rebind their verdicts",
  async (kind) => {
    const f = await ready();
    if (kind === "near band") f.bundle.nearBandMeters = 0;
    if (kind === "walk coverage") for (const series of f.bundle.walk) series.frames.pop();
    if (kind === "pose pixels") f.bundle.samePose[0].image = f.bundle.samePose[1].image;
    const bundleFile = path.join(f.built.bundle, "bundle.json");
    write(bundleFile, f.bundle);
    const { createHash } = await import("node:crypto");
    f.built.bundleSha256 = createHash("sha256").update(readFileSync(bundleFile)).digest("hex");
    expect(() => scoreWorldVisualBundle(f.out, verdicts(f))).toThrow();
  },
);
