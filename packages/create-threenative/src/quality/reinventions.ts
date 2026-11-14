import type { Linter } from "eslint";

/**
 * The hand-written forms of a capability the engine already ships, one row each.
 *
 * Every row is a `no-restricted-syntax` selector, so the rule that rejects them is ESLint's own
 * and this file is data. The three newest games rebuilt `MatrixWorldPass`, `InputMap` axes and
 * `createRandom` by hand because the author never saw them, about 350 lines of shipped capability
 * written again; the lint runs in every generated game, so it is the cheapest place to say the
 * name. `__tests__/quality-rules.spec.ts` proves each row fails a fixture, passes the fixed form,
 * and that its `capability` still resolves in the manifest (or in `three`) — a message cannot name
 * a symbol that was removed.
 */
export interface IReinvention {
  /** What the error says, naming the engine call and where it comes from. */
  readonly message: string;
  /** The symbol the message names; the spec proves it still exists. */
  readonly capability: string;
  /** Where the named symbol lives: a core export, or a `MathUtils` member from `three`. */
  readonly source: "core" | "three";
  /** The selector where the named call replaces the hand-written form. */
  readonly selector: string;
  /** Project paths where the hand-written form is the content, not a reinvention. */
  readonly outside?: readonly string[];
}

/**
 * Where a hand-written PRNG is the content, not a reinvention of the engine's seeded stream.
 *
 * `src/render/` stays plain Three.js by rule: a kit's render sources may not import a core
 * symbol that is not in `RENDER_PORTABLE_CORE_SYMBOLS` (`scripts/check-core-boundary.ts`), and
 * their noise and placement streams are authored against those exact numbers — a different
 * generator draws different clouds. Audio synthesis and UI animation likewise keep the platform
 * RNG. A level, an entity or a scene uses `createRandom`.
 */
export const PRNG_OUTSIDE = ["src/audio.ts", "src/audio/**", "src/render/**", "src/ui/**"] as const;

export const REINVENTIONS: readonly IReinvention[] = [
  {
    selector:
      ':matches(CallExpression[callee.object.name="Math"][callee.property.name="random"], Literal[value=1664525], Literal[value=1013904223], Literal[value=1831565813])',
    capability: "createRandom",
    source: "core",
    outside: PRNG_OUTSIDE,
    message:
      "A hand-written PRNG (Math.random or the LCG constants) is a capability the engine ships: use `createRandom(seed)` from `@threenative/core`, or `ctx.random`, so the same seed replays the same game.",
  },
  {
    selector:
      'BinaryExpression[operator="-"][left.value=1][right.callee.object.name="Math"][right.callee.property.name="exp"]',
    capability: "MathUtils.damp",
    source: "three",
    message:
      "`1 - Math.exp(-…)` is a damp factor the engine ships: use `MathUtils.damp(current, target, rate, dt)` from `three`, which is the same curve with the rate named.",
  },
  {
    selector:
      ':matches(MemberExpression[object.name="location"][property.name="search"], MemberExpression[object.property.name="location"][property.name="search"])',
    capability: "debugFlag",
    source: "core",
    message:
      "Reading `location.search` by hand is a launch seam the engine owns: use `debugFlag(name)` or `debugValue(name)` from `@threenative/core` (`?name` on web, `TN_DEBUG_NAME` on native).",
  },
  {
    selector: 'AssignmentExpression[left.property.name="matrixWorldAutoUpdate"][right.value=false]',
    capability: "renderer.matrixWorld",
    source: "core",
    message:
      "Turning `matrixWorldAutoUpdate` off by hand is the engine's own walk: set `renderer.matrixWorld` in the game config for a whole scene, or `markStatic(node)` for one node that never moves.",
  },
  {
    selector:
      'BinaryExpression[operator="-"][left.type="ConditionalExpression"][left.consequent.value=1][left.alternate.value=0][right.type="ConditionalExpression"][right.consequent.value=1][right.alternate.value=0]',
    capability: "InputMap.axis",
    source: "core",
    message:
      "An axis built from raw keys is a binding the engine already reads: declare it in `defineGame({ input })` and use `ctx.input.axis(name)` from `@threenative/core`.",
  },
  {
    selector:
      'BinaryExpression[operator="*"][right.type="BinaryExpression"][right.operator="-"][right.left.value=3][right.right.type="BinaryExpression"][right.right.operator="*"][right.right.left.value=2]',
    capability: "MathUtils.smoothstep",
    source: "three",
    message:
      "`x * x * (3 - 2 * x)` is the engine's smoothstep: use `MathUtils.smoothstep(x, 0, 1)` from `three`, which clamps the same way.",
  },
];

/** The `no-restricted-syntax` entries for one group of rows. */
export function reinventionRules(rows: readonly IReinvention[]): Linter.RulesRecord {
  return {
    "no-restricted-syntax": [
      "error",
      ...rows.map(({ selector, message }) => ({ selector, message })),
    ],
  };
}

/**
 * The two config objects the rows need: every row everywhere, and the rows a project path excludes
 * on top. Later objects win a rule for a file both match, so the wider list comes last.
 */
export function reinventionConfigs(files: readonly string[]): Linter.Config[] {
  const always = REINVENTIONS.filter((row) => row.outside === undefined);
  const ignores = [...new Set(REINVENTIONS.flatMap((row) => row.outside ?? []))];
  return [
    { files: [...files], rules: reinventionRules(always) },
    { files: [...files], ignores, rules: reinventionRules(REINVENTIONS) },
  ];
}
