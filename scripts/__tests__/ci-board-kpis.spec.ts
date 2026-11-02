import { describe, expect, it } from "vitest";
const { releaseLead, releaseLeadTimes, summarizeBoards } = await import(
  new URL("../ci-board-kpis.mjs", import.meta.url).href
);

const T = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
const job = (
  name: string,
  conclusion: string,
  created: number,
  started: number,
  completed: number,
  steps?: unknown[],
) => ({
  name,
  conclusion,
  createdAt: T(created),
  startedAt: T(started),
  completedAt: T(completed),
  steps,
});
/** Pads a board past the full-board size with 58 one-minute green jobs. */
const filler = Array.from({ length: 58 }, (_, i) => job(`leg-${i}`, "success", 0, 0, 1));
const board = (sha: string, conclusion: string, jobs: unknown[]) => ({
  sha,
  conclusion,
  createdAt: T(0),
  jobs: [...filler, ...jobs],
});
const window = { since: T(0), until: T(60 * 24 * 7) };

describe("summarizeBoards", () => {
  it("reads wall, longest leg, machine minutes and queue from a full board", () => {
    const s = summarizeBoards({
      ...window,
      runs: [
        board("a", "success", [job("android", "success", 0, 10, 50), job("t", "success", 0, 0, 2)]),
      ],
    });
    expect(s.fullBoardWallMedianMin).toBe(50);
    expect(s.longestLegMedianMin).toBe(40);
    expect(s.fullBoardMachineMedianMin).toBe(100);
    expect(s.machineMinPerWeek).toBe(100);
    expect(s.boardGreenFirstPct).toBe(100);
  });

  it("keeps a thin lane out of the board numbers and in the weekly minutes", () => {
    const s = summarizeBoards({
      ...window,
      runs: [
        {
          sha: "a",
          conclusion: "success",
          createdAt: T(0),
          jobs: [job("scope", "success", 0, 0, 5)],
        },
      ],
    });
    expect(s.fullBoards).toBe(0);
    expect(s.fullBoardWallMedianMin).toBeNull();
    expect(s.boardGreenFirstPct).toBeNull();
    expect(s.machineMinPerWeek).toBe(5);
  });

  it("counts a flake only when one leg goes red and green on the same commit", () => {
    const s = summarizeBoards({
      ...window,
      runs: [
        board("a", "failure", [job("parity", "failure", 0, 0, 1), job("real", "failure", 0, 0, 1)]),
        board("a", "failure", [job("parity", "success", 0, 0, 1), job("real", "failure", 0, 0, 1)]),
        board("b", "failure", [job("other-commit", "failure", 0, 0, 1)]),
      ],
    });
    expect(s.flakeRatePct).toBe(50);
  });

  it("does not count a verdict job as a flake", () => {
    const s = summarizeBoards({
      ...window,
      runs: [
        board("a", "failure", [
          job("ci-required", "failure", 0, 0, 1),
          job("x", "failure", 0, 0, 1),
        ]),
        board("a", "success", [
          job("ci-required", "success", 0, 0, 1),
          job("x", "failure", 0, 0, 1),
        ]),
      ],
    });
    expect(s.flakeRatePct).toBe(0);
  });

  it("charges the minutes after the first red, and only the part after it", () => {
    const s = summarizeBoards({
      ...window,
      runs: [
        {
          sha: "a",
          conclusion: "failure",
          createdAt: T(0),
          jobs: [
            ...Array.from({ length: 58 }, (_, i) => job(`leg-${i}`, "success", 0, 0, 0)),
            job("red", "failure", 0, 0, 10),
            job("late", "success", 0, 0, 30),
          ],
        },
      ],
    });
    expect(s.minutesAfterFirstRedPct).toBe(50);
  });

  it("shares only the minutes of runs that end green", () => {
    const s = summarizeBoards({
      ...window,
      runs: [
        { sha: "a", conclusion: "success", createdAt: T(0), jobs: [job("a", "success", 0, 0, 10)] },
        {
          sha: "b",
          conclusion: "cancelled",
          createdAt: T(0),
          jobs: [job("b", "cancelled", 0, 0, 30)],
        },
      ],
    });
    expect(s.greenMinutesPct).toBe(25);
  });

  it("reads setup share from steps and returns null without steps", () => {
    const step = (name: string, a: number, b: number) => ({
      name,
      startedAt: T(a),
      completedAt: T(b),
    });
    const withSteps = summarizeBoards({
      ...window,
      runs: [
        board("a", "success", [
          job("no-steps", "success", 0, 0, 1),
          job("t", "success", 0, 0, 10, [
            step("Run actions/checkout@v4", 0, 1),
            step("pnpm install", 1, 3),
            step("Run the scenarios", 3, 10),
          ]),
        ]),
      ],
    });
    expect(withSteps.setupSharePct).toBe(30);
    const withoutSteps = summarizeBoards({
      ...window,
      runs: [board("a", "success", [job("x", "success", 0, 0, 1), job("y", "success", 0, 0, 1)])],
    });
    expect(withoutSteps.fullBoards).toBe(1);
    expect(withoutSteps.setupSharePct).toBeNull();
  });

  it("counts a real board's work steps as work, whatever words they contain", () => {
    const work = [
      "Verify the relocated release container with the installed verifier",
      "Launch the relocated container with no developer toolchain",
      "Run sh scripts/xvfb.sh pnpm test:browser:ci",
      "Install and play the final signed Windows setup, then uninstall it",
    ];
    const setup = [
      "Set up job",
      "Run actions/checkout@v7",
      "Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "Run pnpm install --frozen-lockfile",
      "Install Linux desktop build dependencies and ccache",
      "Run ./.github/actions/native-rust-cache",
      "Restore native third-party dependencies",
      "Post Run actions/checkout@v7",
    ];
    const steps = [...work, ...setup].map((name, index) => ({
      name,
      startedAt: T(index),
      completedAt: T(index + 1),
    }));
    const s = summarizeBoards({
      ...window,
      runs: [
        board("a", "success", [
          job("no-steps", "success", 0, 0, 1),
          job("t", "success", 0, 0, 12, steps),
        ]),
      ],
    });
    expect(s.setupSharePct).toBe(66.7);
  });
});

