import type { ICapabilityManifestEntry } from "./build-capability-manifest.js";

/**
 * Command-line and scenario-schema capabilities an agent otherwise rediscovers by grepping
 * `node_modules` or by writing a throwaway script (PRD-926).
 *
 * None of these is an importable function, so the manifest cannot find them by walking exports:
 * a playtest flag, a `threenative` subcommand, a scenario step and two runtime members that only
 * exist as interface or class methods. A trace audit counted 939 greps of `@threenative/*` for
 * names like these and about 185 hand-written parsers of one playtest report. The manifest is the
 * thing an agent searches first, so a row absent from it does not exist.
 *
 * `importPath` starts with `src/`: these rows are not imported, and the built-import check skips
 * them the way it skips the `ctx` members.
 */
function tool(entry: {
  readonly symbol: string;
  readonly packageName: string;
  readonly importPath: string;
  readonly signature: string;
  readonly summary: string;
  readonly situations: readonly string[];
  readonly aliases?: readonly string[];
  readonly constraints: readonly string[];
  readonly example: string;
}): ICapabilityManifestEntry {
  return {
    aliases: entry.aliases ?? [],
    constraints: entry.constraints,
    example: entry.example,
    importPath: entry.importPath,
    kind: "function",
    overrides: [],
    package: entry.packageName,
    signature: entry.signature,
    situations: entry.situations,
    summary: entry.summary,
    supersedes: [],
    symbol: entry.symbol,
  };
}

export const TOOLING_MANIFEST_ENTRIES: readonly ICapabilityManifestEntry[] = [
  tool({
    constraints: [
      "Exit codes are unchanged: 0 pass, 1 assertion failure, 2 runner failure, 75 capture lock busy.",
      "Without these flags stdout is still the full report; a report can pass 12 MB, so an agent should always pass --summary or --out.",
      "`--summary` prints under 4 KB: verdict, movementDelta, failed assertions with details, the top five deduplicated diagnostics, the final state and the artifact directory.",
    ],
    example:
      "threenative-playtest playtests/survives.playtest.json --summary --out .agent/playtests/survives.json --no-observations",
    importPath: "src/playtest-cli.ts",
    packageName: "@threenative/playtest",
    signature: "threenative-playtest <scenario> [--summary] [--out <file>] [--no-observations]",
    situations: [
      "read a playtest result without parsing megabytes of JSON",
      "get the pass or fail, failed assertions and final state of a playtest in a few lines",
      "write the full playtest report to a file and print only a summary",
      "stop writing a python or node script to parse a playtest report",
      "drop the huge per-tick observations from a playtest report",
    ],
    summary:
      "Print a compact playtest verdict and keep the full report on disk instead of dumping it to stdout.",
    symbol: "threenative-playtest --summary",
  }),
  tool({
    constraints: [
      "Read-only: it never modifies an asset, a manifest or an image.",
      "`--manifest` and `--frame` exit 1 on a finding; `--frame` reads non-interlaced 8-bit PNG only.",
      "A `.zip` left in `assets/` or an asset with no manifest entry fails `--manifest`; an `assets.exclude` match shows as unlisted.",
    ],
    example:
      "threenative inspect assets/car.glb --json && threenative inspect --manifest && threenative inspect --frame shot.png --sample hero:0.5,0.6",
    importPath: "src/inspect.ts",
    packageName: "create-threenative",
    signature:
      "threenative inspect <file.glb> | --manifest [--project <dir>] | --frame <image.png> [--sample role:u,v ...] [--json]",
    situations: [
      "check that a baked glb stands on the floor (minY is 0)",
      "count the triangles and list the material names of a glb",
      "read the asset extras (tnOrigin procedural) of a glb",
      "audit the assets folder against public/assets.manifest.json",
      "find leftover zip downloads and duplicate asset files",
      "check that a screenshot is not blank or black and read the colour at a point",
    ],
    summary:
      "One command for the glb, manifest and screenshot checks agents otherwise write 120 ad-hoc scripts for.",
    symbol: "threenative inspect",
  }),
  tool({
    constraints: [
      "A step needs `timeoutMs` (1 to 300000); the wait fails the scenario when the resource never matches.",
      "The game must expose the resource through the playtest bridge (`runtime.resources`).",
    ],
    example:
      '{ "waitForResource": { "id": "state", "path": "networkConnected", "equals": true }, "timeoutMs": 5000 }',
    importPath: "src/playtest-scenario.ts",
    packageName: "@threenative/playtest",
    signature:
      "step: { waitForResource: { id: string; path: string; equals?: unknown }; timeoutMs: number }",
    situations: [
      "wait in a playtest until a game resource reaches a value",
      "wait for the game to finish loading or connecting before asserting",
      "wait for a score, a wave or a state flag in a playtest scenario",
    ],
    summary:
      "A playtest scenario step that advances the game until a resource path matches, instead of a fixed tick count.",
    symbol: "waitForResource",
  }),
  tool({
    constraints: [
      "It also drops latched presses, pointer buttons and gamepad claims, so call it on a pause, a focus loss or a scene change, not every frame.",
    ],
    example: "window.addEventListener('blur', () => input.clear());",
    importPath: "src/input.ts",
    packageName: "@threenative/core",
    signature: "InputMap.clear(): void",
    situations: [
      "release every held key when the window loses focus",
      "stop a character running on after pausing or opening a menu",
      "reset the input state between levels",
    ],
    summary: "Forget every held key, pointer button, edge and pad claim on one InputMap.",
    symbol: "InputMap.clear",
  }),
  tool({
    constraints: [
      "On by default in the shared look and off in the low quality tier; read `TN_FRAME_BUDGET` before leaving it on for a phone.",
    ],
    example: "new WorldEnvironment({ localExposureEnabled: true })",
    importPath: "src/look/world-environment.ts",
    packageName: "@threenative/core",
    signature: "IWorldEnvironmentOptions.localExposureEnabled?: boolean",
    situations: [
      "keep a bright sky and a dark interior both readable in one frame",
      "lift shadows and tame highlights locally, like Unreal's local exposure",
      "turn off the local exposure pass for a cheaper frame",
    ],
    summary:
      "Unreal-style local exposure (a bilateral grid) in the world environment's tone chain.",
    symbol: "localExposureEnabled",
  }),
  tool({
    constraints: [
      "Optional on a backend: a missing method means no narrow-phase access, so fail closed.",
      "One PHYSICS_CONTACT_STRIDE record per manifold; a return larger than the buffer means grow it and read again before the next step.",
    ],
    example: "const count = sim.readContacts?.(targetCollider, candidateColliders, buffer);",
    importPath: "src/simulation.ts",
    packageName: "@threenative/physics",
    signature:
      "IPhysicsSimulation.readContacts?(target, colliders: Uint32Array, buffer: Float32Array): number",
    situations: [
      "read the persistent contact points, normals and load between two colliders",
      "tell whether a body is supported by the floor or a platform this step",
      "feed a deformation or footstep system from solved contacts instead of collision events",
    ],
    summary:
      "Persistent solved contacts of one collider against a candidate set, written into a Float32Array.",
    symbol: "readContacts",
  }),
];
