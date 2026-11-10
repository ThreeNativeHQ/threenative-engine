// Pure path classification for the CI change scope: which family a changed path belongs to, and
// which selection a complete diff earns. It reads no file, runs no process and calls no API, so a
// spec can feed it any list of paths. The kit names it cannot read come in as `templates`.
// Re-exported by `scripts/ci-change-scope.mjs`, which binds them to the shipped kits.

const EXCLUDED_MARKDOWN = [
  /^docs\/PRDs\/realism-effects\/README\.md$/u,
  /^docs\/verification\/(?:PRD-289-conventions|alpha-bar|runtime-perf-state)\.md$/u,
  /^docs\/verification\/realism-effects-ao(?:-|\.)/u,
  /^docs\/verification\/worker-wake(?:-|\.)/u,
  /^docs\/verification\/native-(?:runtime-)?(?:census|coverage)(?:-|\.)/u,
  /^docs\/verification\/(?:round-|parity-|sweep-|tier-1-)/u,
  // The scaffold reads these and throws when one is missing, so no scaffold starts.
  /^packages\/create-threenative\/(?:agent-docs|agent-files)\//u,
];
// Paths whose change the native platform matrix has to prove. Recorded as data beside the other
// path classes: a new package or action that `native-platforms.yml` builds or consumes belongs in
// this list, or the matrix silently stops covering it. The action directories are enumerated from
// the `uses: ./.github/actions/...` references in that workflow.
export const NATIVE_PATHS = [
  /^packages\/runtime-native\//u,
  // Runtime mechanisms, generated hosts and their dependency manifests have native consumers.
  /^packages\/(?:core|physics|ui|assets|playtest|create-threenative)\/(?:src\/|package\.json$)/u,
  /^examples\/native-smoke\//u,
  /^tsconfig(?:\.base)?\.json$/u,
  /^\.github\/workflows\/native-platforms\.yml$/u,
  /^\.github\/actions\/(?:android-v8-source|playwright-chromium|pnpm|scaffold-from-tarballs|workspace-dist)\//u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
];

// PRD-573 slice 0b. The native engine's own tree is proven by the `native-engine` job, so a diff
// made only of these paths skips the native-platforms matrix. The engine lives under runtime-native
// (src/engine, src/adapters, tests/native-engine and cmake/NativeEngine*.cmake on
// origin/feat/native-engine), so these carve out of NATIVE_PATHS rather than extend it. Anchored on
// a trailing slash or a file prefix, never a bare directory prefix: `src/engineering/` and
// `cmake/CheckNativeEngineGraph.cmake` are legacy runtime-native paths and keep the matrix.
export const NATIVE_ENGINE_PATHS = [
  /^packages\/runtime-native\/src\/(?:engine|adapters)\//u,
  /^packages\/runtime-native\/tests\/native-engine\//u,
  /^packages\/runtime-native\/cmake\/NativeEngine[^/]*$/u,
];

export function isEnginePath(file) {
  return NATIVE_ENGINE_PATHS.some((pattern) => pattern.test(file));
}

export function isNativePath(file) {
  return !isEnginePath(file) && NATIVE_PATHS.some((pattern) => pattern.test(file));
}
// These producer families keep the existing full build/unit/browser/native board. Only the
// redundant kit fanout narrows: each changed kit still proves itself, and starter exercises the
// default tarball/scaffold/physics/React/asset/MCP/boot route. Unknown executables keep all kits.
const REPRESENTATIVE_INPUTS = [
  /^docs\/(?:verification|benchmark)\/.*\.(?:png|jpe?g|webp|json|gz|txt)$/u,
  /^packages\/(?:core|physics|ui|assets|playtest|runtime-native|create-threenative|terrain|metahuman|raw-unreal|ueformat|engine-mcp|blender-bridge)\//u,
  /^examples\//u,
  /^scripts\/__tests__\/[^/]+\.spec\.ts$/u,
  /^scripts\/(?:api-surface\.json|run-test-suite\.sh|verify-animation-reversal\.ts|temporal-aa-(?:evidence|quality)\.ts|velocity-(?:capture|cost)-proof\.ts|verify-temporal-(?:aa|motion)\.ts|verify-velocity-history\.ts)$/u,
  /^\.github\/(?:workflows\/[^/]+\.yml|actions\/(?:workspace-dist|pnpm|playwright-chromium|scaffold-from-tarballs|android-v8-source)\/)/u,
  /^(?:package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig(?:\.base)?\.json|biome\.json|\.gitignore)$/u,
];
// CI configuration: the workflows, the scripts that decide and report on the board, their own specs
// and the runner images. A diff made only of these cannot change a line of engine, template or
// package, so the jobs with no consumer for a workflow file are the only thing it can break — and
// the `ci` selection is exactly those. Deliberately narrow: `.github/actions/**` is excluded because
// the native matrix consumes it, and `pnpm-lock.yaml`/`pnpm-workspace.yaml` because they change what
// every job installs. Both keep `full`.
export const CI_CONFIG_PATHS = [
  /^\.github\/workflows\/[^/]+\.yml$/u,
  /^scripts\/ci-[^/]+\.(?:mjs|sh|ts)$/u,
  /^scripts\/ci\/[^/]+\.mjs$/u,
  /^scripts\/__tests__\/ci-[^/]+\.spec\.ts$/u,
  /^tools\/ci-runners\//u,
];
// Strata terrain jobs: runs when terrain, example or core world modules change, or full qualification.
const STRATA_PATHS = [
  /^packages\/terrain\//u,
  /^examples\/strata-terrain-preview\//u,
  /^packages\/core\/(?:src\/world(?:-|\.ts)|src\/terrain-jobs|__tests__\/world-)/u,
];

