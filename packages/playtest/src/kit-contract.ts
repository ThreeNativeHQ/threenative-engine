/**
 * The kit contract (PRD-749): behaviours every starter kit must keep, checked by what a player sees.
 *
 * A bug found in one kit becomes one row here, and `pnpm test:templates` then reports every kit that
 * has it in one run. Kits stay flexible: the contract is a test, not a runtime dependency, and every
 * row has a per-kit opt-out that needs a written reason. A row a kit neither declares nor opts out of
 * fails closed, because "nobody checked" must never read as "fine".
 *
 * Kept out of the package exports on purpose: the sweep (`scripts/verify-template-playtests.ts`)
 * imports it from source, and a generated game never ships it.
 */

type Json = Record<string, unknown>;

/** What a kit tells the contract about itself. Everything is player-facing: keys, node names, clips. */
export interface IKitContractEntry {
  /** Keys that start a scripted attack-like action and the clip the player must see play to its end. */
  readonly actions?: readonly IKitContractAction[];
  /** Extra keys the seeded explorer may press (attack, dodge, interact). */
  readonly explore?: { readonly actions?: readonly string[]; readonly pointer?: boolean; readonly seed?: number };
  /** Object3D names of the soles, for the planted-foot bound. */
  readonly feet?: readonly string[];
  /** Keys that move the subject. */
  readonly move: readonly string[];
  /** Row id to the written reason this kit does not follow it. */
  readonly optOut?: Readonly<Record<string, string>>;
  /** Pressing `key` after play puts these resources back. */
  readonly restart?: { readonly key: string; readonly resets: readonly IKitContractReset[] };
  /** Entity id the camera follows and the stride rows measure. */
  readonly subject: string;
  /** Steps that leave a menu or title and start play (default: none, the kit starts in play). */
  readonly start?: readonly Json[];
}

export interface IKitContractAction {
  /** Ticks to wait before the effect: the clip's contact window opens here. */
  readonly contactTicks?: number;
  readonly clip: string;
  /** Signal (a `signals` assertion name) the subject emits when the hit lands: none before `contactTicks`, one after. */
  readonly effect?: { readonly signal: string };
  readonly key: string;
  /** Ticks the clip lasts at normal speed. */
  readonly ticks: number;
}

export interface IKitContractReset {
  /** Exact value after the restart settles. Use `lte` for a clock or counter that keeps running during the settle window. */
  readonly equals?: unknown;
  readonly id: string;
  /** Upper bound after the restart settles: far below the dirty run's value, above one settle window of a running clock. */
  readonly lte?: number;
  readonly path: string;
}

export interface IKitContractRow {
  readonly id: string;
  /** What a player would notice when the row fails. */
  readonly summary: string;
  /** The entry fields the row reads; a kit without them must opt out. */
  readonly needs: (entry: IKitContractEntry) => boolean;
  readonly build: (entry: IKitContractEntry) => Json;
}

const DIAGNOSTICS = { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true, runtimeReady: true };
const VIEWPORT = { height: 720, width: 1280 };

function scenario(row: string, entry: IKitContractEntry, steps: readonly Json[], assert: Json): Json {
  return {
    assert,
    name: `contract-${row}`,
    schemaVersion: 1,
    steps: [...(entry.start ?? []), ...steps],
    subject: entry.subject,
    target: "web",
    viewport: VIEWPORT,
    warmupFrames: 10,
  };
}

function explore(entry: IKitContractEntry, ticks: number, label: string): Json {
  return {
    kind: "explore",
    label,
    move: [...entry.move],
    ticks,
    seed: entry.explore?.seed ?? 1,
    ...(entry.explore?.actions === undefined ? {} : { actions: [...entry.explore.actions] }),
    ...(entry.explore?.pointer === true ? { pointer: true } : {}),
  };
}

/** Rows with nothing to declare apply to every kit. */
const always = () => true;