describe("releaseLead", () => {
  const publishes = [{ version: "1.0.0", at: T(100) }];

  it("reports a promotion that has not reached npm yet, so a stalled release cannot look fast", () => {
    expect(
      releaseLead({
        publishes,
        promotions: [{ createdAt: T(50) }, { createdAt: T(200) }],
        since: T(0),
        until: T(1000),
      }),
    ).toEqual({ releaseLeadMin: 800, releaseLeadVersion: "in flight" });
  });

  it("reads the newest publish when no promotion is open", () => {
    expect(
      releaseLead({ publishes, promotions: [{ createdAt: T(50) }], since: T(0), until: T(1000) }),
    ).toEqual({ releaseLeadMin: 50, releaseLeadVersion: "1.0.0" });
  });

  it("is unknown when nothing fell in the window", () => {
    expect(
      releaseLead({ publishes, promotions: [{ createdAt: T(50) }], since: T(500), until: T(1000) }),
    ).toEqual({ releaseLeadMin: null, releaseLeadVersion: null });
  });
});

describe("releaseLeadTimes", () => {
  it("starts at the first promotion after the previous publish, so failed promotions count", () => {
    const leads = releaseLeadTimes({
      publishes: [
        { version: "1.0.0", at: T(100) },
        { version: "1.0.1", at: T(1000) },
      ],
      promotions: [{ createdAt: T(50) }, { createdAt: T(200) }, { createdAt: T(800) }],
    });
    expect(leads).toEqual([
      { version: "1.0.0", at: T(100), leadMin: 50 },
      { version: "1.0.1", at: T(1000), leadMin: 800 },
    ]);
  });

  it("skips a publish that no promotion opened", () => {
    const leads = releaseLeadTimes({
      publishes: [{ version: "1.0.0", at: T(100) }],
      promotions: [{ createdAt: T(200) }],
    });
    expect(leads).toEqual([]);
  });
});
