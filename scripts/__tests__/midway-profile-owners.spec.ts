import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type IProfileOwnerOptions, profileOwners } from "../midway-bench/profile-owners.js";

const root = mkdtempSync(join(tmpdir(), "tn-profile-owners-"));
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