export const KIT_CONTRACT_ROWS: readonly IKitContractRow[] = [
  {
    build: (entry) =>
      scenario("explore-clean", entry, [explore(entry, 1800, "explored")], {
        diagnostics: DIAGNOSTICS,
        movement: { entity: entry.subject, minDistance: 1 },
        visual: [{ region: { height: 540, minSharpness: 0.3, width: 960, x: 160, y: 90 } }],
      }),
    id: "explore-clean",
    needs: always,
    summary: "thirty seconds of seeded play moves the subject, logs no error and ends on a sharp frame",
  },
  {
    build: (entry) =>
      scenario("camera-sees-subject", entry, [explore(entry, 1800, "explored")], {
        diagnostics: DIAGNOSTICS,
        sightLine: { entity: entry.subject, maxBlockedRatio: 0.02 },
      }),
    id: "camera-sees-subject",
    needs: always,
    summary: "the camera never sits behind a wall or inside the player: nothing solid stands between the lens and the subject",
  },
  {
    build: (entry) =>
      scenario("hud-clean", entry, [explore(entry, 600, "played")], {
        diagnostics: DIAGNOSTICS,
        hudAudit: { minContrast: 3, noDebugText: true },
      }),
    id: "hud-clean",
    needs: always,
    summary: "no developer text or unreadable colours reach the player's HUD",
  },
  {
    build: (entry) =>
      scenario("no-hitch", entry, [explore(entry, 1200, "played")], {
        diagnostics: DIAGNOSTICS,
        // Unset, the p95 frame budget is the 16.7 ms default of PRD-735; PRD-748 adds the hitch count here.
        performance: { maxDrawCalls: 2000 },
      }),
    id: "no-hitch",
    needs: always,
    summary: "play holds the frame budget with no spike",
  },
  {
    build: (entry) =>
      scenario(
        "foot-slip",
        entry,
        [
          { holdTicks: 30, kind: "input", label: "accelerate", press: entry.move[0], release: false },
          { holdTicks: 90, kind: "input", label: "run", press: entry.move[0], release: true },
        ],
        {
          diagnostics: DIAGNOSTICS,
          footSlip: [{ atStep: "run", feet: [...(entry.feet ?? [])], maxSlideSpeed: 1, maxSlip: 0.35 }],
        },
      ),
    id: "foot-slip",
    needs: (entry) => entry.feet !== undefined && entry.feet.length > 0,
    summary: "planted feet do not skate: legs cycle at the ground speed",
  },
  {
    build: (entry) =>
      scenario(
        "restart-resets",
        entry,
        [
          { holdTicks: 120, kind: "input", label: "dirty", press: entry.move[0], release: true },
          { holdTicks: 1, kind: "input", label: "restarted", press: entry.restart!.key, release: true },
          { kind: "wait", label: "settled", release: true, waitTicks: 30 },
        ],
        {
          diagnostics: DIAGNOSTICS,
          resources: entry.restart!.resets.map(({ equals, id, lte, path }) => ({
            atSteps: [{ ...(equals === undefined ? {} : { equals }), ...(lte === undefined ? {} : { lte }), label: "settled" }],
            id,
            path,
          })),
        },
      ),
    id: "restart-resets",
    needs: (entry) => entry.restart !== undefined,
    summary: "retry puts the run back at its start, with nothing carried over",
  },
  {
    build: (entry) =>
      scenario(
        "action-clip-completes",
        entry,
        entry.actions!.flatMap((action) => [
          { holdTicks: 1, kind: "input", label: `${action.clip}-start`, press: action.key, release: true },
          { kind: "wait", label: `${action.clip}-end`, release: true, waitTicks: action.ticks + 6 },
        ]),
        {
          animation: entry.actions!.map((action) => ({ clip: action.clip, entered: true, entity: entry.subject, finished: true })),
          diagnostics: DIAGNOSTICS,
        },
      ),
    id: "action-clip-completes",
    needs: (entry) => entry.actions !== undefined && entry.actions.length > 0,
    summary: "an attack or roll plays its whole clip, not the first half",
  },
  {
    build: (entry) => {
      const hits = entry.actions!.filter((action) => action.effect !== undefined && action.contactTicks !== undefined);
      return scenario(
        "effect-follows-contact",
        entry,
        hits.flatMap((action) => [
          { holdTicks: 1, kind: "input", label: `${action.clip}-swung`, press: action.key, release: true },
          { kind: "wait", label: `${action.clip}-before-contact`, release: true, waitTicks: Math.max(1, action.contactTicks! - 4) },
          { kind: "wait", label: `${action.clip}-after-contact`, release: true, waitTicks: 8 },
          { kind: "wait", label: `${action.clip}-recovered`, release: true, waitTicks: Math.max(1, action.ticks) },
        ]),
        {
          diagnostics: DIAGNOSTICS,
          signals: hits.flatMap((action) => [
            { atStep: `${action.clip}-before-contact`, entity: entry.subject, maxCount: 0, name: action.effect!.signal },
            { atStep: `${action.clip}-after-contact`, entity: entry.subject, minCount: 1, name: action.effect!.signal },
          ]),
        },
      );
    },
    id: "effect-follows-contact",
    needs: (entry) => entry.actions?.some((action) => action.effect !== undefined && action.contactTicks !== undefined) === true,
    summary: "a hit lands when the blade arrives, not before the swing",
  },
];

