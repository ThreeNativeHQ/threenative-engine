import { describe, expect, it } from "vitest";
const { firstFailingJob, quantile, queuePrNumber, summarize } = await import(
  new URL("../ci-merge-latency.mjs", import.meta.url).href
);
const {
  GOALS,
  appendIteration,
  discardIteration,
  emptyLedger,
  isLive,
  meetsGoal,
  progressToward,
  renderHtml,
} = await import(new URL("../ci-speed-loop.mjs", import.meta.url).href);

const T = (minute: number) => new Date(Date.UTC(2026, 9, 9, 0, minute)).toISOString();

const window = summarize({
  prs: [
    { number: 1, title: "red then green", mergedAt: T(300), lastCommitAt: T(0) },
    { number: 2, title: "straight through", mergedAt: T(120), lastCommitAt: T(100) },
    { number: 3, title: "direct merge, no queue", mergedAt: T(50), lastCommitAt: T(40) },
  ],
  runs: [
    {
      id: 10,
      headBranch: "gh-readonly-queue/develop/pr-1-aaa",
      createdAt: T(10),
      updatedAt: T(80),
      conclusion: "failure",
    },
    {
      id: 11,
      headBranch: "gh-readonly-queue/develop/pr-1-bbb",
      createdAt: T(200),
      updatedAt: T(280),
      conclusion: "success",
    },
    {
      id: 12,
      headBranch: "gh-readonly-queue/develop/pr-2-ccc",
      createdAt: T(105),
      updatedAt: T(115),
      conclusion: "success",
    },
    {
      id: 13,
      headBranch: "refs/heads/not-a-queue-branch",
      createdAt: T(1),
      updatedAt: T(2),
      conclusion: "success",
    },
  ],
  jobsByRun: {
    10: [
      {
        name: "ci-required",
        conclusion: "failure",
        createdAt: T(79),
        startedAt: T(79),
        completedAt: T(80),
      },
      {
        name: "integration / auto-exposure",
        conclusion: "failure",
        createdAt: T(20),
        startedAt: T(30),
        completedAt: T(60),
      },
      {
        name: "native-platforms",
        conclusion: "skipped",
        createdAt: T(20),
        startedAt: null,
        completedAt: T(20),
      },
    ],
    12: [
      {
        name: "test",
        conclusion: "success",
        createdAt: T(105),
        startedAt: T(107),
        completedAt: T(110),
      },
    ],
  },
});

