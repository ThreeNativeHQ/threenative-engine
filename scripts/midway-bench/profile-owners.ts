import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    for (const name of ["core", "physics", "three-native", "runtime-native"])
      if (inside(resolve(repo, "packages", name), path)) return "engine";
    if (inside(resolve(repo, "packages/playtest"), path)) return "harness";
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
