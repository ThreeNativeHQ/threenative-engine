import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { matchedCpuWindows, terminalReport } from "./dashboard.js";

import type * as TraceMapping from "../../packages/create-threenative/node_modules/@jridgewell/trace-mapping/types/trace-mapping.d.cts";

const { TraceMap, decodedMappings, originalPositionFor } = createRequire(
  new URL("../../packages/create-threenative/package.json", import.meta.url),
)("@jridgewell/trace-mapping") as typeof TraceMapping;

type Owner = "engine" | "game" | "HUD" | "harness" | "unknown" | "idle" | "GC";
type INode = Profiler.ProfileNode;
type IProfile = Profiler.Profile & { samples: number[]; timeDeltas: number[] };
export interface IProfileOwnerOptions {
  sourceMaps: Readonly<Record<string, string>>;
  gameRoot: string;
  repoRoot: string;
  startUs: number;
  endUs: number;
  /** monotonicUs = profileUs + offsetUs; bounds and uncertainty are measured, not inferred. */
  calibration: {
    proof: string;
    offsetUs: number;
    maxErrorUs: number;
    validFromUs: number;
    validToUs: number;
  };
}
function fail(reason: string): never {
  throw new Error(`TN_PROFILE_OWNERS: ${reason}`);
}
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};
// Embedded sources need not exist; canonicalize their nearest existing ancestor to reject symlink escapes.
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : resolve(canonical(parent), relative(parent, path));
}

