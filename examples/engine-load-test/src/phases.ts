// PRD-573 v1.11 frame-phase telemetry: where one arm's frame CPU goes. The bench turns it on (`phases` in the
// build config, which `--pair` sets), so a shipped game never imports this and pays nothing. It imports no
// framework code, because the plain-Three control arm shares `game.ts` and must keep its graph framework-free.
//
// One clock in both arms: `__tnThreadCpuMs`, the thread CPU time (CLOCK_THREAD_CPUTIME_ID) both native hosts
// install, the clock `presentCpuMs` and `threadCpuMs` are read on. A phase is exclusive: opening a nested
// phase pauses its parent, so the phases never double count and their sum is the frame's JS-side work.

/** The phases the page measures, in report order. The runner adds `present` and `other` from the host's frame line. */
export const PHASES = ["game", "animation", "matrixWorld", "projection", "render"] as const;
export type Phase = (typeof PHASES)[number];

/** Phase ids for the hot path: an index, so a call site never builds a string. */
export const PHASE = { game: 0, animation: 1, matrixWorld: 2, projection: 3, render: 4 } as const;

export interface IPhaseRecorder {
  /** Opens a phase; the phase that was open is paused until this one ends. */
  begin(id: number): void;
  /** Closes the innermost phase and resumes its parent. */
  end(): void;
  /** The ms each phase took since the last take, in `PHASES` order, and zeroes them. Throws while a phase is open. */
  take(): number[];
}

export function createPhaseRecorder(clock: () => number): IPhaseRecorder {
  const total = new Float64Array(PHASES.length);
  const parents: number[] = [];
  let open = -1;
  let mark = 0;
  return {
    begin(id) {
      const now = clock();
      if (open >= 0) total[open] = (total[open] as number) + (now - mark);
      parents.push(open);
      open = id;
      mark = now;
    },
    end() {
      if (open < 0) throw new Error("TN_BENCH_PHASE_UNOPENED: end() with no phase open");
      const now = clock();
      total[open] = (total[open] as number) + (now - mark);
      open = parents.pop() ?? -1;
      mark = now;
    },
    take() {
      if (open >= 0) throw new Error(`TN_BENCH_PHASE_OPEN: ${PHASES[open]} is still open`);
      const out = Array.from(total);
      total.fill(0);
      return out;
    },
  };
}

/** The host's thread CPU clock in ms; fails closed when the host does not install it, so a run never mixes clocks. */
export function threadCpuClock(): () => number {
  const read = (globalThis as { __tnThreadCpuMs?: () => number }).__tnThreadCpuMs;
  if (typeof read !== "function")
    throw new Error("TN_BENCH_PHASES_NO_CLOCK: the host installs no __tnThreadCpuMs");
  if (!(read() >= 0))
    throw new Error("TN_BENCH_PHASES_NO_CLOCK: __tnThreadCpuMs has no thread CPU clock here");
  return read;
}

/** The engine player's live crossing counts by name (`TN_PLAYER_CROSSINGS=1`); undefined on the legacy host or flag off. */
export function crossingReader(): (() => Record<string, number>) | undefined {
  const read = (globalThis as { __tnCrossingHistogram?: () => string }).__tnCrossingHistogram;
  return typeof read === "function"
    ? () => JSON.parse(read()) as Record<string, number>
    : undefined;
}

/** The `limit` names crossed most between two snapshots, as crossings per frame. */
export function topCrossings(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
  frames: number,
  limit = 5,
): Array<[string, number]> {
  return Object.entries(after)
    .map(([name, count]): [string, number] => [
      name,
      Math.round(((count - (before[name] ?? 0)) / frames) * 100) / 100,
    ])
    .filter(([, perFrame]) => perFrame > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}