describe("ci-merge-latency", () => {
  it("interpolates quantiles and ignores non-finite values", () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([null as unknown as number, 5], 0.9)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("reads the PR number from a merge-queue branch only", () => {
    expect(queuePrNumber("gh-readonly-queue/develop/pr-461-1a2b")).toBe(461);
    expect(queuePrNumber("feature/pr-461-x")).toBeNull();
    expect(queuePrNumber(undefined)).toBeNull();
  });

  it("names the earliest failing job, never the join that finishes last", () => {
    expect(
      firstFailingJob([
        { name: "ci-required", conclusion: "failure", completedAt: T(80) },
        { name: "test-unit (1/4)", conclusion: "failure", completedAt: T(40) },
      ]),
    ).toBe("test-unit (1/4)");
    expect(firstFailingJob([{ name: "x", conclusion: "success", completedAt: T(1) }])).toBeNull();
  });

  it("measures push to merge, enqueue to merge, attempts and the first attempt per PR", () => {
    const [one, two, three] = window.prs;
    expect(one).toMatchObject({
      lastPushToMergeMin: 300,
      enqueueToMergeMin: 290,
      attempts: 2,
      firstAttempt: "failure",
      firstFailingJob: "integration / auto-exposure",
    });
    expect(two).toMatchObject({
      lastPushToMergeMin: 20,
      enqueueToMergeMin: 15,
      attempts: 1,
      firstAttempt: "success",
      firstFailingJob: null,
    });
    // No queue run: unknown, never 0.
    expect(three).toMatchObject({ attempts: 0, firstAttempt: null, enqueueToMergeMin: null });
  });

  it("summarizes the window", () => {
    expect(window.summary).toMatchObject({
      prCount: 3,
      lastPushToMergeMedianMin: 20,
      firstAttemptSuccessPct: 50,
      mergeGroupRuns: 3,
      mergeGroupRunSuccessPct: 66.7,
      boardWallMedianMin: 45,
    });
    // Skipped jobs never started, so they are not queue wait.
    expect(window.summary.queueWaitJobs).toBe(3);
    expect(window.firstFailingJobs).toEqual([{ job: "integration / auto-exposure", count: 1 }]);
  });

  it("returns null, not 0, for an empty window", () => {
    const empty = summarize({ prs: [], runs: [] });
    expect(empty.summary.lastPushToMergeMedianMin).toBeNull();
    expect(empty.summary.firstAttemptSuccessPct).toBeNull();
    expect(empty.summary.queueWaitP90Min).toBeNull();
  });
});

const measurement = (overrides: Record<string, number | null> = {}) => ({
  since: "2026-10-09",
  base: "develop",
  at: "2026-10-09T12:00:00.000Z",
  ...window,
  summary: { ...window.summary, ...overrides },
});

describe("ci-speed-loop ledger", () => {
  it("makes the first iteration the baseline and later ones provisional", () => {
    const first = appendIteration(emptyLedger(), { measurement: measurement(), label: "baseline" });
    const second = appendIteration(first, { measurement: measurement(), label: "gating board" });
    expect(second.iterations.map((i: { decision: string }) => i.decision)).toEqual([
      "baseline",
      "provisional",
    ]);
    expect(second.iterations.map((i: { id: number }) => i.id)).toEqual([1, 2]);
  });

  it("rejects an unknown decision and a discard without a reason", () => {
    expect(() =>
      appendIteration(emptyLedger(), { measurement: measurement(), label: "x", decision: "win" }),
    ).toThrow(/decision/u);
    const ledger = appendIteration(emptyLedger(), { measurement: measurement(), label: "x" });
    expect(() => discardIteration(ledger, 1, "")).toThrow(/reason/u);
    expect(() => discardIteration(ledger, 9, "why")).toThrow(/no iteration/u);
  });

  it("keeps a superseded iteration in history and out of the live set", () => {
    let ledger = appendIteration(emptyLedger(), {
      measurement: measurement({ lastPushToMergeMedianMin: 280 }),
      label: "baseline",
    });
    ledger = appendIteration(ledger, {
      measurement: measurement({ lastPushToMergeMedianMin: 5 }),
      label: "bad run",
    });
    ledger = discardIteration(ledger, 2, "queue outage, thin sample");
    expect(ledger.iterations).toHaveLength(2);
    expect(ledger.iterations.filter(isLive).map((i: { id: number }) => i.id)).toEqual([1]);
    const html = renderHtml(ledger);
    expect(html).toContain("superseded: queue outage, thin sample");
    expect(html).toContain("#2");
  });

  it("re-rendering after an append keeps every earlier iteration", () => {
    let ledger = appendIteration(emptyLedger(), {
      measurement: measurement(),
      label: "first change",
    });
    const before = renderHtml(ledger);
    ledger = appendIteration(ledger, { measurement: measurement(), label: "second change" });
    const after = renderHtml(ledger);
    expect(before).toContain("first change");
    expect(after).toContain("first change");
    expect(after).toContain("second change");
  });

  it("scores progress from the baseline to the goal for both directions", () => {
    const lower = GOALS[0];
    const higher = GOALS[2];
    expect(progressToward(lower, 280, 155)).toBeCloseTo(0.5, 1);
    expect(progressToward(lower, 280, 20)).toBe(1);
    expect(progressToward(lower, 280, 400)).toBe(0);
    expect(progressToward(higher, 30, 60)).toBeCloseTo(0.5, 1);
    expect(progressToward(lower, null, 20)).toBeNull();
    expect(meetsGoal(lower, 30)).toBe(true);
    expect(meetsGoal(higher, 89)).toBe(false);
    expect(meetsGoal(lower, null)).toBe(false);
  });
});

describe("ci-speed-loop dashboard", () => {
  it("says baseline pending for an empty ledger and draws every chart", () => {
    const html = renderHtml(emptyLedger());
    expect(html).toContain("Baseline pending");
    expect(html.match(/<svg /gu)).toHaveLength(GOALS.length);
    expect(html).not.toContain("<script");
  });

  it("escapes text from PR titles and labels", () => {
    const hostile = {
      ...measurement(),
      prs: [
        {
          number: 7,
          title: "<img src=x onerror=alert(1)>",
          lastPushToMergeMin: 1,
          enqueueToMergeMin: 1,
          attempts: 1,
          firstAttempt: "success",
          firstFailingJob: null,
        },
      ],
    };
    const html = renderHtml(
      appendIteration(emptyLedger(), { measurement: hostile, label: '"><script>1</script>' }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>1");
  });

  it("renders a missing value as n/a, never as 0", () => {
    const html = renderHtml(
      appendIteration(emptyLedger(), {
        measurement: measurement({ queueWaitP90Min: null }),
        label: "x",
      }),
    );
    expect(html).toContain("n/a");
    expect(html).not.toMatch(/Runner queue wait, p90<\/td><td>0 min/u);
  });

  it("keeps the latest window that merged a PR in the PR table", () => {
    const first = appendIteration(emptyLedger(), { measurement: measurement(), label: "baseline" });
    const html = renderHtml(
      appendIteration(first, {
        measurement: {
          ...measurement({ lastPushToMergeMedianMin: null }),
          prs: [],
          firstFailingJobs: [],
        },
        label: "no PR merged",
      }),
    );
    expect(html).toContain("red then green");
    expect(html).toContain("Merged PRs, iteration #1 window");
  });
});
