/**
 * The UI-frame gate must judge a window a p95 can be read from, not the partial tail of a run.
 *
 * CI run 41129808033 failed `native:verify:ui-frame` with
 * `TN_FRAME_BUDGET_PHASE_OVER_BUDGET: the 'ui' phase is 3.13 ms at p95 over 11 frame(s)` on a tree
 * whose pull-request run passed. `Ring.summarize` ranks a percentile at `ceil(fraction * samples)`,
 * so an 11-sample window's p95 *is* its worst frame — one slow frame on a shared runner reds the
 * job. The verifier judged only the last window, and where the last window starts is the runner's
 * own pace, not the game's.
 *
 * These cases feed it windows by hand: the pooled steady-state windows are the measurement, a run
 * that never carried enough samples to have a p95 is refused by name, and the 2 ms bound PRD-393
 * AC-6 accepted is still the bound.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error -- the desktop verifier is plain ESM with no type declarations.
import { requireUiPhase } from "../scripts/verify-desktop-ui-frame.mjs";

interface IUiWindow {
  readonly p95: number;
  readonly samples: number;
}

/** One `TN_FRAME_BUDGET` console line, carrying only the `ui` phase these cases are about. */
function consoleLines(windows: readonly IUiWindow[]): string[] {
  return windows.map(
    ({ p95, samples }, index) =>
      `[host] TN_FRAME_BUDGET:${JSON.stringify({
        phases: { ui: { max: p95, mean: p95 / 2, p50: p95 / 2, p95, p99: p95, samples } },
        window: index,
      })}`,
  );
}

describe("requireUiPhase", () => {
  it("judges the steady-state window, not the 11-frame partial tail", () => {
    // The shape CI run 41129808033 reported: the run's last boundary fell 11 frames before the run
    // ended, and one of those 11 frames was the attach upload.
    const phase = requireUiPhase(
      consoleLines([
        { p95: 0.2, samples: 400 },
        { p95: 0.4, samples: 300 },
        { p95: 3.13, samples: 11 },
      ]),
    );
    expect(phase.p95).toBe(0.4);
    expect(phase.samples).toBe(300);
    expect(phase.windows).toBe(1);
    expect(phase.skipped).toBe(1);
    expect(phase.boundMs).toBe(2);
  });

  it("refuses a run with no window big enough for a p95, naming the count", () => {
    const lines = consoleLines([
      { p95: 0.2, samples: 400 },
      { p95: 0.3, samples: 40 },
      { p95: 0.3, samples: 40 },
      { p95: 0.3, samples: 40 },
    ]);
    expect(() => requireUiPhase(lines)).toThrow(/TN_FRAME_BUDGET_PHASE_UNDERSAMPLED/u);
    expect(() => requireUiPhase(lines)).toThrow(
      /measured 120 'ui' sample\(s\) over 3 steady-state window\(s\).*fullest carried 40/u,
    );
  });

  it("still fails a complete steady-state window over the 2 ms bound", () => {
    expect(() =>
      requireUiPhase(
        consoleLines([
          { p95: 0.2, samples: 400 },
          { p95: 2.4, samples: 300 },
        ]),
      ),
    ).toThrow(
      /TN_FRAME_BUDGET_PHASE_OVER_BUDGET: the 'ui' phase is 2\.4 ms at p95 over 300 frame\(s\)/u,
    );
  });

  it("still fails closed when the last window measured no ui sample at all", () => {
    expect(() =>
      requireUiPhase(
        consoleLines([
          { p95: 0.2, samples: 400 },
          { p95: 0, samples: 0 },
        ]),
      ),
    ).toThrow(/TN_FRAME_BUDGET_PHASE_EMPTY/u);
  });
});