/** Exclusive sampled wall intervals, never schedstat CPU runtime or GPU evidence. Inputs stay untouched. */
export function profileOwners(raw: unknown, options: IProfileOwnerOptions) {
  const { startUs, endUs, calibration: c } = options;
  if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || startUs < 0 || endUs <= startUs)
    fail("invalid monotonic window");
  if (!c || typeof c.proof !== "string" || !c.proof.trim()) fail("missing clock calibration");
  if (![c.offsetUs, c.maxErrorUs, c.validFromUs, c.validToUs].every(Number.isFinite))
    fail("nonfinite calibration");
  if (
    c.maxErrorUs < 0 ||
    c.validFromUs > startUs - c.maxErrorUs ||
    c.validToUs < endUs + c.maxErrorUs
  )
    fail("invalid calibration bounds");
  if (typeof raw !== "object" || raw === null) fail("missing profile");
  const p = raw as IProfile;
  if (
    ![p.startTime, p.endTime].every(Number.isFinite) ||
    p.startTime < 0 ||
    p.endTime <= p.startTime
  )
    fail("invalid profile timestamps");
  if (![p.nodes, p.samples, p.timeDeltas].every(Array.isArray)) fail("missing profile arrays");
  if (!p.nodes.length || !p.samples.length || p.samples.length !== p.timeDeltas.length)
    fail("empty profile or mismatched deltas");
  const nodes = new Map<number, INode>();
  const parents = new Map<number, number>();
  for (const n of p.nodes) {
    if (!n || !Number.isSafeInteger(n.id) || n.id <= 0 || nodes.has(n.id)) fail("invalid node ID");
    const f = n.callFrame;
    if (!f || typeof f.functionName !== "string" || typeof f.url !== "string")
      fail("invalid frame");
    if (
      ![f.lineNumber, f.columnNumber].every(Number.isSafeInteger) ||
      Math.min(f.lineNumber, f.columnNumber) < -1
    )
      fail("invalid frame coordinates");
    if (n.children !== undefined && !Array.isArray(n.children)) fail("invalid children");
    nodes.set(n.id, n);
    for (const id of n.children ?? []) {
      if (!Number.isSafeInteger(id) || id <= 0 || parents.has(id)) fail("missing/duplicate parent");
      parents.set(id, n.id);
    }
  }
  for (const id of parents.keys()) if (!nodes.has(id)) fail("missing child node");
  const roots = p.nodes.filter((n) => !parents.has(n.id));
  const root = roots[0];
  if (roots.length !== 1 || !root) fail("missing parent/root");
  const reachable = [root.id];
  for (const id of reachable)
    for (const child of nodes.get(id)?.children ?? []) reachable.push(child);
  if (reachable.length !== nodes.size) fail("node cycle");
  if (!isAbsolute(options.repoRoot) || !isAbsolute(options.gameRoot))
    fail("roots must be absolute");
  const repo = realpathSync(options.repoRoot);
  const game = realpathSync(options.gameRoot);
  const maps = new Map<string, InstanceType<typeof TraceMap>>();
  if (
    !options.sourceMaps ||
    typeof options.sourceMaps !== "object" ||
    Array.isArray(options.sourceMaps)
  )
    fail("invalid verified source-map mapping");
  for (const [url, path] of Object.entries(options.sourceMaps)) {
    if (!url || typeof path !== "string" || !isAbsolute(path)) fail("invalid map path");
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.version !== 3 || !Array.isArray(data.sources) || !Array.isArray(data.names))
      fail("invalid source-map header");
    if (
      data.sources.some((s: unknown) => typeof s !== "string" || !s) ||
      data.names.some((s: unknown) => typeof s !== "string")
    )
      fail("invalid map sources/names");
    if (typeof data.mappings !== "string") fail("missing map mappings");
    const segments: string[] = data.mappings
      .split(";")
      .filter(Boolean)
      .flatMap((line: string) => line.split(","));
    if (
      segments.some((s) => !/^(?:[g-z0-9+/]*[A-Za-f])(?:(?:[g-z0-9+/]*[A-Za-f]){3,4})?$/u.test(s))
    )
      fail("invalid map VLQ");
    if (data.sourceRoot !== undefined && typeof data.sourceRoot !== "string")
      fail("invalid sourceRoot");
    if (data.sourcesContent !== undefined) {
      if (!Array.isArray(data.sourcesContent) || data.sourcesContent.length !== data.sources.length)
        fail("invalid embedded sources");
      if (data.sourcesContent.some((s: unknown) => s !== null && typeof s !== "string"))
        fail("invalid source content");
    }
    const map = new TraceMap(data, pathToFileURL(realpathSync(path)).href);
    for (const line of decodedMappings(map)) {
      let column = -1;
      for (const segment of line) {
        if (
          ![1, 4, 5].includes(segment.length) ||
          segment.some((v) => !Number.isSafeInteger(v) || v < 0)
        )
          fail("invalid map segment");
        if (segment[0] < column) fail("unordered map columns");
        if (segment.length > 1 && (segment[1] === undefined || segment[1] >= data.sources.length))
          fail("invalid map source index");
        if (segment.length === 5 && segment[4] >= data.names.length) fail("invalid map name index");
        column = segment[0];
      }
    }
    maps.set(url, map);
  }
  const classify = (source: string): Owner => {
    if (!source.startsWith("file:")) return "unknown";
    const path = canonical(fileURLToPath(source));
    for (const name of [
      "core",
      "physics",
      "three-native",
      "runtime-native",
      "ui",
      "assets",
      "terrain",
    ])
      if (inside(resolve(repo, "packages", name), path)) return "engine";
    if (inside(resolve(repo, "packages/playtest"), path)) return "harness";
    const dependency = path.split(sep).join("/");
    if (inside(game, path) || inside(repo, path)) {
      if (/(?:^|\/)node_modules\/@threenative\/playtest\//u.test(dependency)) return "harness";
      if (
        /(?:^|\/)node_modules\/(?:three|@threenative\/(?:core|physics|three-native|runtime-native|ui|assets|terrain))\//u.test(
          dependency,
        )
      )
        return "engine";
    }
    if (
      (inside(game, path) || inside(repo, path)) &&
      /(?:^|\/)node_modules\/(?:react|react-dom)\//u.test(path.split(sep).join("/"))
    )
      return "HUD";
    if (inside(resolve(game, "src/ui"), path) || inside(resolve(game, "src/hud"), path))
      return "HUD";
    return inside(resolve(game, "src"), path) ? "game" : "unknown";
  };
  const ownership = new Map<number, Owner>();
  for (const [id, node] of nodes) {
    const f = node.callFrame;
    if (
      f.url === "" &&
      f.lineNumber === -1 &&
      (f.functionName === "(idle)" || f.functionName === "(garbage collector)")
    ) {
      ownership.set(id, f.functionName === "(idle)" ? "idle" : "GC");
      continue;
    }
    const map = maps.get(f.url);
    if (map && f.lineNumber >= 0 && f.columnNumber >= 0) {
      const original = originalPositionFor(map, { line: f.lineNumber + 1, column: f.columnNumber });
      if (original.source !== null) ownership.set(id, classify(original.source));
    }
  }
  const durations = Object.fromEntries(
    ["engine", "game", "HUD", "harness", "unknown", "idle", "GC"].map((owner) => [owner, 0]),
  ) as Record<Owner, number>;
  let time = p.startTime + c.offsetUs;
  if (!Number.isFinite(time) || time > startUs - c.maxErrorUs) fail("missing covered window start");
  for (let i = 0; i < p.samples.length; i++) {
    const id = p.samples[i];
    const delta = p.timeDeltas[i];
    if (
      id === undefined ||
      !nodes.has(id) ||
      delta === undefined ||
      !Number.isFinite(delta) ||
      delta < 0
    )
      fail("invalid sample/delta");
    const next = time + delta;
    if (!Number.isFinite(next) || next > p.endTime + c.offsetUs) fail("sample outside profile");
    let cursor: number | undefined = id;
    let owner: Owner = ownership.get(id) ?? "unknown";
    // Only native/unknown-location leaves inherit; an unmapped authored script stays unknown.
    if (
      owner === "unknown" &&
      (nodes.get(id)?.callFrame.url === "" || nodes.get(id)?.callFrame.lineNumber === -1)
    ) {
      cursor = parents.get(cursor);
      while (cursor !== undefined) {
        const ancestor = ownership.get(cursor);
        if (ancestor && ancestor !== "unknown" && ancestor !== "idle" && ancestor !== "GC") {
          owner = ancestor;
          break;
        }
        cursor = parents.get(cursor);
      }
    }
    durations[owner] += Math.max(0, Math.min(next, endUs) - Math.max(time, startUs));
    time = next;
  }
  if (time < endUs + c.maxErrorUs) fail("missing covered window end");
  const sampledUs = Object.values(durations).reduce((a, b) => a + b, 0);
  const windowUs = endUs - startUs;
  if (Math.abs(sampledUs - windowUs) > Math.max(1e-6, windowUs * 1e-12))
    fail("sample time not conserved");
  return {
    kind: "sampled-wall-time" as const,
    startUs,
    endUs,
    windowUs,
    sampledUs,
    coveragePercent: (sampledUs / windowUs) * 100,
    unattributedUs: durations.unknown,
    calibration: { ...c },
    owners: Object.fromEntries(
      Object.entries(durations).map(([owner, durationUs]) => [
        owner,
        { durationUs, percent: (durationUs / sampledUs) * 100 },
      ]),
    ) as Record<Owner, { durationUs: number; percent: number }>,
  };
}