export function isStrataPath(file) {
  return STRATA_PATHS.some((pattern) => pattern.test(file));
}

export function parseNameStatus(output) {
  if (!output.endsWith("\0")) return { error: "unterminated name-status records" };
  const fields = output.slice(0, -1).split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status || !/^(?:[ADM]|[RC]\d{3})$/u.test(status)) {
      return { error: `unsupported or malformed diff status ${JSON.stringify(status ?? "")}` };
    }
    const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
    const changed = fields.slice(index, index + count);
    if (changed.length !== count || changed.some((file) => !file))
      return { error: `malformed ${status} diff record` };
    paths.push(...changed);
    index += count;
  }
  return { paths: [...new Set(paths)].sort() };
}

export function pathFamily(file, selective, templates) {
  if (
    /^packages\/create-threenative\/templates\/[^/]+\/(?:AGENTS|CLAUDE)\.md$/u.test(file) &&
    selective
  )
    return "ci";
  if (/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(file)) {
    // Root and playtest instruction consumers have explicit contracts in the instruction lane.
    // Shipped template/native instructions may affect scaffolding and platform contracts too.
    return selective && /^(?:packages\/playtest\/)?(?:AGENTS|CLAUDE)\.md$/u.test(file)
      ? "instructions"
      : "an instruction consumer whose narrower dependency closure is unproven";
  }
  if (EXCLUDED_MARKDOWN.some((pattern) => pattern.test(file)))
    return "a Markdown file consumed by an executable fixture, parser or gate";
  if (CI_CONFIG_PATHS.some((pattern) => pattern.test(file))) return "ci";
  // Any Markdown the executable fixtures do not consume is inert: a .md-only PR runs no CI job.
  // Doc links, evidence budgets and secret scans are re-validated on the develop nightly run and
  // at promotion. AGENTS.md/CLAUDE.md are instruction consumers and are handled above.
  if (file.endsWith(".md")) return "prose";
  // The speed-loop record is generated data. Only scripts/ci-speed-loop.mjs reads it, and that
  // script matches the scripts/ci-* CI rule, so a change to it still runs the CI lanes.
  if (/^docs\/ci-speed\/(?:ledger\.json|runs\/\d+\.jobs\.json)$/u.test(file)) return "prose";
  if (changedTemplates([file], templates).length > 0) return "template";
  if (isEnginePath(file)) return "native-engine";
  return "a non-Markdown path";
}

/**
 * The selection a complete diff earns, or the first path that keeps the whole board. Every path has
 * to be in an accepted family: one `packages/` file sorted after a workflow still decides the board.
 * Prose is already covered by lint's doc lane, so prose plus instructions is `instructions`; `ci`
 * outranks both — it is the narrower set by a wide margin, so a diff mixing a workflow with a doc
 * must not drop typecheck or the unit shards to gain lint alone.
 */
export function diffSelection(paths, selective, templates) {
  const families = new Set();
  for (const file of paths) {
    const family = pathFamily(file, selective, templates);
    if (!["prose", "instructions", "ci", "template", "native-engine"].includes(family))
      return { blocked: file, family };
    families.add(family);
  }
  // The engine job proves only the engine tree. Beside a workflow or a template kit it would drop
  // gates those paths owe, so the mixed diff keeps the whole board (which still runs the engine job).
  if (families.has("native-engine")) {
    const other = paths.find((file) =>
      ["ci", "template"].includes(pathFamily(file, selective, templates)),
    );
    if (other !== undefined)
      return {
        blocked: other,
        family: "mixed with a native-engine path, whose narrower closure is unproven",
      };
  }
  return {
    families,
    selection: families.has("native-engine")
      ? "native-engine"
      : families.has("template")
        ? "template"
        : families.has("ci")
          ? "ci"
          : families.has("instructions")
            ? "instructions"
            : "prose",
  };
}

export function changedTemplates(files, templates) {
  const names = new Set();
  for (const file of files) {
    const match =
      /^packages\/create-threenative\/(?:templates|template-playtests)\/([^/]+)\/.+/u.exec(file);
    if (match && templates.includes(match[1]) && !file.endsWith(".md")) names.add(match[1]);
  }
  return [...names].sort();
}

export function representativeTemplates(files, target, templates) {
  if (
    files.some((file) => {
      const kit =
        /^packages\/create-threenative\/(?:templates|template-playtests)\/([^/]+)\//u.exec(file);
      return kit && !templates.includes(kit[1]);
    })
  )
    return false;
  return (
    target === "develop" &&
    files.length > 0 &&
    files.every(
      (file) =>
        file.endsWith(".md") ||
        REPRESENTATIVE_INPUTS.some((pattern) => pattern.test(file)) ||
        CI_CONFIG_PATHS.some((pattern) => pattern.test(file)),
    )
  );
}
