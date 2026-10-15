import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import {
  type IProfileOwnerOptions,
  profileClockCalibration,
  profileFlightOwners,
  profileOwners,
} from "../midway-bench/profile-owners.js";

const root = makeTempDirSync("tn-profile-owners-");
const repo = join(root, "repo");
const game = join(root, "game");
mkdirSync(repo);
mkdirSync(game);
const mapPath = join(game, "bundle.js.map");
const sources = [
  join(repo, "packages/core/src/engine.ts"),
  join(game, "src/game.ts"),
  join(game, "src/ui/hud.tsx"),
  join(repo, "packages/playtest/src/harness.ts"),
  join(root, "other/src/game.ts"),
  join(game, "node_modules/.pnpm/react-dom@19/node_modules/react-dom/client.js"),
];
const sourceMap = {
  version: 3,
  sources: sources.map((source) => relative(game, source)),
  sourcesContent: sources.map(() => "embedded original"),
  names: [],
  // Each generated line maps to line 0, column 0 of the next source.
  mappings: "AAAA;ACAA;ACAA;ACAA;ACAA;ACAA",
};
writeFileSync(mapPath, JSON.stringify(sourceMap));
const frame = (url: string, lineNumber = 0, functionName = "work", columnNumber = 0) => ({
  functionName,
  url,
  lineNumber,
  columnNumber,
});
function fixture() {
  return {
    startTime: 1000,
    endTime: 1800,
    nodes: [
      { id: 1, callFrame: frame("", -1, "(root)", -1), children: [2, 3, 4, 5, 6, 7, 8, 10, 11] },
      { id: 2, callFrame: frame("bundle", 0), children: [9] },
      { id: 3, callFrame: frame("bundle", 1) },
      { id: 4, callFrame: frame("bundle", 2) },
      { id: 5, callFrame: frame("bundle", 3) },
      { id: 6, callFrame: frame("unmapped", 0, "engine") },
      { id: 7, callFrame: frame("", -1, "(idle)", -1) },
      { id: 8, callFrame: frame("", -1, "(garbage collector)", -1) },
      { id: 9, callFrame: frame("", -1, "native", -1) },
      { id: 10, callFrame: frame("bundle", 4) },
      { id: 11, callFrame: frame("bundle", 5) },
    ],
    samples: [2, 3, 4, 5, 6, 7, 8, 9],
    timeDeltas: Array<number>(8).fill(100),
  };
}
const options = (): IProfileOwnerOptions => ({
  sourceMaps: { bundle: mapPath },
  repoRoot: repo,
  gameRoot: game,
  startUs: 11050,
  endUs: 11750,
  calibration: {
    proof: "fixture measured clock pair",
    offsetUs: 10000,
    maxErrorUs: 0,
    validFromUs: 11000,
    validToUs: 11800,
  },
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("bounded profile owners", () => {
  it("clips first/last intervals, maps zero-based coordinates, inherits native ownership and conserves time", () => {
    const p = fixture();
    const before = JSON.stringify(p);
    const mapBefore = readFileSync(mapPath, "utf8");
    const result = profileOwners(p, options());
    expect(result).toMatchObject({
      kind: "sampled-wall-time",
      windowUs: 700,
      sampledUs: 700,
      coveragePercent: 100,
      unattributedUs: 100,
    });
    for (const owner of ["engine", "game", "HUD", "harness", "unknown", "idle", "GC"] as const) {
      expect(result.owners[owner].durationUs).toBe(100);
      expect(result.owners[owner].percent).toBeCloseTo(100 / 7);
    }
    expect(Object.values(result.owners).reduce((sum, row) => sum + row.percent, 0)).toBeCloseTo(
      100,
    );
    expect(JSON.stringify(p)).toBe(before);
    expect(readFileSync(mapPath, "utf8")).toBe(mapBefore);
  });
  it("keeps a different project's mapped source unknown and identifies verified React dependency paths", () => {
    expect(
      profileOwners({ ...fixture(), samples: Array<number>(8).fill(10) }, options()).owners.unknown
        .durationUs,
    ).toBe(700);
    expect(
      profileOwners({ ...fixture(), samples: Array<number>(8).fill(11) }, options()).owners.HUD
        .durationUs,
    ).toBe(700);
  });
  it("uses generated columns unchanged and supports sourceRoot/file URLs", () => {
    const path = join(game, "column.map");
    writeFileSync(
      path,
      JSON.stringify({
        ...sourceMap,
        sourceRoot: `${repo}/`,
        sources: ["packages/physics/work.ts", "packages/playtest/harness.ts"],
        sourcesContent: ["a", "b"],
        mappings: "AAAA,KCAA",
      }),
    );
    const p = fixture();
    const node = p.nodes[1];
    if (!node) throw new Error("fixture missing node");
    node.callFrame.columnNumber = 5;
    const result = profileOwners(
      { ...p, samples: Array<number>(8).fill(2) },
      { ...options(), sourceMaps: { bundle: path } },
    );
    expect(result.owners.harness.durationUs).toBe(700);
  });
  it("never treats authored pseudo names as idle or GC", () => {
    const p = fixture();
    for (const node of p.nodes) if (node.id === 2) node.callFrame.functionName = "(idle)";
    expect(
      profileOwners({ ...p, samples: Array<number>(8).fill(2) }, options()).owners.engine
        .durationUs,
    ).toBe(700);
  });
  it("requires uncertainty margins at both sampled boundaries", () => {
    const o = options();
    o.calibration.maxErrorUs = 25;
    expect(profileOwners(fixture(), o).sampledUs).toBe(700);
    o.calibration.maxErrorUs = 51;
    o.calibration.validFromUs = 10000;
    o.calibration.validToUs = 12000;
    expect(() => profileOwners(fixture(), o)).toThrow("covered window start");
  });
  it("does not fill an unsampled tail to profile end", () => {
    const p = fixture();
    p.timeDeltas[7] = 0;
    expect(() => profileOwners(p, options())).toThrow("covered window end");
  });
  it("does not credit a symlink into a different project", () => {
    mkdirSync(join(game, "src"));
    mkdirSync(join(root, "outsider"));
    symlinkSync(join(root, "outsider"), join(game, "src/ui"));
    const result = profileOwners({ ...fixture(), samples: Array<number>(8).fill(4) }, options());
    expect(result.owners.unknown.durationUs).toBe(700);
  });
  it.each([
    [
      "missing calibration",
      (o: IProfileOwnerOptions) => {
        o.calibration = undefined as never;
      },
    ],
    [
      "empty proof",
      (o: IProfileOwnerOptions) => {
        o.calibration.proof = " ";
      },
    ],
    [
      "nonfinite calibration",
      (o: IProfileOwnerOptions) => {
        o.calibration.offsetUs = Number.NaN;
      },
    ],
    [
      "insufficient bounds",
      (o: IProfileOwnerOptions) => {
        o.calibration.validToUs = 11700;
      },
    ],
    [
      "negative uncertainty",
      (o: IProfileOwnerOptions) => {
        o.calibration.maxErrorUs = -1;
      },
    ],
    [
      "nonfinite window",
      (o: IProfileOwnerOptions) => {
        o.startUs = Number.NaN;
      },
    ],
    [
      "unordered window",
      (o: IProfileOwnerOptions) => {
        o.endUs = o.startUs;
      },
    ],
    [
      "uncovered start",
      (o: IProfileOwnerOptions) => {
        o.startUs = 10900;
        o.calibration.validFromUs = 10000;
      },
    ],
    [
      "uncovered end",
      (o: IProfileOwnerOptions) => {
        o.endUs = 11900;
        o.calibration.validToUs = 12000;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const o = options();
    mutate(o);
    expect(() => profileOwners(fixture(), o)).toThrow();
  });
  it.each([
    ["missing profile", () => undefined],
    ["missing nodes", () => ({ ...fixture(), nodes: undefined })],
    [
      "duplicate nodes",
      () => {
        const p = fixture();
        p.nodes.push(p.nodes[1] as (typeof p.nodes)[number]);
        return p;
      },
    ],
    [
      "missing child",
      () => {
        const p = fixture();
        p.nodes[0]?.children?.push(99);
        return p;
      },
    ],
    [
      "missing parent",
      () => {
        const p = fixture();
        p.nodes[0]?.children?.pop();
        return p;
      },
    ],
    [
      "cycle",
      () => {
        const p = fixture();
        const node = p.nodes[0];
        if (!node) throw new Error("fixture missing root");
        node.children = [2, 3, 4, 5, 6, 7, 8, 10];
        p.nodes.push({ id: 12, callFrame: frame(""), children: [11] });
        const cyclic = p.nodes[10];
        if (!cyclic) throw new Error("fixture missing cycle");
        cyclic.children = [12];
        return p;
      },
    ],
    ["missing sample node", () => ({ ...fixture(), samples: [99], timeDeltas: [100] })],
    ["delta count", () => ({ ...fixture(), timeDeltas: [100] })],
    [
      "negative delta",
      () => ({ ...fixture(), timeDeltas: [-1, 100, 100, 100, 100, 100, 100, 100] }),
    ],
    ["overflow delta", () => ({ ...fixture(), timeDeltas: Array<number>(8).fill(1e308) })],
  ])("rejects %s", (_name, make) => {
    expect(() => profileOwners(make(), options())).toThrow();
  });
  it.each([
    { ...sourceMap, version: 2 },
    { ...sourceMap, mappings: "!" },
    { ...sourceMap, mappings: "AACA", sources: [], sourcesContent: [] },
    { ...sourceMap, sourcesContent: [] },
    { ...sourceMap, mappings: "AA" },
  ])("rejects malformed maps %j", (data) => {
    const path = join(game, "bad.map");
    writeFileSync(path, JSON.stringify(data));
    expect(() =>
      profileOwners(fixture(), { ...options(), sourceMaps: { bundle: path } }),
    ).toThrow();
  });
  it("rejects unreadable map files", () => {
    expect(() =>
      profileOwners(fixture(), { ...options(), sourceMaps: { bundle: join(root, "missing.map") } }),
    ).toThrow();
  });
});

describe("profile flight integration", () => {
  it("derives a bounded offset from both measured profile endpoints", () => {
    expect(
      profileClockCalibration({
        startTime: 1000,
        endTime: 1800,
        clockBounds: { clock: "CLOCK_MONOTONIC", start: [10990, 11010], end: [11795, 11805] },
      }),
    ).toMatchObject({ offsetUs: 10000, maxErrorUs: 5, validFromUs: 11000, validToUs: 11800 });
  });
  it.each([
    undefined,
    { startTime: 1000, endTime: 1800 },
    {
      startTime: 1000,
      endTime: 1800,
      clockBounds: { clock: "CLOCK_MONOTONIC", start: [11000, 11010], end: [12000, 12010] },
    },
    {
      startTime: 1000,
      endTime: 1800,
      clockBounds: { clock: "CLOCK_MONOTONIC", start: [11010, 11000], end: [11800, 11810] },
    },
  ])("rejects absent or inconsistent calibration %j", (raw) => {
    expect(() => profileClockCalibration(raw)).toThrow(/clockBounds|calibration/);
  });
  it.each([false, true])("writes map-hashed diagnostic-only ownership on desktop=%s", (desktop) => {
    const dir = makeTempDirSync("tn-profile-flight-");
    const source = join(dir, "game");
    const artifact = join(source, "dist");
    mkdirSync(source);
    mkdirSync(artifact);
    const script = join(artifact, "game.js");
    const map = `${script}.map`;
    writeFileSync(script, desktop ? "work();" : "work();\n//# sourceMappingURL=game.js.map");
    writeFileSync(
      map,
      JSON.stringify({
        version: 3,
        sources: [relative(artifact, join(source, "src/game.ts"))],
        sourcesContent: ["work();"],
        names: [],
        mappings: "AAAA",
      }),
    );
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(
      join(artifact, "midway-provenance.json"),
      JSON.stringify({
        buildProtocol: "midway-clean-build-v1",
        engineCommit: "a".repeat(40),
        artifacts: { "game.js.map": sha(map) },
      }),
    );
    const url = desktop ? script : "http://127.0.0.1:5173/game.js";
    const profile = {
      ...fixture(),
      nodes: [
        { id: 1, callFrame: frame("", -1, "(root)", -1), children: [2] },
        { id: 2, callFrame: frame(url) },
      ],
      samples: Array<number>(8).fill(2),
      clockBounds: { clock: "CLOCK_MONOTONIC", start: [10995, 11005], end: [11795, 11805] },
    };
    writeFileSync(join(dir, "flight.cpuprofile"), JSON.stringify(profile));
    const windows = ["released-stick-climb", "canopy-and-instruments", "gun-view"].map(
      (label, i) => ({
        label,
        frames: 1000,
        updates: 1000,
        renders: 1000,
        startTick: i * 1000,
        endTick: (i + 1) * 1000,
        startUs: 11100 + i * 200,
        endUs: 11200 + i * 200,
        mainThread: {
          pid: 1,
          tid: 1,
          starttime: "1",
          cpuNs: 1000000,
          cpuMs: 1,
          cpuMsPerFrame: 0.001,
          instructions: 1000,
          instructionsPerFrame: 1,
          cycles: 1000,
          cyclesPerFrame: 1,
        },
        processTree: { cpuMs: 1, pids: [1] },
        host: { load: [0, 0, 0], governors: {} },
      }),
    );
    const report = {
      pass: true,
      scenario: "fixture",
      url: "http://127.0.0.1:5173",
      assertionResults: [{ pass: true }],
      target: desktop ? "desktop" : "browser",
      clock: "fixed-step",
      runtime: desktop ? "native" : "web",
      acquisition: { requestUrls: [url], cpuWindows: windows },
      observations: {
        // The host brackets each window in its own ticks (TN_PLAYER_RENDER_HOLD), and the reconciler
        // matches 1000 consecutive frames inside every bracket.
        console: desktop
          ? [0, 1, 2].flatMap((window) => [
              {
                text: `TN_PLAYER_RENDER_HOLD:${JSON.stringify({ held: true, tick: window * 1000 })}`,
              },
              ...Array.from({ length: 1000 }, (_, i) => ({
                text: `TN_PLAYER_FRAME:${JSON.stringify({ tick: window * 1000 + i + 1, updates: 1 })}`,
              })),
              {
                text: `TN_PLAYER_RENDER_HOLD:${JSON.stringify({ held: false, tick: (window + 1) * 1000 })}`,
              },
            ])
          : [],
      },
    };
    writeFileSync(join(dir, "run.log"), `arm=test\n${JSON.stringify(report, null, 2)}\n`);
    const output = profileFlightOwners(dir, source, artifact, repo, desktop);
    expect(output.kind).toBe("profile-diagnostic-only");
    expect(output.artifacts["game.js.map"]).toBe(sha(map));
    expect(output.poses.map((pose) => pose.owners.game.durationUs)).toEqual([100, 100, 100]);
    expect(JSON.parse(readFileSync(join(dir, "profile-owners.json"), "utf8"))).toEqual(output);
    // Exercise the real shell caller with fixture runner/build processes; no GPU/build is launched.
    const bin = join(source, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(source, "engine.bin"), "engine");
    writeFileSync(
      join(source, "midway-provenance.json"),
      JSON.stringify({
        buildProtocol: "midway-clean-build-v1",
        engineCommit: "a".repeat(40),
        artifacts: { "engine.bin": sha(join(source, "engine.bin")) },
      }),
    );
    const artifactHash = createHash("sha256")
      .update(
        ["game.js", "game.js.map"].map((file) => `${file} ${sha(join(artifact, file))}`).join("\n"),
      )
      .digest("hex");
    writeFileSync(
      join(source, "dist.build-report.json"),
      JSON.stringify({
        schemaVersion: 1,
        target: "web",
        artifact: { kind: "directory", sha256: artifactHash },
      }),
    );
    const provenance = JSON.parse(readFileSync(join(artifact, "midway-provenance.json"), "utf8"));
    provenance.engineCommit = "a".repeat(40);
    writeFileSync(join(artifact, "midway-provenance.json"), JSON.stringify(provenance));
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    const mockRunner = `while [ "$#" -gt 0 ]; do
  if [ "$1" = --cpu-prof ]; then shift; cp "$FIXTURE_PROFILE" "$1"; fi
  shift
done
cat "$FIXTURE_REPORT"
`;
    writeFileSync(join(bin, "threenative-playtest"), `#!/bin/sh\n${mockRunner}`);
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh
case "$1" in
  */packages/playtest/dist/runner/cli.js) ${mockRunner} ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
`,
    );
    writeFileSync(
      join(bin, "pnpm"),
      '#!/bin/sh\nprintf "%s\n" "$*" >> "$BUILD_ARGS"\n[ "$2" != tsx ] || echo "PARITY PASS"\n',
    );
    for (const name of ["node", "pnpm", "threenative-playtest"]) chmodSync(join(bin, name), 0o755);
    const flight = spawnSync(
      "sh",
      [resolve("scripts/midway-bench/flight.sh"), desktop ? "desktop" : "legacy", "profile-smoke"],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          REAL_NODE: process.execPath,
          FIXTURE_PROFILE: join(dir, "flight.cpuprofile"),
          FIXTURE_REPORT: join(dir, "report.json"),
          BUILD_ARGS: join(dir, "build-args"),
          MIDWAY_CPU_PROFILE: "1",
          MIDWAY_MATCHED_CPU: "0",
          MIDWAY_BROWSER_CLOCK: "fixed-step",
          MIDWAY_LEGACY_DIR: source,
          MIDWAY_NATIVE_DIR: source,
          MIDWAY_PLAYER_DIR: artifact,
          MIDWAY_RUNS: join(dir, "runs"),
          MIDWAY_SCENARIO: resolve(
            `scripts/midway-bench/flight-bench${desktop ? "-desktop" : ""}.playtest.json`,
          ),
          MIDWAY_PARITY_REFS: "ref-a ref-b",
          TN_HEAVY_LOCK: "",
          TN_VK_ICD: "",
          TN_VK_LIB: "",
          TN_PLAYTEST_HOST_DISPLAY: "",
        },
      },
    );
    expect(flight.status, flight.stdout + flight.stderr).toBe(0);
    const written = JSON.parse(
      readFileSync(
        join(
          dir,
          `runs/profiles/profile-smoke-${desktop ? "desktop" : "legacy"}/profile-owners.json`,
        ),
        "utf8",
      ),
    );
    expect(written.poses.map((pose: { sampledUs: number }) => pose.sampledUs)).toEqual([
      100, 100, 100,
    ]);
    if (!desktop)
      expect(readFileSync(join(dir, "build-args"), "utf8")).toContain("run build:web --sourcemap");
    if (desktop) {
      writeFileSync(
        join(artifact, "midway-provenance.json"),
        JSON.stringify({ buildProtocol: "midway-clean-build-v1", artifacts: {} }),
      );
      expect(() => profileFlightOwners(dir, source, artifact, repo, desktop)).toThrow(/provenance/);
    } else {
      writeFileSync(script, "work();");
      expect(() => profileFlightOwners(dir, source, artifact, repo, desktop)).toThrow(
        /sourceMappingURL/,
      );
    }
    rmSync(map);
    expect(() => profileFlightOwners(dir, source, artifact, repo, desktop)).toThrow();
  });
  it.each([
    "packages/ui/src/index.ts",
    "packages/assets/src/index.ts",
    "packages/terrain/src/index.ts",
    "node_modules/.pnpm/three@0.1/node_modules/three/src/Three.js",
    "node_modules/.pnpm/ui@0.1/node_modules/@threenative/ui/dist/index.js",
    "node_modules/.pnpm/terrain@0.1/node_modules/@threenative/terrain/dist/index.js",
    "node_modules/.pnpm/assets@0.1/node_modules/@threenative/assets/dist/index.js",
  ])("attributes shipped engine source %s", (source) => {
    const path = join(root, "engine-source.map");
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        sources: [pathToFileURL(resolve(repo, source)).href],
        sourcesContent: ["work();"],
        names: [],
        mappings: "AAAA",
      }),
    );
    const result = profileOwners(
      { ...fixture(), samples: Array<number>(8).fill(2) },
      { ...options(), sourceMaps: { bundle: path } },
    );
    expect(result.owners.engine.durationUs).toBe(700);
  });
});