/** Intersect two observed monotonic/V8 clock brackets; never infer an offset from a pose boundary. */
export function profileClockCalibration(raw: unknown): IProfileOwnerOptions["calibration"] {
  const p = raw as {
    startTime?: number;
    endTime?: number;
    clockBounds?: { clock?: string; start?: number[]; end?: number[] };
  };
  const b = p?.clockBounds;
  if (
    b?.clock !== "CLOCK_MONOTONIC" ||
    !Array.isArray(b.start) ||
    !Array.isArray(b.end) ||
    b.start.length !== 2 ||
    b.end.length !== 2 ||
    ![p.startTime, p.endTime, ...b.start, ...b.end].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0,
    )
  )
    fail("missing/malformed measured clockBounds");
  const [s0, s1] = b.start as [number, number];
  const [e0, e1] = b.end as [number, number];
  const start = p.startTime as number;
  const end = p.endTime as number;
  if (s1 < s0 || e1 < e0 || e0 <= s1 || end <= start) fail("unordered clockBounds");
  const lower = Math.max(s0 - start, e0 - end);
  const upper = Math.min(s1 - start, e1 - end);
  if (lower > upper) fail("inconsistent clock calibration");
  const offsetUs = (lower + upper) / 2;
  return {
    proof: `CLOCK_MONOTONIC start=[${s0},${s1}] end=[${e0},${e1}]`,
    offsetUs,
    maxErrorUs: (upper - lower) / 2,
    validFromUs: start + offsetUs,
    validToUs: end + offsetUs,
  };
}