export const KIT_CONTRACT_ROW_IDS: readonly string[] = KIT_CONTRACT_ROWS.map(({ id }) => id);

export type KitContractVerdict =
  | { readonly kind: "run"; readonly kit: string; readonly row: string; readonly scenario: Json }
  | { readonly kind: "opt-out"; readonly kit: string; readonly reason: string; readonly row: string };

/**
 * Turns the declarations into the runs of a sweep. It throws for every way a kit could dodge a row
 * quietly: an unknown row id, an opt-out with no reason, an opt-out for a row the kit declares in
 * full (stale), or a row the kit neither declares nor opts out of.
 */
export function planKitContract(
  entries: Readonly<Record<string, IKitContractEntry>>,
  kits: readonly string[],
  rows: readonly IKitContractRow[] = KIT_CONTRACT_ROWS,
): readonly KitContractVerdict[] {
  const known = new Set(rows.map(({ id }) => id));
  const verdicts: KitContractVerdict[] = [];
  for (const kit of kits) {
    const entry = entries[kit];
    if (entry === undefined) throw new Error(`TN_KIT_CONTRACT_KIT_UNDECLARED: ${kit} has no entry in the kit contract.`);
    for (const [row, reason] of Object.entries(entry.optOut ?? {})) {
      if (!known.has(row)) throw new Error(`TN_KIT_CONTRACT_UNKNOWN_ROW: ${kit} opts out of '${row}', which is not a contract row.`);
      if (reason.trim().length < 12)
        throw new Error(`TN_KIT_CONTRACT_OPT_OUT_REASON: ${kit} opts out of '${row}' without a written reason.`);
    }
    for (const row of rows) {
      const reason = entry.optOut?.[row.id];
      if (reason !== undefined) {
        // A row every kit runs (`needs: always`) has no declaration to go stale.
        if (row.needs !== always && row.needs(entry))
          throw new Error(`TN_KIT_CONTRACT_STALE_OPT_OUT: ${kit} opts out of '${row.id}' but declares everything the row needs; delete the opt-out or the declaration.`);
        verdicts.push({ kind: "opt-out", kit, reason, row: row.id });
        continue;
      }
      if (!row.needs(entry))
        throw new Error(`TN_KIT_CONTRACT_UNDECLARED: ${kit} neither declares what '${row.id}' reads nor opts out of it with a reason.`);
      verdicts.push({ kind: "run", kit, row: row.id, scenario: row.build(entry) });
    }
  }
  return verdicts;
}