/** Reduce a separate profile flight using the exact same mapper and pose boundaries on both runtimes. */
export function profileFlightOwners(
  runDir: string,
  gameRoot: string,
  artifactRoot: string,
  repoRoot: string,
  desktop: boolean,
) {
  const profilePath = resolve(runDir, "flight.cpuprofile");
  const raw = JSON.parse(readFileSync(profilePath, "utf8"));
  const calibration = profileClockCalibration(raw);
  const log = readFileSync(resolve(runDir, "run.log"), "utf8");
  const report = terminalReport(log);
  const windows = matchedCpuWindows(log);
  if (!report || !windows || report.runtime !== (desktop ? "native" : "web"))
    fail("invalid profile flight report/CPU acquisition");
  const sourceMaps: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const sha = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const artifact = realpathSync(artifactRoot);
  const mapFor = (script: string, url: string): void => {
    if (!inside(artifact, realpathSync(script))) fail("script escapes artifact root");
    const ref = [...readFileSync(script, "utf8").matchAll(/[#@] sourceMappingURL=([^\s]+)/gu)].at(
      -1,
    )?.[1];
    // The shipped desktop esbuild bundle uses an external map without a sourceMappingURL comment.
    const map = desktop
      ? `${script}.map`
      : ref
        ? resolve(dirname(script), ref)
        : fail("production script has no sourceMappingURL");
    if (!inside(artifact, realpathSync(map))) fail("map escapes artifact root");
    if (desktop) {
      const provenance = JSON.parse(
        readFileSync(resolve(artifact, "midway-provenance.json"), "utf8"),
      );
      if (
        provenance.buildProtocol !== "midway-clean-build-v1" ||
        provenance.artifacts?.["game.js.map"] !== sha(map)
      )
        fail("native game.js.map missing/stale in build provenance");
    }
    sourceMaps[url] = map;
    hashes[relative(artifact, script)] = sha(script);
    hashes[relative(artifact, map)] = sha(map);
  };
  const urls = [...new Set<string>(raw.nodes.map((node: INode) => node.callFrame.url))];
  if (desktop) {
    const bundle = resolve(artifact, "game.js");
    for (const url of urls)
      if (url === bundle || url === pathToFileURL(bundle).href) mapFor(bundle, url);
  } else {
    const requested = report.acquisition?.requestUrls;
    if (
      !Array.isArray(requested) ||
      !requested.length ||
      requested.some((url) => typeof url !== "string")
    )
      fail("missing production request URLs");
    for (const url of urls) {
      if (!/^https?:/u.test(url) || !requested.includes(url)) continue;
      const path = decodeURIComponent(new URL(url).pathname);
      if (!path.endsWith(".js")) continue;
      mapFor(resolve(artifact, `.${path}`), url);
    }
  }
  if (!Object.keys(sourceMaps).length) fail("no profiled production script has a verified map");
  const poses = windows.map((window) => ({
    label: window.label,
    ...profileOwners(raw, {
      sourceMaps,
      gameRoot,
      repoRoot,
      startUs: window.startUs,
      endUs: window.endUs,
      calibration,
    }),
  }));
  const output = {
    kind: "profile-diagnostic-only",
    profileSha256: sha(profilePath),
    artifacts: hashes,
    poses,
  };
  writeFileSync(resolve(runDir, "profile-owners.json"), `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [runDir, gameRoot, artifactRoot, repoRoot, arm] = process.argv.slice(2);
  if (
    !runDir ||
    !gameRoot ||
    !artifactRoot ||
    !repoRoot ||
    !["legacy", "native", "desktop"].includes(arm ?? "")
  )
    fail("usage: profile-owners.ts <run-dir> <game-root> <artifact-root> <repo-root> <arm>");
  profileFlightOwners(
    resolve(runDir),
    resolve(gameRoot),
    resolve(artifactRoot),
    resolve(repoRoot),
    arm === "desktop",
  );
}
